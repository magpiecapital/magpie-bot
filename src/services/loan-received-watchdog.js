/**
 * Loan actual-received watchdog — fills + verifies the
 * `actual_received_lamports` column on every borrow row.
 *
 * Two responsibilities
 * ──────────────────────
 *
 * 1. **Backfill**: for any loan with `actual_received_lamports IS NULL`
 *    AND `tx_signature IS NOT NULL`, read the tx, compute the
 *    borrower's true SOL credit (post-balance delta + signer tx fee),
 *    and UPDATE the column. Catches:
 *      - Historical rows (pre migration 048)
 *      - Rows where the write-time read in recordLoan() failed
 *        (RPC blip, tx still propagating at insert time)
 *
 * 2. **Drift verification**: for a sample of recent loans, re-read
 *    the on-chain delta and compare to the stored value. If they
 *    disagree beyond NETWORK_RENT_TOLERANCE, alert the operator —
 *    means the program changed account-creation costs, OR the row
 *    was written wrong, OR an on-chain compaction happened. This
 *    catches the EXACT class of bug the 2026-06-13 audit found.
 *
 * Why these are in one watchdog
 * ──────────────────────────────
 * Both jobs need to look up the same transactions and apply the same
 * delta math. Splitting them would duplicate the on-chain reads.
 *
 * Cadence
 * ───────
 * Default 5 min between cycles. Backfill batch size is small (10 per
 * cycle) so a large backlog drains gradually without slamming Helius.
 * Drift sample is 5 most-recent loans per cycle.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const RUN_INTERVAL_MS = Number(process.env.LOAN_RECEIVED_WATCHDOG_INTERVAL_MS) || 5 * 60_000;
const BACKFILL_BATCH = Number(process.env.LOAN_RECEIVED_BACKFILL_BATCH) || 10;
const DRIFT_SAMPLE = Number(process.env.LOAN_RECEIVED_DRIFT_SAMPLE) || 5;
const NETWORK_RENT_TOLERANCE_LAMPORTS = Number(process.env.LOAN_RECEIVED_TOLERANCE) || 50_000; // 0.00005 SOL
const RPC_GAP_MS = 500;
const FIRST_DELAY_MS = 3 * 60_000;

let _timer = null;
let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  }
  return _connection;
}

/** Read borrower's true SOL credit (post-balance delta + signer tx fee). */
async function computeActualReceived(conn, txSignature, borrowerWallet) {
  const tx = await conn.getTransaction(txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return null;
  const keys = tx.transaction.message.staticAccountKeys
    || tx.transaction.message.accountKeys
    || [];
  const borrowerPk = new PublicKey(borrowerWallet).toBase58();
  const bi = keys.findIndex((k) => (k.toBase58 ? k.toBase58() : String(k)) === borrowerPk);
  if (bi < 0) return null;
  const delta = BigInt(tx.meta.postBalances[bi]) - BigInt(tx.meta.preBalances[bi]);
  const txFee = BigInt(tx.meta.fee || 0);
  const credit = delta + txFee;
  return credit > 0n ? credit : null;
}

async function backfillCycle(bot) {
  const { rows } = await query(
    `SELECT id, tx_signature, borrower_wallet
       FROM loans
      WHERE actual_received_lamports IS NULL
        AND tx_signature IS NOT NULL
        AND borrower_wallet IS NOT NULL
      ORDER BY id DESC
      LIMIT $1`,
    [BACKFILL_BATCH],
  );
  if (rows.length === 0) return { backfilled: 0 };

  const conn = getConnection();
  let backfilled = 0;
  for (const l of rows) {
    try {
      const credit = await computeActualReceived(conn, l.tx_signature, l.borrower_wallet);
      if (credit != null) {
        await query(
          `UPDATE loans SET actual_received_lamports = $1 WHERE id = $2 AND actual_received_lamports IS NULL`,
          [credit.toString(), l.id],
        );
        backfilled++;
      }
    } catch (err) {
      // Skip — next cycle re-tries
      if (!/not found|missing|undefined/i.test(err.message || "")) {
        console.warn(`[loan-received-watchdog] backfill failed for loan ${l.id}: ${err.message?.slice(0, 80)}`);
      }
    }
    await new Promise((r) => setTimeout(r, RPC_GAP_MS));
  }
  return { backfilled };
}

async function driftCycle(bot) {
  // Sample the N most-recent loans whose actual_received was already
  // recorded. Re-read on-chain to confirm the stored value matches.
  // Mismatch beyond tolerance fires an operator alert.
  const { rows } = await query(
    `SELECT id, tx_signature, borrower_wallet, actual_received_lamports::text AS stored
       FROM loans
      WHERE actual_received_lamports IS NOT NULL
        AND tx_signature IS NOT NULL
        AND borrower_wallet IS NOT NULL
      ORDER BY id DESC
      LIMIT $1`,
    [DRIFT_SAMPLE],
  );
  if (rows.length === 0) return { drifted: 0 };

  const conn = getConnection();
  const drifted = [];
  for (const l of rows) {
    try {
      const onChainCredit = await computeActualReceived(conn, l.tx_signature, l.borrower_wallet);
      if (onChainCredit == null) continue;
      const stored = BigInt(l.stored);
      const diff = stored > onChainCredit ? stored - onChainCredit : onChainCredit - stored;
      if (diff > BigInt(NETWORK_RENT_TOLERANCE_LAMPORTS)) {
        drifted.push({ id: l.id, stored: stored.toString(), chain: onChainCredit.toString(), diff: diff.toString() });
      }
    } catch { /* skip transient */ }
    await new Promise((r) => setTimeout(r, RPC_GAP_MS));
  }

  if (drifted.length > 0 && bot) {
    const adminId = process.env.ADMIN_TG_ID;
    if (adminId) {
      const detail = drifted.slice(0, 3)
        .map((d) => `loan #${d.id}: stored=${(Number(d.stored) / 1e9).toFixed(6)} SOL chain=${(Number(d.chain) / 1e9).toFixed(6)} SOL`)
        .join("\n");
      try {
        await bot.api.sendMessage(
          Number(adminId),
          `*Loan actual-received drift detected*\n\n` +
          `${drifted.length} loan(s) have stored actual_received_lamports that disagree with on-chain by > ${(NETWORK_RENT_TOLERANCE_LAMPORTS / 1e9).toFixed(6)} SOL.\n\n` +
          `${detail}\n\n` +
          `This is the class of bug that hit borrowers seeing "you got X SOL" on the dashboard when they actually got X − ~0.004 SOL.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* non-fatal */ }
    }
  }

  return { drifted: drifted.length };
}

async function tick(bot) {
  try {
    const [bf, df] = await Promise.all([
      backfillCycle(bot),
      driftCycle(bot),
    ]);
    if (bf.backfilled > 0 || df.drifted > 0) {
      console.log(`[loan-received-watchdog] backfilled=${bf.backfilled} drifted=${df.drifted}`);
    }
  } catch (err) {
    console.warn("[loan-received-watchdog] tick threw:", err.message?.slice(0, 80));
  }
}

export function startLoanReceivedWatchdog(bot) {
  if (_timer) return;
  console.log(`[loan-received-watchdog] armed — every ${RUN_INTERVAL_MS / 60_000} min (backfill ${BACKFILL_BATCH}/cycle, drift sample ${DRIFT_SAMPLE})`);
  setTimeout(() => {
    tick(bot).catch((e) => console.warn("[loan-received-watchdog] first tick threw:", e.message?.slice(0, 80)));
    _timer = setInterval(() => {
      tick(bot).catch((e) => console.warn("[loan-received-watchdog] tick threw:", e.message?.slice(0, 80)));
    }, RUN_INTERVAL_MS);
  }, FIRST_DELAY_MS);
}
