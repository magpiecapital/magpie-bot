/**
 * LP-excess auto-sweeper — Phase 2 of task #332.
 *
 * Calls admin_withdraw on each program's pool to extract the 4% spread
 * (vault_balance - total_deposits) and sends the SOL directly to CHCAM
 * via the closeAccount-with-arbitrary-destination pattern.
 *
 * Per-tick flow per pool with positive excess:
 *   1. Re-read pool + vault under the SAME RPC connection used for the
 *      tx broadcast, so the amount we ask for is exactly what's
 *      withdrawable RIGHT NOW (no stale-snapshot drain attempt).
 *   2. Cap the sweep amount at MAX_SWEEP_LAMPORTS as a defense against
 *      any off-chain math bug. The on-chain program already refuses
 *      drains beyond excess; this is belt-and-suspenders.
 *   3. INSERT a row into lp_excess_sweeps with status='planned'
 *      BEFORE broadcast — that's our idempotency anchor.
 *   4. Build one atomic tx:
 *        - createAssociatedTokenAccountIdempotent(lender wSOL ATA)
 *        - admin_withdraw(amount) -> lender wSOL ATA
 *        - closeAccount(lender wSOL ATA -> CHCAM)
 *      The closeAccount destination is CHCAM (per spl-token semantics
 *      closeAccount sends the unwrapped SOL + rent to `destination`),
 *      so the swept SOL lands on CHCAM directly without an intermediate
 *      lender-wallet hop. Atomic — if anything fails, all rolls back.
 *   5. Simulate first, then broadcast. UPDATE the audit row on confirm
 *      with status + tx_signature, or on failure with status='failed'
 *      and the error.
 *   6. DM operator at the start and end of each sweep tick so they
 *      always know what happened.
 *
 * Safety properties:
 *   - The on-chain program guards against draining share-backed deposits.
 *     Even if our excess math is wrong, admin_withdraw will reject.
 *   - LP_EXCESS_SWEEPER_DISABLED env kills it instantly.
 *   - LP_EXCESS_AUTO_SWEEP_ENABLED env (default OFF) — must be flipped
 *     ON for any tx to broadcast. While OFF, the sweeper RUNS but only
 *     DMs operator with what it WOULD have swept. This is the safety
 *     rail per the standing rule "never affect collateral state
 *     without per-action operator green light" — Phase 2 ships the
 *     CODE but doesn't BROADCAST until operator flips the flag.
 *   - MAX_SWEEPS_PER_TICK caps blast radius on accidental over-issue.
 *   - Pre-flight simulate every tx; refuse to broadcast a tx the RPC
 *     rejects in simulation.
 *   - Idempotency check: skip pools with any open 'planned' row that
 *     hasn't been resolved (another tick is in flight; do not race).
 *
 * [[feedback_distribution_wallet_must_be_auto_funded]]
 * [[feedback_world_class_engineering_standard]]
 * [[feedback_no_breakage_to_existing_users]]
 */
import {
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
// Named { BN } breaks on Node 22+ (strict ESM-from-CJS). Default-import
// then destructure. [[feedback_anchor_cjs_node22_import_pattern]]
import anchorPkg from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import bs58 from "bs58";

import { connection, withFailover } from "../solana/connection.js";
import {
  PROGRAM_ID,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
  getProgramForSigner,
} from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";
import { assertAllowedDestination } from "./privileged-destinations.js";
import {
  runPrivilegedSign,
  recordPrivilegedSignResult,
} from "./privileged-sign-guard.js";
import { withLenderSpendLock } from "./lender-spend-lock.js";
import { availableLenderNative } from "./lender-reserve.js";

const TICK_MS = Number(process.env.LP_EXCESS_SWEEPER_MS) || 24 * 60 * 60 * 1000;
const MIN_SWEEP_LAMPORTS = BigInt(process.env.LP_EXCESS_MIN_SWEEP_LAMPORTS || "100000000"); // 0.1 SOL — don't waste tx fees on dust
const MAX_SWEEP_LAMPORTS = BigInt(process.env.LP_EXCESS_MAX_SWEEP_LAMPORTS || "5000000000"); // 5 SOL per call — defense in depth
const MAX_SWEEPS_PER_TICK = Number(process.env.LP_EXCESS_MAX_SWEEPS_PER_TICK || "3");
const CHCAM_PUBKEY = new PublicKey(
  process.env.REWARDS_DISTRIBUTOR_PUBKEY || "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac",
);
// The ONLY native-SOL cost this sweep imposes on the lender (fee payer +
// admin_withdraw authority): the tx fee plus, at most, wSOL ATA rent
// (~0.00204 SOL) if the idempotent create actually opens the ATA. The swept
// SOL itself comes from the pool vault and lands on CHCAM via closeAccount —
// it never transits the lender's native balance. We declare this ceiling to
// the privileged-sign guard AND require the lender to hold it ABOVE the shared
// 5-SOL gas reserve before spending, so a sweep can never starve loan-gas.
const LENDER_SOL_COST_CEILING_LAMPORTS = 3_000_000n;
let _timer = null;

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function isDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.LP_EXCESS_SWEEPER_DISABLED || "");
}

function isLiveBroadcastEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.LP_EXCESS_AUTO_SWEEP_ENABLED || "");
}

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  throw new Error("LENDER_PRIVATE_KEY unset — lp-excess-sweeper cannot operate");
}

async function hasPlannedSweepInFlight(programLabel) {
  const { rows } = await query(
    `SELECT id FROM lp_excess_sweeps
      WHERE program_label = $1
        AND status = 'planned'
        AND created_at > NOW() - INTERVAL '15 min'
      LIMIT 1`,
    [programLabel],
  );
  return rows.length > 0;
}

async function recordPlanned({ programLabel, poolPk, vaultPk, totalDeposits, vaultBalance, excess, sweepLamports }) {
  const { rows } = await query(
    `INSERT INTO lp_excess_sweeps
       (program_label, pool_pubkey, vault_pubkey,
        observed_total_deposits, observed_vault_balance, observed_excess,
        swept_lamports, destination_pubkey, status)
     VALUES ($1, $2, $3, $4::text, $5::text, $6::text, $7::text, $8, 'planned')
     RETURNING id`,
    [
      programLabel,
      poolPk.toBase58(),
      vaultPk.toBase58(),
      totalDeposits.toString(),
      vaultBalance.toString(),
      excess.toString(),
      sweepLamports.toString(),
      CHCAM_PUBKEY.toBase58(),
    ],
  );
  return rows[0].id;
}

async function markConfirmed(auditId, signature) {
  await query(
    `UPDATE lp_excess_sweeps
        SET status = 'confirmed', tx_signature = $2, confirmed_at = NOW()
      WHERE id = $1 AND status = 'planned'`,
    [auditId, signature],
  );
}

async function markFailed(auditId, errorText) {
  await query(
    `UPDATE lp_excess_sweeps
        SET status = 'failed', error_text = $2
      WHERE id = $1 AND status = 'planned'`,
    [auditId, (errorText || "unknown").slice(0, 500)],
  );
}

/**
 * Read pool + vault under a fresh connection. Returns
 *   { ok: true, pool, vault, totalDeposits, vaultBalance, excess }
 *   or { ok: false, error }.
 */
async function readPoolFresh(lenderPubkey, programId, programLabel) {
  try {
    const [pool] = lendingPoolPda(lenderPubkey, programId);
    const [vault] = loanTokenVaultPda(pool, programId);
    // Read via withFailover so a Helius blip doesn't kill the tick.
    const lenderKp = loadLenderKeypair();
    const program = getProgramForSigner(lenderKp, programId);
    const poolAccount = await withFailover(async () => program.account.lendingPool.fetch(pool));
    const totalDeposits = BigInt(poolAccount.totalDeposits.toString());
    const vaultInfo = await withFailover((conn) => conn.getTokenAccountBalance(vault));
    const vaultBalance = BigInt(vaultInfo.value.amount);
    const excess = vaultBalance - totalDeposits;
    return { ok: true, pool, vault, totalDeposits, vaultBalance, excess, lenderKp, program };
  } catch (err) {
    return { ok: false, programLabel, error: err?.message?.slice(0, 200) || "unknown" };
  }
}

/**
 * Build the atomic admin_withdraw + close-to-CHCAM tx and broadcast.
 */
