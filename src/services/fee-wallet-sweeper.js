/**
 * Fee wallet → distribution wallet auto-sweeper.
 *
 * Operator-mandated 2026-06-17
 * (feedback_distribution_wallet_must_be_auto_funded.md).
 *
 * THE PROBLEM
 * ───────────
 * Borrow fees physically transfer 1% upfront to the on-chain
 * fee_wallet (a wSOL ATA owned by the lender pubkey 4JSSSaG3…). The
 * distribution wallet CHCAMWtn… is what pays out holder / LP-loyalty /
 * referral / protocol-reserve snapshots. There is no automated flow
 * between these two wallets. Operator was manually moving SOL before
 * each snapshot. Without auto-sweep, the existing
 * magpie-holder-rewards.js line 638 check ('distributor < pool')
 * silently skips distributions when the gap is negative.
 *
 * On 2026-06-17 the gap was 27.27 SOL owed vs 12.07 SOL in CHCAMWtn —
 * the next snapshot would have silently skipped.
 *
 * WHAT THIS DOES
 * ──────────────
 * Every FEE_WALLET_SWEEP_INTERVAL_MS (default 1 hour):
 *   1. Read fee_wallet's wSOL balance.
 *   2. If balance > MIN_SWEEP_LAMPORTS, plan a sweep of
 *      (balance - MIN_RESERVE_LAMPORTS) to the distribution wallet.
 *   3. Write an audit row to fee_wallet_sweeps with status='planned'
 *      BEFORE the tx is broadcast (idempotency anchor).
 *   4. Build a tx: createSyncNative if any native lamports linger,
 *      transferChecked wSOL → CHCAMWtn's wSOL ATA (create if missing),
 *      OR close the fee_wallet's wSOL ATA via closeAccount and have
 *      the SOL flow to CHCAMWtn directly. We use the closeAccount +
 *      reopen pattern because it cleanly converts wSOL back to native
 *      SOL in one shot, and re-creates the fee_wallet ATA for the
 *      next borrow.
 *   5. Broadcast + confirm. On success, update audit row with
 *      tx_signature + status='confirmed'. On failure, mark 'failed'
 *      with the err.message — caller (the sweeper loop) can retry on
 *      the next tick.
 *   6. notifyAdmin DM with the sweep amount.
 *
 * SAFETY INVARIANTS — every sweep tx MUST satisfy:
 *   - Idempotency: re-running cannot double-spend. The audit row
 *     'planned' is written FIRST. If we see a non-confirmed row from
 *     a prior tick, we don't plan a new sweep until that one is
 *     resolved (status='confirmed' or 'failed').
 *   - Atomicity: audit row → tx broadcast → confirm → update audit.
 *     A crash at any step leaves an auditable trail (the 'planned'
 *     row + optionally the tx_signature) that the operator can
 *     reconcile on-chain.
 *   - Reserve floor: never drain fee_wallet below MIN_RESERVE
 *     (covers rent + small operational headroom). Default 0.05 SOL.
 *   - Sweep threshold: only fire if balance - MIN_RESERVE >
 *     MIN_SWEEP. Default 0.1 SOL. Avoids tx-fee drain on dust.
 *   - Operator pause: env var FEE_WALLET_SWEEPER_DISABLED=true halts
 *     immediately, no restart needed.
 *   - Logged: every sweep produces an admin DM AND a Railway log
 *     line. Silent operation is forbidden.
 *
 * Counterpart pieces (separate files):
 *   - distribution_gap_monitor.js — admin-DMs P0 if pool > distributor
 *     at any point, BEFORE the snapshot would skip silently.
 *   - migration: fee_wallet_sweeps audit ledger table.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";

const SWEEP_INTERVAL_MS = Number(
  process.env.FEE_WALLET_SWEEP_INTERVAL_MS || 60 * 60 * 1000, // 1 hour
);
const MIN_SWEEP_LAMPORTS = BigInt(
  process.env.FEE_WALLET_MIN_SWEEP_LAMPORTS || 100_000_000, // 0.1 SOL
);
const MIN_RESERVE_LAMPORTS = BigInt(
  process.env.FEE_WALLET_MIN_RESERVE_LAMPORTS || 50_000_000, // 0.05 SOL
);
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// Lender pubkey (also the owner of the fee_wallet wSOL ATA).
const LENDER_PUBKEY = process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";

// Distribution wallet — funds holder / LP-loyalty / referral / protocol-
// reserve payouts via the magpie-holder-rewards distributor. Operator-set
// as REWARDS_DISTRIBUTOR_PUBKEY; falls back to the historical CHCAM
// address for safety / observability.
const DISTRIBUTION_WALLET_PUBKEY =
  process.env.REWARDS_DISTRIBUTOR_PUBKEY || "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";

let _timer = null;

export function startFeeWalletSweeper(bot) {
  if (_timer) return;
  if (/^(1|true|yes|on)$/i.test(process.env.FEE_WALLET_SWEEPER_DISABLED || "")) {
    console.log("[fee-wallet-sweeper] DISABLED via FEE_WALLET_SWEEPER_DISABLED env var");
    return;
  }
  if (!process.env.LENDER_PRIVATE_KEY) {
    console.warn(
      "[fee-wallet-sweeper] LENDER_PRIVATE_KEY not set — sweeper requires the fee_wallet owner key. Disabled.",
    );
    return;
  }
  // First run after 2 min so the boot storm settles.
  setTimeout(() => {
    runOnce(bot).catch((e) =>
      console.warn(`[fee-wallet-sweeper] first run failed: ${e.message?.slice(0, 160)}`),
    );
    _timer = setInterval(() => {
      runOnce(bot).catch((e) =>
        console.warn(`[fee-wallet-sweeper] tick failed: ${e.message?.slice(0, 160)}`),
      );
    }, SWEEP_INTERVAL_MS);
  }, 120_000);
  console.log(
    `[fee-wallet-sweeper] armed — first run in 2 min, then every ${SWEEP_INTERVAL_MS / 60_000} min. ` +
      `MIN_SWEEP=${Number(MIN_SWEEP_LAMPORTS) / 1e9} SOL, MIN_RESERVE=${Number(MIN_RESERVE_LAMPORTS) / 1e9} SOL`,
  );
}

async function runOnce(bot) {
  // Idempotency anchor: bail if a prior planned sweep is still
  // unresolved. Operator can investigate via /distgap or
  // fee_wallet_sweeps query.
  const { rows: stuck } = await query(
    `SELECT id, created_at FROM fee_wallet_sweeps
      WHERE status = 'planned'
      ORDER BY id ASC LIMIT 1`,
  );
  if (stuck.length > 0) {
    const ageMin = Math.round((Date.now() - new Date(stuck[0].created_at).getTime()) / 60_000);
    console.warn(`[fee-wallet-sweeper] skipping — sweep #${stuck[0].id} still in 'planned' state (${ageMin} min old). Resolve manually.`);
    return;
  }

  const lenderKp = Keypair.fromSecretKey(bs58.decode(process.env.LENDER_PRIVATE_KEY));
  if (lenderKp.publicKey.toBase58() !== LENDER_PUBKEY) {
    console.error(
      `[fee-wallet-sweeper] LENDER_PRIVATE_KEY pubkey ${lenderKp.publicKey.toBase58().slice(0, 10)}… ≠ expected ${LENDER_PUBKEY.slice(0, 10)}…. Refusing to operate.`,
    );
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const feeWalletAta = await getAssociatedTokenAddress(
    NATIVE_MINT,
    lenderKp.publicKey,
  );
  const distributionPk = new PublicKey(DISTRIBUTION_WALLET_PUBKEY);
  const distributionAta = await getAssociatedTokenAddress(
    NATIVE_MINT,
    distributionPk,
  );

  // Read current fee_wallet wSOL balance.
  let acct;
  try {
    acct = await getAccount(connection, feeWalletAta, "confirmed", TOKEN_PROGRAM_ID);
  } catch (err) {
    // ATA might not exist if no borrow has happened yet — nothing to sweep.
    console.log(`[fee-wallet-sweeper] fee_wallet ATA not found or empty — skipping`);
    return;
  }
  const wsolBalance = acct.amount; // bigint (wSOL has 9 decimals; 1 unit = 1 lamport)
  const sweepable = wsolBalance > MIN_RESERVE_LAMPORTS ? wsolBalance - MIN_RESERVE_LAMPORTS : 0n;

  if (sweepable < MIN_SWEEP_LAMPORTS) {
    console.log(
      `[fee-wallet-sweeper] fee_wallet balance ${Number(wsolBalance) / 1e9} SOL; sweepable ${Number(sweepable) / 1e9} below MIN_SWEEP ${Number(MIN_SWEEP_LAMPORTS) / 1e9} — skipping`,
    );
    return;
  }

  // Phase 1 — Write 'planned' audit row BEFORE broadcast. This is the
  // idempotency anchor: if the process dies between here and confirm,
  // the operator finds an unresolved 'planned' row and can investigate
  // on-chain whether the tx landed.
  const { rows: [auditRow] } = await query(
    `INSERT INTO fee_wallet_sweeps
       (source_pubkey, dest_pubkey, amount_lamports, status, reason)
     VALUES ($1, $2, $3::numeric, 'planned', 'periodic_auto_sweep')
     RETURNING id`,
    [feeWalletAta.toBase58(), distributionAta.toBase58(), sweepable.toString()],
  );
  const sweepId = auditRow.id;

  // Phase 2 — Build and broadcast the tx.
  //
  // Strategy: transferChecked wSOL → distribution wallet's wSOL ATA.
  // We use createAssociatedTokenAccountIdempotentInstruction so we can
  // safely re-run; if the dest ATA already exists, it's a no-op.
  // We avoid the closeAccount path because closing the fee_wallet ATA
  // would break the next borrow's fee-routing — the V4 program expects
  // the ATA to exist.
  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      lenderKp.publicKey,           // payer
      distributionAta,              // ata to ensure
      distributionPk,               // owner of the ata
      NATIVE_MINT,                  // mint
    ),
  );
  tx.add(
    createTransferInstruction(
      feeWalletAta,
      distributionAta,
      lenderKp.publicKey,           // ATA authority
      sweepable,
    ),
  );
  // Sync the dest ATA so its lamport balance reflects the deposit
  // (downstream code reading SOL on the ATA sees the right number).
  tx.add(createSyncNativeInstruction(distributionAta));

  let sig;
  let guardAuditId = null;
  try {
    // Hard allowlist + universal sign guard. Operator-mandated
    // 2026-06-18 PM follow-up to the cosign-borrow exploit defense —
    // every privileged-keypair signing path must go through the guard
    // so a misconfigured env var can't redirect funds and an unauth'd
    // balance decrease on the lender wallet fails sim before broadcast.
    // See feedback_cosign_borrow_token_drain_exploit_2026_06_18.md.
    const { assertAllowedDestination } = await import("./privileged-destinations.js");
    const { runPrivilegedSign, recordPrivilegedSignResult } = await import("./privileged-sign-guard.js");
    assertAllowedDestination("fee-wallet-sweeper", distributionPk);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = lenderKp.publicKey;

    const guard = await runPrivilegedSign({
      service: "fee-wallet-sweeper",
      tx,
      signers: [lenderKp],
      allowedDeltas: [
        // Lender's wSOL ATA (the fee_wallet) decreases by sweepable.
        // No other lender-owned balance may change.
        {
          pubkey: feeWalletAta,
          kind: "token",
          mint: NATIVE_MINT,
          maxDecrease: BigInt(sweepable),
        },
        // Lender pays the SOL tx fee (~5000 lamports) + may pay ATA
        // creation rent (~2M lamports) if dest ATA didn't exist yet.
        // Budget generously to avoid false rejects.
        {
          pubkey: lenderKp.publicKey,
          kind: "sol",
          maxDecrease: 10_000_000n, // 0.01 SOL
        },
      ],
    });
    guardAuditId = guard.auditId;

    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    await recordPrivilegedSignResult({ auditId: guardAuditId, status: "confirmed", txSig: sig });
  } catch (err) {
    if (guardAuditId) {
      try {
        const { recordPrivilegedSignResult } = await import("./privileged-sign-guard.js");
        await recordPrivilegedSignResult({
          auditId: guardAuditId,
          status: "failed",
          error: err.message?.slice(0, 200),
        });
      } catch { /* best-effort */ }
    }
    // Phase 2 failure — mark audit row 'failed', alert operator. The
    // next tick will try again from clean state.
    const msg = err?.message?.slice(0, 240) || String(err).slice(0, 240);
    await query(
      `UPDATE fee_wallet_sweeps SET status = 'failed', err = $2, updated_at = NOW() WHERE id = $1`,
      [sweepId, msg],
    );
    console.error(`[fee-wallet-sweeper] sweep #${sweepId} failed: ${msg}`);
    try {
      await notifyAdmin(
        bot,
        `🚨 Fee-wallet sweep #${sweepId} FAILED.\n` +
          `Amount: ${(Number(sweepable) / 1e9).toFixed(6)} SOL\n` +
          `Error: ${msg}\n` +
          `Investigate on Solscan + check fee_wallet balance. Next tick will retry.`,
      );
    } catch {}
    return;
  }

  // Phase 3 — confirmed. Update audit row to 'confirmed' + tx sig.
  await query(
    `UPDATE fee_wallet_sweeps
        SET status = 'confirmed', tx_signature = $2, updated_at = NOW()
      WHERE id = $1`,
    [sweepId, sig],
  );

  const solAmt = (Number(sweepable) / 1e9).toFixed(6);
  console.log(
    `[fee-wallet-sweeper] sweep #${sweepId} CONFIRMED — ${solAmt} SOL fee_wallet → distribution_wallet, sig=${sig.slice(0, 20)}…`,
  );
  try {
    await notifyAdmin(
      bot,
      `✅ Fee-wallet sweep #${sweepId} CONFIRMED\n` +
        `Amount: ${solAmt} SOL\n` +
        `From: ${feeWalletAta.toBase58().slice(0, 12)}… (fee wallet wSOL ATA)\n` +
        `To: ${distributionAta.toBase58().slice(0, 12)}… (distribution wallet wSOL ATA)\n` +
        `Tx: https://solscan.io/tx/${sig}`,
    );
  } catch {}
}

export function stopFeeWalletSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
