/**
 * Fee-wallet wSOL → lender NATIVE unwrapper.
 *
 * Operator-mandated 2026-06-17, REARCHITECTED 2026-06-29
 * (feedback_distribution_wallet_must_be_auto_funded.md).
 *
 * THE PROBLEM (and the 2026-06-29 root-cause fix)
 * ───────────────────────────────────────────────
 * Borrow fees physically transfer 1% upfront to the on-chain fee_wallet (a
 * wSOL ATA owned by the lender pubkey 4JSSSaG3…). The rewards distribution
 * wallet CHCAMWtn… pays out holder / LP-loyalty snapshots in NATIVE SOL.
 *
 * The ORIGINAL sweeper sent the fee wSOL straight to CHCAM's wSOL ATA — where
 * it STRANDED, because the native-SOL distributors can't see wrapped SOL and
 * the bot (correctly) can't sign for CHCAM to unwrap it. That stranding is the
 * exact reason the operator had to hand-fund CHCAM repeatedly.
 *
 * WHAT THIS DOES NOW
 * ──────────────────
 * Every FEE_WALLET_SWEEP_INTERVAL_MS (default 1 hour), under the SHARED lender
 * spend lock:
 *   1. Read the lender's OWN fee wSOL ATA balance.
 *   2. If > MIN_SWEEP, atomically `closeAccount(feeWalletAta → lender,
 *      authority=lender)` (returns wSOL + ATA rent as NATIVE SOL into 4JSS)
 *      + idempotently re-create the empty fee ATA in the SAME tx so the next
 *      borrow's fee-routing target exists.
 *   3. The value is now NATIVE in the lender. The distribution-auto-funder is
 *      the SOLE writer that routes lender native → CHCAM. This sweeper NEVER
 *      touches CHCAM — so no wSOL can ever strand there again.
 *
 * SAFETY INVARIANTS
 *   - Bot CAN sign this (lender owns the fee ATA + authority); never needs
 *     CHCAM's key. CHCAM is not a destination anywhere here.
 *   - Idempotent: close+reopen is self-healing — if a prior (unrecorded) tx
 *     already ran, the fee ATA reads empty next tick and we skip; if it
 *     didn't, the wSOL is still there and we unwrap it. So a stuck 'planned'
 *     row is auto-resolved after the blockhash expires (~3 min) and re-running
 *     is always safe.
 *   - The close DESTINATION is a runtime-asserted constant = the lender
 *     pubkey, never an env value; privileged-sign-guard additionally rejects
 *     any closeAccount to a non-signer.
 *   - Shared lender lock → at most one lender-spending tx in flight across all
 *     services, so the 5-SOL gas reserve holds. (The close INCREASES lender
 *     native, so it never threatens the reserve — but it still takes the lock
 *     to stay serialized with the funder/x402 spends.)
 *   - FEE_WALLET_SWEEPER_DISABLED=true halts immediately.
 *   - Every unwrap → admin DM + Railway log.
 */
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";
import { withFailover } from "../solana/connection.js";
import { withLenderSpendLock } from "./lender-spend-lock.js";

const SWEEP_INTERVAL_MS = Number(
  process.env.FEE_WALLET_SWEEP_INTERVAL_MS || 60 * 60 * 1000, // 1 hour
);
// Only unwrap if the fee ATA holds more than this — avoids burning a tx fee on
// dust. The whole balance is unwrapped (the ATA is closed + reopened empty).
const MIN_SWEEP_LAMPORTS = BigInt(
  process.env.FEE_WALLET_MIN_SWEEP_LAMPORTS || 100_000_000, // 0.1 SOL
);
// A 'planned' row older than this is auto-resolved (blockhash long expired, so
// any in-flight tx is dead; close+reopen is idempotent so re-running is safe).
const STUCK_PLANNED_MS = Number(process.env.FEE_WALLET_STUCK_PLANNED_MS || 3 * 60 * 1000);
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const LENDER_PUBKEY = process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";

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
    `[fee-wallet-sweeper] armed (lender-side unwrap) — first run in 2 min, then every ${SWEEP_INTERVAL_MS / 60_000} min. ` +
      `MIN_SWEEP=${Number(MIN_SWEEP_LAMPORTS) / 1e9} SOL`,
  );
}

