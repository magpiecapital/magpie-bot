/**
 * One-shot remediation script for the 2026-06-13 RWA LTV misroute bug.
 *
 * For every loan against stock/etf/metal collateral that landed at
 * LTV < 50% (i.e. fell through the memecoin ladder in cosign-borrow's
 * hardcoded TIER_LTV map), this script computes what the loan
 * principal SHOULD have been at the matching RWA tier and transfers
 * the SOL delta from the lender wallet to the borrower.
 *
 * Idempotent: writes a row to loan_remediation_payouts per loan with
 * UNIQUE(loan_db_id, payout_kind), so re-running is safe.
 *
 * Operator-approved 2026-06-13 after the audit (12 loans, 23.23 SOL).
 *
 * Usage:
 *   railway run node scripts/remediate-rwa-ltv-misroute.js --dry
 *   railway run node scripts/remediate-rwa-ltv-misroute.js --live
 *
 * --dry is the default if no flag is passed.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import "dotenv/config";
import { query, pool } from "../src/db/pool.js";

const PAYOUT_KIND = "rwa_ltv_misroute_2026_06_13";
const IS_LIVE = process.argv.includes("--live");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MIN_LENDER_RESERVE_LAMPORTS = 500_000_000n; // 0.5 SOL — never drain below

// RWA tier ladder applied at remediation time. Pulled from
// rwa_loan_tiers in the script so a tier update in the DB doesn't
// silently change what we send retroactively. We freeze the values
// here as the 2026-06-13 snapshot.
const RWA_LADDER = { 0: 50, 1: 60, 2: 70 };
// Memecoin ladder (what cosign-borrow's bug actually applied)
const MEMECOIN_LADDER = { 0: 30, 1: 25, 2: 20 };

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function loadAffected() {
  const { rows } = await query(`
    SELECT l.id, l.loan_id::text AS loan_id, sm.symbol, sm.category,
           l.ltv_percentage,
           l.loan_amount_lamports::text AS received_lamports,
           l.borrower_wallet, l.user_id, l.status, l.created_at
      FROM loans l
      JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE sm.category IN ('stock','etf','metal')
       AND l.ltv_percentage < 50
       AND l.borrower_wallet IS NOT NULL
     ORDER BY l.id ASC
  `);
  // For each loan, figure out which tier option the misrouted LTV came
  // from, then map to the correct RWA LTV.
  const out = [];
  for (const r of rows) {
    const gotLtv = Number(r.ltv_percentage);
    // Reverse-map got-LTV to memecoin tier option (deterministic since
    // memecoin LTVs are unique per option). For got_ltv 30/25/20 →
    // option 0/1/2. For got_ltv 50/60/70 → ALREADY correct (skip).
    let option = null;
    for (const [opt, ltv] of Object.entries(MEMECOIN_LADDER)) {
      if (ltv === gotLtv) { option = Number(opt); break; }
    }
    if (option == null) {
      // Got LTV doesn't match memecoin ladder → not a misroute, skip.
      continue;
    }
    const shouldLtv = RWA_LADDER[option];
    if (!shouldLtv) continue;
    const received = BigInt(r.received_lamports);
    // delta = received * (should - got) / got
    const delta = (received * BigInt(shouldLtv - gotLtv)) / BigInt(gotLtv);
    if (delta <= 0n) continue;
    out.push({
      loanDbId: r.id,
      symbol: r.symbol,
      gotLtv,
      shouldLtv,
      receivedLamports: received,
      deltaLamports: delta,
      wallet: r.borrower_wallet,
      userId: r.user_id,
      status: r.status,
    });
  }
  return out;
}

async function ensureAuditRow(loan) {
  // Insert pending row. If a row already exists for this loan and the
  // payout already succeeded, skip — idempotent.
  const { rows } = await query(
    `INSERT INTO loan_remediation_payouts
       (loan_db_id, payout_kind, amount_lamports, recipient_wallet, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (loan_db_id, payout_kind)
     DO UPDATE SET amount_lamports = EXCLUDED.amount_lamports
     RETURNING id, status, tx_signature`,
    [loan.loanDbId, PAYOUT_KIND, loan.deltaLamports.toString(), loan.wallet],
  );
  return rows[0];
}

async function sendOne(conn, lender, loan, auditRowId) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: lender.publicKey,
      toPubkey: new PublicKey(loan.wallet),
      lamports: Number(loan.deltaLamports),
    }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [lender], { commitment: "confirmed" });
  await query(
    `UPDATE loan_remediation_payouts
        SET status = 'sent', tx_signature = $1, sent_at = NOW()
      WHERE id = $2`,
    [sig, auditRowId],
  );
  return sig;
}

async function maybeDm(loan, sig) {
  // Best-effort DM if the borrower has a linked telegram_id. Don't
  // import the bot directly — that would also boot every watcher;
  // instead post a row to the `notifications` table the bot already
  // polls.
  if (!loan.userId) return false;
  try {
    const payload = {
      kind: "remediation_rwa_ltv_2026_06_13",
      loan_db_id: loan.loanDbId,
      symbol: loan.symbol,
      got_ltv: loan.gotLtv,
      should_ltv: loan.shouldLtv,
      delta_sol: Number(loan.deltaLamports) / LAMPORTS_PER_SOL,
      tx_signature: sig,
    };
    await query(
      `INSERT INTO notifications (user_id, source, kind, payload, status)
       VALUES ($1, 'system', 'remediation_rwa_ltv', $2::jsonb, 'pending')`,
      [loan.userId, JSON.stringify(payload)],
    );
    return true;
  } catch (err) {
    console.warn(`[remediate] DM enqueue failed for loan ${loan.loanDbId}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`[remediate] mode = ${IS_LIVE ? "LIVE" : "DRY-RUN"}`);
  const affected = await loadAffected();
  if (affected.length === 0) {
    console.log("[remediate] no affected loans — nothing to do");
    await pool.end();
    return;
  }
  const totalLamports = affected.reduce((acc, l) => acc + l.deltaLamports, 0n);
  console.log(`[remediate] ${affected.length} loans, total delta = ${Number(totalLamports) / LAMPORTS_PER_SOL} SOL`);

  const lender = loadLenderKeypair();
  const conn = new Connection(RPC_URL, "confirmed");
  const lamportsBefore = BigInt(await conn.getBalance(lender.publicKey, "confirmed"));
  console.log(`[remediate] lender ${lender.publicKey.toBase58().slice(0, 8)}... balance = ${Number(lamportsBefore) / LAMPORTS_PER_SOL} SOL`);

  if (lamportsBefore < totalLamports + MIN_LENDER_RESERVE_LAMPORTS) {
    console.error(`[remediate] INSUFFICIENT — need ${Number(totalLamports + MIN_LENDER_RESERVE_LAMPORTS) / LAMPORTS_PER_SOL} SOL (total + 0.5 reserve), have ${Number(lamportsBefore) / LAMPORTS_PER_SOL}`);
    await pool.end();
    process.exit(2);
  }

  if (!IS_LIVE) {
    console.log("[remediate] DRY-RUN per-loan plan:");
    for (const l of affected) {
      console.log(`  loan #${l.loanDbId} ${l.symbol} ${l.gotLtv}%→${l.shouldLtv}% delta=${(Number(l.deltaLamports)/LAMPORTS_PER_SOL).toFixed(4)} SOL → ${l.wallet.slice(0,8)}... user=${l.userId ?? "(unlinked)"}`);
    }
    console.log("[remediate] re-run with --live to execute");
    await pool.end();
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const loan of affected) {
    const audit = await ensureAuditRow(loan);
    if (audit.status === "sent") {
      console.log(`[remediate] loan #${loan.loanDbId} already paid — sig ${audit.tx_signature?.slice(0, 16)}...`);
      skipped++;
      continue;
    }
    try {
      const sig = await sendOne(conn, lender, loan, audit.id);
      console.log(`[remediate] ✓ loan #${loan.loanDbId} sent ${(Number(loan.deltaLamports)/LAMPORTS_PER_SOL).toFixed(4)} SOL → ${loan.wallet.slice(0,8)}... sig=${sig.slice(0, 24)}...`);
      const dmd = await maybeDm(loan, sig);
      if (dmd) console.log(`[remediate]   DM enqueued for user ${loan.userId}`);
      sent++;
      // 300ms gap to avoid hammering the RPC
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`[remediate] ✗ loan #${loan.loanDbId} failed: ${err.message?.slice(0, 200)}`);
      await query(
        `UPDATE loan_remediation_payouts SET status = 'failed', failure_reason = $1 WHERE id = $2`,
        [err.message?.slice(0, 500) || "unknown", audit.id],
      );
      failed++;
    }
  }

  const lamportsAfter = BigInt(await conn.getBalance(lender.publicKey, "confirmed"));
  console.log(`[remediate] DONE — sent=${sent} skipped=${skipped} failed=${failed}`);
  console.log(`[remediate] lender balance: ${Number(lamportsBefore)/LAMPORTS_PER_SOL} → ${Number(lamportsAfter)/LAMPORTS_PER_SOL} SOL`);
  await pool.end();
}

main().catch((err) => {
  console.error("[remediate] FATAL:", err);
  process.exit(1);
});