async function executeSweep(state, lenderKp, program, sweepLamports) {
  const { pool, vault } = state;

  // DESTINATION GUARD — reject a flipped env pubkey. The close destination is a
  // PRIVILEGED, source-allowlisted wallet; an attacker who flips
  // REWARDS_DISTRIBUTOR_PUBKEY on Railway can NOT redirect the swept SOL. Fail
  // fast before we build/sign anything.
  assertAllowedDestination("lp-excess-sweeper", CHCAM_PUBKEY);

  const authorityAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    lenderKp.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    lenderKp.publicKey,
    authorityAta,
    lenderKp.publicKey,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  ));
  const adminIx = await program.methods
    .adminWithdraw(new BN(sweepLamports.toString()))
    .accounts({
      pool,
      loanTokenVault: vault,
      authorityTokenAccount: authorityAta,
      authority: lenderKp.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(adminIx);
  // closeAccount(account, destination, authority, multiSigners) —
  // unwrapped SOL + rent go to `destination`. Pointing it at CHCAM
  // sends the swept SOL directly there. No intermediate lender hop.
  tx.add(createCloseAccountInstruction(
    authorityAta,
    CHCAM_PUBKEY,
    lenderKp.publicKey,
    [],
    TOKEN_PROGRAM_ID,
  ));

  const { blockhash, lastValidBlockHeight } = await withFailover((c) =>
    c.getLatestBlockhash("confirmed"),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = lenderKp.publicKey;

  // GUARDED SIGN — replaces the bare error-only simulateTransaction. The guard
  // (a) balance-delta-simulates and rejects ANY undeclared decrease on a
  // lender-owned account (still refusing to broadcast a tx the RPC rejects),
  // (b) pins the closeAccount destination to CHCAM via allowedCloseDestinations
  // so the swept SOL+rent can go NOWHERE else, and (c) writes an audit row so a
  // key-leak monitor can reconcile on-chain movement vs signed intent. The
  // lender pays only tx fee + (at most) wSOL ATA rent; declare that ceiling.
  const guard = await runPrivilegedSign({
    service: "lp-excess-sweeper",
    tx,
    signers: [lenderKp],
    allowedDeltas: [
      { pubkey: lenderKp.publicKey, kind: "sol", maxDecrease: LENDER_SOL_COST_CEILING_LAMPORTS },
    ],
    allowedCloseDestinations: [CHCAM_PUBKEY],
  });

  let signature;
  try {
    signature = await withFailover((c) =>
      c.sendRawTransaction(guard.signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      }),
    );
  } catch (e) {
    await recordPrivilegedSignResult({
      auditId: guard.auditId,
      status: "failed",
      error: e.message?.slice(0, 200),
    });
    throw e;
  }
  await recordPrivilegedSignResult({ auditId: guard.auditId, status: "broadcast", txSig: signature });
  await withFailover((c) =>
    c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed"),
  );
  await recordPrivilegedSignResult({ auditId: guard.auditId, status: "confirmed", txSig: signature });
  return signature;
}

async function tick(bot) {
  if (isDisabled()) return;
  if (!process.env.LENDER_PUBKEY) {
    console.warn("[lp-excess-sweeper] LENDER_PUBKEY unset — skipping");
    return;
  }
  const lenderPubkey = new PublicKey(process.env.LENDER_PUBKEY);
  const programs = [
    { label: "V1", id: PROGRAM_ID },
    PROGRAM_ID_V3 && { label: "V3", id: PROGRAM_ID_V3 },
    PROGRAM_ID_V4 && { label: "V4", id: PROGRAM_ID_V4 },
  ].filter(Boolean);

  const live = isLiveBroadcastEnabled();
  const summary = [];
  let sweptCount = 0;
  let totalSweptLamports = 0n;

  for (const p of programs) {
    if (sweptCount >= MAX_SWEEPS_PER_TICK) {
      summary.push(`  ${p.label}: SKIPPED — per-tick cap reached`);
      continue;
    }
    try {
      if (await hasPlannedSweepInFlight(p.label)) {
        summary.push(`  ${p.label}: SKIPPED — prior 'planned' row still resolving`);
        continue;
      }
      const state = await readPoolFresh(lenderPubkey, p.id, p.label);
      if (!state.ok) {
        summary.push(`  ${p.label}: READ FAILED — ${state.error}`);
        continue;
      }
      if (state.excess < MIN_SWEEP_LAMPORTS) {
        summary.push(`  ${p.label}: skip — excess ${fmtSol(state.excess > 0n ? state.excess : 0n)} SOL under floor (${fmtSol(MIN_SWEEP_LAMPORTS)} SOL)`);
        continue;
      }
      // Defense in depth: cap the asked amount.
      let sweep = state.excess > MAX_SWEEP_LAMPORTS ? MAX_SWEEP_LAMPORTS : state.excess;
      // Leave 0.001 SOL slack in the vault so a concurrent yield write
      // can't fail the on-chain excess check mid-tx (rounding safety).
      const slack = 1_000_000n;
      if (sweep > slack) sweep -= slack;

      const auditId = await recordPlanned({
        programLabel: p.label,
        poolPk: state.pool,
        vaultPk: state.vault,
        totalDeposits: state.totalDeposits,
        vaultBalance: state.vaultBalance,
        excess: state.excess,
        sweepLamports: sweep,
      });

      if (!live) {
        // Dry-run mode — record the plan but don't broadcast. Mark the
        // audit row so it's distinguishable from a real plan that crashed.
        await query(
          `UPDATE lp_excess_sweeps SET status='failed', error_text='dry_run_LP_EXCESS_AUTO_SWEEP_ENABLED_false' WHERE id=$1`,
          [auditId],
        );
        summary.push(`  ${p.label}: DRY-RUN — would sweep ${fmtSol(sweep)} SOL of ${fmtSol(state.excess)} SOL excess (set LP_EXCESS_AUTO_SWEEP_ENABLED=true to live)`);
        continue;
      }

      // Broadcast under the ONE shared lender-spend lock (the lender key signs
      // as fee payer + admin_withdraw authority) so this can never race a
      // sibling lender-spending service, and size the lender's small
      // gas/rent cost against availableLenderNative() — which enforces the
      // canonical 5-SOL reserve — so a sweep never dips the gas wallet below it.
      const lockOutcome = await withLenderSpendLock(async () => {
        const avail = await availableLenderNative(connection);
        if (avail < LENDER_SOL_COST_CEILING_LAMPORTS) {
          return { deferredReserve: true };
        }
        const s = await executeSweep(state, state.lenderKp, state.program, sweep);
        return { sig: s };
      });

      if (lockOutcome.skipped) {
        await markFailed(auditId, `lender-spend-lock: ${lockOutcome.reason}`);
        summary.push(`  ${p.label}: SKIPPED — ${lockOutcome.reason}`);
        continue;
      }
      if (lockOutcome.result?.deferredReserve) {
        await markFailed(auditId, "lender below gas reserve — sweep deferred");
        summary.push(`  ${p.label}: SKIPPED — lender at/below gas reserve; sweep deferred`);
        continue;
      }
      const sig = lockOutcome.result.sig;
      await markConfirmed(auditId, sig);
      sweptCount++;
      totalSweptLamports += sweep;
      summary.push(`  ${p.label}: SWEPT ${fmtSol(sweep)} SOL → CHCAM | tx ${sig}`);
    } catch (err) {
      console.error(`[lp-excess-sweeper] ${p.label} failed:`, err.message);
      summary.push(`  ${p.label}: FAILED — ${(err.message || "").slice(0, 200)}`);
    }
  }

  if (summary.length === 0) return;
  const headline = live
    ? `[lp-excess-sweeper] tick complete — ${sweptCount} sweep(s), ${fmtSol(totalSweptLamports)} SOL total → CHCAM`
    : `[lp-excess-sweeper] DRY-RUN tick complete`;
  await notifyAdmin(bot, [headline, "", ...summary].join("\n"));
}

export function startLpExcessSweeper(bot) {
  if (_timer) return;
  if (isDisabled()) {
    console.log("[lp-excess-sweeper] LP_EXCESS_SWEEPER_DISABLED — not started");
    return;
  }
  const live = isLiveBroadcastEnabled();
  console.log(
    `[lp-excess-sweeper] armed — every ${Math.round(TICK_MS / 3_600_000)}h | live=${live}`,
  );
  // Stagger first run by 10 min (after telemetry probe has DMed once,
  // gives operator a chance to inspect numbers before any tx fires).
  setTimeout(() => {
    tick(bot).catch((e) => console.warn("[lp-excess-sweeper] first tick threw:", e.message));
    _timer = setInterval(() => {
      tick(bot).catch((e) => console.warn("[lp-excess-sweeper] tick threw:", e.message));
    }, TICK_MS);
  }, 10 * 60_000);
}

export function stopLpExcessSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