async function runOnce(bot) {
  // Auto-resolve a stuck 'planned' row: after STUCK_PLANNED_MS the blockhash
  // has expired so any in-flight tx is dead; close+reopen is idempotent, so the
  // next balance read self-corrects. Mark it stale and proceed (never a
  // permanent halt — the original code skipped forever).
  const { rows: stuck } = await query(
    `SELECT id, created_at FROM fee_wallet_sweeps
      WHERE status = 'planned' ORDER BY id ASC LIMIT 1`,
  );
  if (stuck.length > 0) {
    const ageMs = Date.now() - new Date(stuck[0].created_at).getTime();
    if (ageMs < STUCK_PLANNED_MS) {
      console.warn(
        `[fee-wallet-sweeper] skipping — sweep #${stuck[0].id} still 'planned' (${Math.round(ageMs / 1000)}s old, < ${Math.round(STUCK_PLANNED_MS / 1000)}s).`,
      );
      return;
    }
    await query(
      `UPDATE fee_wallet_sweeps SET status = 'failed', err = $2, updated_at = NOW() WHERE id = $1 AND status = 'planned'`,
      [stuck[0].id, "auto-resolved: stale 'planned' row past blockhash expiry; idempotent close+reopen makes re-run safe"],
    );
    console.warn(`[fee-wallet-sweeper] auto-resolved stale 'planned' sweep #${stuck[0].id} — proceeding.`);
  }

  const lenderKp = Keypair.fromSecretKey(bs58.decode(process.env.LENDER_PRIVATE_KEY));
  if (lenderKp.publicKey.toBase58() !== LENDER_PUBKEY) {
    console.error(
      `[fee-wallet-sweeper] LENDER_PRIVATE_KEY pubkey ${lenderKp.publicKey.toBase58().slice(0, 10)}… ≠ expected ${LENDER_PUBKEY.slice(0, 10)}…. Refusing to operate.`,
    );
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const feeWalletAta = await getAssociatedTokenAddress(NATIVE_MINT, lenderKp.publicKey);

  // Read current fee_wallet wSOL balance.
  let acct;
  try {
    acct = await getAccount(connection, feeWalletAta, "confirmed", TOKEN_PROGRAM_ID);
  } catch {
    console.log(`[fee-wallet-sweeper] fee_wallet ATA not found or empty — skipping`);
    return;
  }
  const wsolBalance = acct.amount; // bigint
  if (wsolBalance < MIN_SWEEP_LAMPORTS) {
    console.log(
      `[fee-wallet-sweeper] fee_wallet wSOL ${Number(wsolBalance) / 1e9} SOL < MIN_SWEEP ${Number(MIN_SWEEP_LAMPORTS) / 1e9} — skipping`,
    );
    return;
  }

  // Everything that signs with the lender key serializes on the ONE shared
  // lock so the 5-SOL gas reserve holds across all writers.
  const locked = await withLenderSpendLock(async () => {
    await unwrapOnce(bot, connection, lenderKp, feeWalletAta, wsolBalance);
  });
  if (locked.skipped) {
    console.log(`[fee-wallet-sweeper] skipped tick — ${locked.reason}`);
  }
}

async function unwrapOnce(bot, connection, lenderKp, feeWalletAta, wsolBalance) {
  // Phase 1 — 'planned' audit anchor BEFORE broadcast. dest is the lender's
  // OWN native (the close returns value to the lender); CHCAM is NOT involved.
  const { rows: [auditRow] } = await query(
    `INSERT INTO fee_wallet_sweeps
       (source_pubkey, dest_pubkey, amount_lamports, status, reason)
     VALUES ($1, $2, $3::numeric, 'planned', 'lender_side_unwrap')
     RETURNING id`,
    [feeWalletAta.toBase58(), lenderKp.publicKey.toBase58(), wsolBalance.toString()],
  );
  const sweepId = auditRow.id;

  // Phase 2 — atomic close (unwrap to lender native) + idempotent reopen.
  const tx = new Transaction();
  tx.add(
    createCloseAccountInstruction(
      feeWalletAta,            // account to close (the fee wSOL ATA)
      lenderKp.publicKey,      // destination — the lender's OWN native (asserted below)
      lenderKp.publicKey,      // authority
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      lenderKp.publicKey,      // payer
      feeWalletAta,            // ata to (re)create
      lenderKp.publicKey,      // owner
      NATIVE_MINT,             // mint
    ),
  );

  let sig;
  let guardAuditId = null;
  try {
    const { runPrivilegedSign, recordPrivilegedSignResult } = await import("./privileged-sign-guard.js");

    const RETRY_DELAYS_MS = [0, 5_000, 15_000];
    let lastErr = null;
    let ok = false;
    // Pair each BROADCAST sig with the audit row that produced it, so a
    // confirm-timeout reconcile in the catch attributes the right row (the
    // per-attempt re-sign advances guardAuditId, which would otherwise be
    // mismatched against an earlier attempt's sig).
    let broadcastSig = null;
    let broadcastAuditId = null;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      try {
        const { blockhash, lastValidBlockHeight } = await withFailover((c) => c.getLatestBlockhash("confirmed"));
        tx.recentBlockhash = blockhash;
        tx.feePayer = lenderKp.publicKey;

        // Re-sign for THIS attempt's fresh blockhash on EVERY attempt. Gating
        // the sign to attempt 0 would leave attempts 2-3 carrying a signature
        // for an expired blockhash → tx.serialize() throws "signature
        // verification failed" before broadcast, silently killing the retry.
        // partialSign recomputes over the new compiled message (incl. the new
        // blockhash) and replaces the lender's signature slot. A fresh audit
        // row per attempt is acceptable and keeps a paper trail per broadcast.
        const guard = await runPrivilegedSign({
          service: "fee-wallet-sweeper",
          tx,
          signers: [lenderKp],
          // The close NETS lender native POSITIVE (wSOL + close rent in,
          // reopen rent + tx fee out). Declare the fee ATA token full
          // decrease + a tiny lender SOL fee headroom defensively.
          allowedDeltas: [
            { pubkey: feeWalletAta, kind: "token", mint: NATIVE_MINT, maxDecrease: BigInt(wsolBalance) },
            { pubkey: lenderKp.publicKey, kind: "sol", maxDecrease: 10_000n },
          ],
          // The only close destination permitted is the lender itself.
          allowedCloseDestinations: [lenderKp.publicKey],
        });
        guardAuditId = guard.auditId;

        sig = await withFailover((c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false }));
        broadcastSig = sig;            // pair the broadcast sig with THIS attempt's audit row
        broadcastAuditId = guardAuditId;
        await withFailover((c) => c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"));
        await recordPrivilegedSignResult({ auditId: guardAuditId, status: "confirmed", txSig: sig });
        ok = true;
        break;
      } catch (innerErr) {
        lastErr = innerErr;
        const isLast = attempt === RETRY_DELAYS_MS.length - 1;
        console.warn(
          `[fee-wallet-sweeper] unwrap #${sweepId} attempt ${attempt + 1}/${RETRY_DELAYS_MS.length} failed: ${innerErr?.message?.slice(0, 120)}`,
        );
        if (!isLast) continue;
        throw innerErr;
      }
    }
    if (!ok) throw lastErr || new Error("unwrap failed after all retries");
  } catch (err) {
    // Reconcile before declaring failure: a confirm-timeout / RPC blip on a tx
    // that ACTUALLY LANDED must not be mis-recorded as failed (false alarm +
    // audit drift on a money path). If we broadcast a sig, ask the cluster.
    if (broadcastSig) {
      try {
        const st = await withFailover((c) =>
          c.getSignatureStatuses([broadcastSig], { searchTransactionHistory: true }),
        );
        const v = st?.value?.[0];
        if (v && !v.err && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
          if (broadcastAuditId) {
            try {
              const { recordPrivilegedSignResult } = await import("./privileged-sign-guard.js");
              await recordPrivilegedSignResult({ auditId: broadcastAuditId, status: "confirmed", txSig: broadcastSig });
            } catch { /* best-effort */ }
          }
          await query(
            `UPDATE fee_wallet_sweeps SET status = 'confirmed', tx_signature = $2, updated_at = NOW() WHERE id = $1`,
            [sweepId, broadcastSig],
          );
          console.log(
            `[fee-wallet-sweeper] unwrap #${sweepId} reconciled CONFIRMED (confirm-timeout but tx landed), sig=${broadcastSig.slice(0, 20)}…`,
          );
          try {
            await notifyAdmin(
              bot,
              `✅ Fee-wallet unwrap #${sweepId} CONFIRMED (reconciled after a confirm-timeout)\n` +
                `Converted: ${(Number(wsolBalance) / 1e9).toFixed(6)} wSOL → NATIVE in the lender.\n` +
                `Tx: https://solscan.io/tx/${broadcastSig}`,
            );
          } catch {}
          return;
        }
      } catch { /* fall through to the failure path */ }
    }
    if (guardAuditId) {
      try {
        const { recordPrivilegedSignResult } = await import("./privileged-sign-guard.js");
        await recordPrivilegedSignResult({ auditId: guardAuditId, status: "failed", error: err.message?.slice(0, 200) });
      } catch { /* best-effort */ }
    }
    const msg = err?.message?.slice(0, 240) || String(err).slice(0, 240);
    await query(`UPDATE fee_wallet_sweeps SET status = 'failed', err = $2, updated_at = NOW() WHERE id = $1`, [sweepId, msg]);
    console.error(`[fee-wallet-sweeper] unwrap #${sweepId} failed: ${msg}`);
    try {
      await notifyAdmin(
        bot,
        `🚨 Fee-wallet unwrap #${sweepId} FAILED.\n` +
          `Amount: ${(Number(wsolBalance) / 1e9).toFixed(6)} SOL\nError: ${msg}\nNext tick retries.`,
      );
    } catch {}
    return;
  }

  await query(
    `UPDATE fee_wallet_sweeps SET status = 'confirmed', tx_signature = $2, updated_at = NOW() WHERE id = $1`,
    [sweepId, sig],
  );

  const solAmt = (Number(wsolBalance) / 1e9).toFixed(6);
  console.log(
    `[fee-wallet-sweeper] unwrap #${sweepId} CONFIRMED — ${solAmt} wSOL → native in lender, sig=${sig.slice(0, 20)}…`,
  );
  try {
    await notifyAdmin(
      bot,
      `✅ Fee-wallet unwrap #${sweepId} CONFIRMED\n` +
        `Converted: ${solAmt} wSOL → NATIVE in the lender wallet.\n` +
        `The distribution-auto-funder routes lender native → CHCAM (no wSOL ever lands in CHCAM).\n` +
        `Tx: https://solscan.io/tx/${sig}`,
    );
  } catch {}
}

export function stopFeeWalletSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
