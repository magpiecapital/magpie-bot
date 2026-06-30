/**
 * Distribution-wallet auto-funder.
 *
 * Operator-mandated 2026-06-28 — "I DO NOT want to manually fund the
 * rewards distribution wallet anymore. Automate this like the best coder
 * in the world. No exploits or vulnerabilities."
 * (memory: feedback_distribution_wallet_must_be_auto_funded)
 *
 * THE ROOT CAUSE
 * ──────────────
 * Borrow-fee revenue physically lands as wSOL in the lender wallet's
 * fee ATA (4JSSSa…). Over time that wSOL is unwrapped to native SOL and
 * sits in the lender wallet. The protocol had TWO movers of lender SOL:
 *   • fee-wallet-sweeper — only moves wSOL (ATA is usually near-empty),
 *     so it almost never fires.
 *   • treasury-sweeper — moves native SOL, but (a) to COLD STORAGE
 *     (6foLvbG…) and (b) it's hard-paused.
 * Net result: NO automated path kept the rewards-distribution wallet
 * (CHCAM…) funded, so the operator hand-carried SOL each week.
 *
 * WHAT THIS DOES
 * ──────────────
 * Demand-driven, every DIST_FUNDER_INTERVAL_MS (default 15 min):
 *   1. payableOwed = magpie_holder_pool + lp_loyalty_pool accrued_lamports.
 *      These are the ONLY two pools that pay holders out of CHCAM via
 *      SystemProgram.transfer, and both DECREMENT on payout, so the figure
 *      is a true live liability. protocol_reserve_pool is deliberately
 *      EXCLUDED — it has no auto-payout path from CHCAM and is never
 *      decremented, so including it would inflate the gap forever and park
 *      operational capital in a hot wallet. (kept in the audit row only.)
 *   2. (best-effort) unwrap any wSOL stranded in the distribution wallet's
 *      own ATA → native SOL, so prior fee-sweeper deposits become spendable.
 *   3. spendable = distribution wallet NATIVE SOL.
 *   4. gap = (payableOwed + SAFETY_RESERVE) − spendable.
 *   5. fund min(gap, lenderAvailable, MAX_FUND_PER_TICK) from the lender's
 *      native SOL, where lenderAvailable = lenderNative − operational
 *      reserve − tx headroom.
 *
 * SAFETY INVARIANTS (every fund tx must satisfy)
 * ──────────────────────────────────────────────
 *   • ABSOLUTE PER-TICK CEILING (independent of `owed`): fundAmount is hard-
 *     capped by DIST_FUNDER_MAX_SOL regardless of what the DB counters say.
 *     A poisoned/over-accrued counter can therefore move at most one ceiling
 *     per tick, not drain the lender. This is the real cap — NOT the gap math.
 *   • PLAUSIBILITY GATE: if payableOwed exceeds DIST_FUNDER_OWED_CEILING_SOL
 *     (almost certainly an over-accrual / counter-poisoning), the tick makes
 *     NO movement and alerts the operator instead.
 *   • RESERVE-PROTECTED: never drains the lender below the operational reserve.
 *   • ALLOWLISTED DESTINATION: assertAllowedDestination() — flipping the env
 *     pubkey can only ever send to the pre-approved CHCAM rewards wallet.
 *   • GUARDED SIGN: runPrivilegedSign() pre-flight-simulates and rejects any
 *     tx that decreases a lender balance by more than the (already-ceiling-
 *     bounded) declared amount.
 *   • TRUE MUTUAL EXCLUSION: a session advisory lock is acquired AND released
 *     on the SAME pinned pg connection (held for the whole tick), plus an
 *     in-process reentrancy flag — so ticks never overlap and the lock can't
 *     leak across pooled connections and silently halt funding.
 *   • NO DOUBLE-FUND (without any in-flight state machine): the tick interval
 *     is floored well above a blockhash's ~90s validity, and the gap is always
 *     recomputed from the live 'confirmed' on-chain balance. So by the time a
 *     subsequent tick runs, the prior tx has either LANDED (distNative is
 *     higher → gap shrinks → no re-fund) or EXPIRED (could never land → safe to
 *     fund). There is no persistent "in-flight" row to get wedged on — that
 *     earlier design caused a silent-halt and was removed. A confirm-timeout
 *     does one best-effort status check purely for audit accuracy.
 *   • AUDITED: exactly one FUNDING-outcome row per tick (no anchor+terminal
 *     double rows). Unwrap activity is audited as separate outcome='unwrap_*'
 *     rows with funded=0, so SUM(funded_lamports) is always exact.
 *   • TRANSPARENT: every actual funding DMs the operator.
 *   • KILL SWITCH: DIST_FUNDER_DISABLED=true halts instantly.
 *
 * The distribution obligation is the SENIOR claim on lender fee revenue; the
 * treasury-sweeper (cold storage) must run AFTER this funder and respect the
 * same gap when un-paused.
 *
 * Refs: distribution-gap-monitor.js (alerts on the gap), treasury-sweeper.js
 *       (cold-storage mover, paused), migration 091_distribution_funding_events.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "node:fs";
import { query } from "../db/pool.js";
import { withFailover } from "../solana/connection.js";
import { notifyAdmin } from "./admin-notify.js";
import { assertAllowedDestination } from "./privileged-destinations.js";
import {
  runPrivilegedSign,
  recordPrivilegedSignResult,
} from "./privileged-sign-guard.js";
import { getRewardsDistributorKeypair } from "./distributor-keypair.js";
import { readPayableOwed } from "./distribution-owed.js";
import { withLenderSpendLock } from "./lender-spend-lock.js";
import { availableLenderNative } from "./lender-reserve.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

// ─── Config ───────────────────────────────────────────────────────
function envNum(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function solToLamports(sol) {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

// Floor both at 3 min — comfortably above a blockhash's ~60-90s validity. This
// is what makes "no double-fund" hold WITHOUT an in-flight state machine: by
// the time the next tick runs, the prior tx has either landed (gap shrinks) or
// expired (safe to re-fund). An operator can't lower it into the re-send window.
const INTERVAL_FLOOR_MS = 3 * 60 * 1000;
// 5 min (above the 3-min no-double-fund floor) — frequent enough that the
// window in which a fresh fee accrual could outrun CHCAM's balance is small.
// The operator's hard invariant is CHCAM native >= the displayed snapshot at
// ALL times; a short interval + the lead-buffer below keep it true.
const INTERVAL_MS = Math.max(INTERVAL_FLOOR_MS, envNum("DIST_FUNDER_INTERVAL_MS", 5 * 60 * 1000));
const FIRST_RUN_MS = Math.max(INTERVAL_FLOOR_MS, envNum("DIST_FUNDER_FIRST_RUN_MS", 4 * 60 * 1000));
// Operational reserve kept on the lender wallet so cosign-borrow gas,
// attestations and admin tx fees NEVER run dry — loan execution is the #1
// priority and the lender (4JSSSa…) is the gas wallet for those flows. Default
// 5 SOL (multiple weeks of gas runway). The treasury-sweeper keeps 20 SOL on
// this same wallet; this funder is gap-bounded AND the lender refills from
// continuous borrow fees, so it oscillates above this floor rather than pinning
// to it — but we still keep a generous buffer so a fee lull can never starve
// gas. Env-tunable (raise toward 20 to be even more conservative).
const LENDER_RESERVE_LAMPORTS = solToLamports(envNum("DIST_FUNDER_LENDER_RESERVE_SOL", 5));
// Safety buffer held in the distribution wallet on top of `payableOwed`.
// CHCAM is funded to (payableOwed + this LEAD buffer). 0.5 SOL keeps the wallet
// comfortably AHEAD of the displayed snapshot so a fresh fee accrual between
// funder ticks can't make the snapshot momentarily exceed the wallet balance
// (the operator's hard invariant). Over-parking is bounded + harmless; the only
// constraint is the lender's 5-SOL gas reserve, above which the funder routes.
const SAFETY_RESERVE_LAMPORTS = solToLamports(envNum("DIST_FUNDER_DIST_RESERVE_SOL", 0.5));
// Don't bother for dust gaps.
const MIN_FUND_LAMPORTS = solToLamports(envNum("DIST_FUNDER_MIN_SOL", 0.02));
// HARD per-tick ceiling, independent of `owed`. The real circuit breaker
// against an inflated/poisoned counter. Operator hand-carried ~6-8 SOL/week.
const MAX_FUND_LAMPORTS = solToLamports(envNum("DIST_FUNDER_MAX_SOL", 8));
// If payableOwed exceeds this, treat as implausible over-accrual: move
// NOTHING and alert. Far above any legitimate weekly liability.
const OWED_SANITY_CEILING_LAMPORTS = solToLamports(envNum("DIST_FUNDER_OWED_CEILING_SOL", 50));
const TX_FEE_HEADROOM = 10_000n;
// In-tick lender-wSOL unwrap floor — only unwrap the lender's fee wSOL ATA
// when it holds at least this much (else the tx fee isn't worth it). Borrow
// fees land as wSOL in the lender's OWN NATIVE_MINT ATA; the hourly
// fee-wallet-sweeper normally unwraps them, but that up-to-1h lag is exactly
// why CHCAM read "short" — the revenue was present, just wrapped + invisible
// to the native-only funder. This funder unwraps in-tick when a gap needs it.
const MIN_INTICK_UNWRAP_LAMPORTS = solToLamports(envNum("DIST_FUNDER_MIN_INTICK_UNWRAP_SOL", 0.05));

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const LENDER_PUBKEY = new PublicKey(
  process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx",
);
const DISTRIBUTION_PUBKEY = new PublicKey(
  process.env.REWARDS_DISTRIBUTOR_PUBKEY ||
    "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac",
);


let _timer = null;
let _running = false; // in-process reentrancy guard
let _lastTickStartedMs = 0; // for the kick's no-double-fund start floor

// ─── Lender keypair (signs the lender→distribution transfer) ──────
function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "[dist-funder] LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing CWD-relative fallback.",
    );
  }
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function isDisabled() {
  const v = (process.env.DIST_FUNDER_DISABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ─── Audit ────────────────────────────────────────────────────────
async function record(row) {
  try {
    await query(
      `INSERT INTO distribution_funding_events
         (outcome, owed_lamports, holder_owed_lamports, lp_owed_lamports,
          protocol_owed_lamports, dist_native_before, dist_wsol_before,
          lender_native_before, reserve_lamports, gap_lamports,
          funded_lamports, destination_pubkey, tx_signature, error_message,
          confirmed_at, notes)
       VALUES ($1,$2::numeric,$3::numeric,$4::numeric,$5::numeric,$6::numeric,
               $7::numeric,$8::numeric,$9::numeric,$10::numeric,$11::numeric,
               $12,$13,$14,$15,$16)`,
      [
        row.outcome,
        String(row.owed ?? 0),
        String(row.holderOwed ?? 0),
        String(row.lpOwed ?? 0),
        String(row.protocolOwed ?? 0),
        String(row.distNative ?? 0),
        String(row.distWsol ?? 0),
        String(row.lenderNative ?? 0),
        String(row.reserve ?? 0),
        String(row.gap ?? 0),
        String(row.funded ?? 0),
        row.destination || DISTRIBUTION_PUBKEY.toBase58(),
        row.txSig || null,
        row.error || null,
        row.confirmedAt || null,
        row.notes || null,
      ],
    );
  } catch (err) {
    console.error("[dist-funder] audit insert failed:", err.message);
  }
}

// ─── Read owed across the reward pools ────────────────────────────
// payableOwed = holder + lp (the two that actually pay out of CHCAM and
// decrement on payout). protocolOwed is reported for the audit row only.
async function readOwed() {
  const one = async (table) => {
    try {
      const { rows } = await query(
        `SELECT COALESCE(accrued_lamports, 0)::text AS amt FROM ${table} WHERE id = 1`,
      );
      return BigInt(rows[0]?.amt || 0);
    } catch {
      return 0n; // table may not exist yet — treat as 0
    }
  };
  const [holderOwed, lpOwed, protocolOwed] = await Promise.all([
    one("magpie_holder_pool"),
    one("lp_loyalty_pool"),
    one("protocol_reserve_pool"),
  ]);
  return { holderOwed, lpOwed, protocolOwed, payableOwed: holderOwed + lpOwed };
}

// ─── Best-effort: unwrap the distribution wallet's own stranded wSOL ──
// Closing the ATA (authority = distributor) unwraps wSOL to the distributor's
// OWN native SOL — no external destination, no drain surface. Skipped silently
// if the distributor key isn't this wallet or the ATA is empty. Outcomes are
// audited so "where did the money go" stays complete.
async function unwrapDistributionWsol(connection) {
  let distKp;
  try {
    distKp = getRewardsDistributorKeypair();
  } catch {
    return 0n;
  }
  if (!distKp.publicKey.equals(DISTRIBUTION_PUBKEY)) {
    return 0n; // distributor in lender-fallback mode — can't sign for CHCAM
  }
  let ata, acct;
  try {
    ata = await getAssociatedTokenAddress(NATIVE_MINT, DISTRIBUTION_PUBKEY, false, TOKEN_PROGRAM_ID);
    acct = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
  } catch {
    return 0n;
  }
  if (acct.amount <= 0n) return 0n;
  const amount = acct.amount;
  let sig = null;
  try {
    const tx = new Transaction();
    tx.add(createCloseAccountInstruction(ata, DISTRIBUTION_PUBKEY, DISTRIBUTION_PUBKEY, [], TOKEN_PROGRAM_ID));
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        DISTRIBUTION_PUBKEY, ata, DISTRIBUTION_PUBKEY, NATIVE_MINT, TOKEN_PROGRAM_ID,
      ),
    );
    const { blockhash, lastValidBlockHeight } = await withFailover((c) => c.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.feePayer = DISTRIBUTION_PUBKEY;
    tx.sign(distKp);
    sig = await withFailover((c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false }));
    await withFailover((c) => c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"));
    console.log(`[dist-funder] unwrapped ${fmt(amount)} wSOL → native (sig ${sig.slice(0, 12)}…)`);
    await record({ outcome: "unwrap_ok", funded: 0n, gap: amount, txSig: sig,
      notes: `unwrapped ${fmt(amount)} wSOL → native in distribution wallet` });
    return amount;
  } catch (err) {
    console.warn(`[dist-funder] wSOL unwrap skipped: ${err.message?.slice(0, 120)}`);
    await record({ outcome: "unwrap_error", funded: 0n, gap: amount, txSig: sig,
      error: err.message?.slice(0, 200) });
    return 0n;
  }
}

// ─── In-tick: unwrap the LENDER's stranded fee wSOL → lender native ──
// Root-cause latency fix. Borrow fees land as wSOL in the lender's OWN
// NATIVE_MINT ATA. The hourly fee-wallet-sweeper unwraps them, but until it
// runs (up to 1h) that revenue is wrapped + invisible to this native-only
// funder, so CHCAM reads "short" even though the protocol HAS the money. When
// a tick finds a gap the lender's native alone can't close, we unwrap the
// lender's fee wSOL HERE so CHCAM tops up within the 5-min funder cadence
// instead of waiting on the hourly sweeper.
//
// SAFETY: lender-OWN-wSOL → lender-OWN-native — no external destination, nets
// the lender POSITIVE (so it never threatens the gas reserve). Runs under the
// SHARED lender lock already held by tickInner (so it can't race the
// fee-wallet-sweeper's close of the same ATA), is guard-simulated with the
// close destination pinned to the lender, and is idempotent (close+reopen — if
// the sweeper already unwrapped, the ATA reads empty and we skip). Audited to
// fee_wallet_sweeps (reason 'funder_intick_unwrap') so the gap-monitor's "last
// sweep" reflects it. Returns lamports unwrapped (0 on skip/error).
async function unwrapLenderFeeWsol(bot, connection, lenderKp) {
  const feeAta = await getAssociatedTokenAddress(NATIVE_MINT, lenderKp.publicKey, false, TOKEN_PROGRAM_ID);
  let wsol = 0n;
  try {
    const acct = await getAccount(connection, feeAta, "confirmed", TOKEN_PROGRAM_ID);
    wsol = acct.amount;
  } catch {
    return 0n; // no fee ATA / unreadable → nothing to unwrap
  }
  if (wsol < MIN_INTICK_UNWRAP_LAMPORTS) return 0n; // dust — not worth a tx fee

  // Audit anchor (best-effort; the close is idempotent so a missing anchor is
  // never a correctness problem — it just means one fewer paper-trail row).
  let sweepId = null;
  try {
    const { rows: [a] } = await query(
      `INSERT INTO fee_wallet_sweeps (source_pubkey, dest_pubkey, amount_lamports, status, reason)
       VALUES ($1, $2, $3::numeric, 'planned', 'funder_intick_unwrap') RETURNING id`,
      [feeAta.toBase58(), lenderKp.publicKey.toBase58(), wsol.toString()],
    );
    sweepId = a.id;
  } catch { /* audit table optional — proceed */ }

  try {
    const tx = new Transaction();
    tx.add(createCloseAccountInstruction(feeAta, lenderKp.publicKey, lenderKp.publicKey, [], TOKEN_PROGRAM_ID));
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        lenderKp.publicKey, feeAta, lenderKp.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
      ),
    );
    const { blockhash, lastValidBlockHeight } = await withFailover((c) => c.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.feePayer = lenderKp.publicKey;
    const guard = await runPrivilegedSign({
      service: "distribution-auto-funder:intick-unwrap",
      tx,
      signers: [lenderKp],
      // The close NETS the lender POSITIVE (wSOL + close rent in; reopen rent +
      // tx fee out). Declare the fee ATA's full token decrease + a tiny lender
      // SOL fee headroom; pin the close destination to the lender itself.
      allowedDeltas: [
        { pubkey: feeAta, kind: "token", mint: NATIVE_MINT, maxDecrease: wsol },
        { pubkey: lenderKp.publicKey, kind: "sol", maxDecrease: 10_000n },
      ],
      allowedCloseDestinations: [lenderKp.publicKey],
    });
    const sig = await withFailover((c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false }));
    await withFailover((c) => c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"));
    await recordPrivilegedSignResult({ auditId: guard.auditId, status: "confirmed", txSig: sig });
    if (sweepId) {
      await query(
        `UPDATE fee_wallet_sweeps SET status = 'confirmed', tx_signature = $2, updated_at = NOW() WHERE id = $1`,
        [sweepId, sig],
      ).catch(() => {});
    }
    console.log(`[dist-funder] in-tick unwrapped ${fmt(wsol)} lender wSOL → native (sig ${sig.slice(0, 12)}…)`);
    return wsol;
  } catch (err) {
    if (sweepId) {
      await query(
        `UPDATE fee_wallet_sweeps SET status = 'failed', err = $2, updated_at = NOW() WHERE id = $1`,
        [sweepId, err.message?.slice(0, 200)],
      ).catch(() => {});
    }
    console.warn(`[dist-funder] in-tick lender unwrap skipped: ${err.message?.slice(0, 120)}`);
    return 0n;
  }
}

// ─── One tick ─────────────────────────────────────────────────────
async function tick(bot, opts = {}) {
  if (_running) return; // in-process reentrancy guard
  // NO-DOUBLE-FUND START FLOOR: never START two ticks closer than the interval
  // floor (3 min > a blockhash's ~90s validity). The scheduled timer is
  // already 5 min so it never trips this; the guard exists for event KICKS,
  // which could otherwise fire a tick seconds after a funding broadcast —
  // before the prior tx lands — and double-fund. Gating tick START preserves
  // the no-double-fund invariant for EVERY trigger, not just the timer.
  if (opts.source === "kick" && Date.now() - _lastTickStartedMs < INTERVAL_FLOOR_MS) {
    return; // too soon after the last tick — the scheduled tick covers it
  }
  _running = true;
  _lastTickStartedMs = Date.now();
  try {
    if (isDisabled()) {
      await record({ outcome: "skip_disabled", notes: "DIST_FUNDER_DISABLED set" });
      return;
    }
    if (!process.env.LENDER_PRIVATE_KEY && !process.env.LENDER_KEYPAIR_PATH) {
      await record({ outcome: "skip_disabled", notes: "no lender key configured" });
      return;
    }
    // ONE shared lender-spend lock across EVERY 4JSS-signing service (funder,
    // fee-wallet-sweeper, x402-fee-sweeper, …) so at most one lender-spending
    // tx is ever in flight and the 5-SOL gas reserve holds ACROSS writers, not
    // just per-tick. The lock helper owns the session-pinned-client +
    // evict-on-unlock-failure discipline that used to live here.
    const locked = await withLenderSpendLock(() => tickInner(bot));
    if (locked.skipped) {
      await record({ outcome: "skip_locked", notes: `shared lender lock: ${locked.reason}` });
    }
  } finally {
    _running = false;
  }
}

async function tickInner(bot) {
  const connection = new Connection(RPC_URL, "confirmed");

  // 1. Payable reward liability via the ONE canonical helper (holder + LP
  //    third-party-NET; protocol reserve excluded) so DISPLAY == MONITORED ==
  //    FUNDED — the funded native exactly matches the stats "allotted" figure.
  const { holderOwed, lpOwed, protocolOwed, payableOwed } = await readPayableOwed();

  const baseRow = {
    owed: payableOwed, holderOwed, lpOwed, protocolOwed,
    reserve: SAFETY_RESERVE_LAMPORTS, destination: DISTRIBUTION_PUBKEY.toBase58(),
  };

  // 1b. Plausibility gate — implausible owed means over-accrual / poisoning.
  if (payableOwed > OWED_SANITY_CEILING_LAMPORTS) {
    await record({ ...baseRow, outcome: "skip_owed_implausible", gap: 0n,
      notes: `payableOwed=${fmt(payableOwed)} > ceiling ${fmt(OWED_SANITY_CEILING_LAMPORTS)} — NO movement` });
    await alertImplausibleOwed(bot, { payableOwed, holderOwed, lpOwed });
    return;
  }

  // 2. Make stranded distribution-wallet wSOL spendable (best-effort, audited).
  await unwrapDistributionWsol(connection).catch(() => 0n);

  // 3. Live balances.
  const distNative = BigInt(await withFailover((c) => c.getBalance(DISTRIBUTION_PUBKEY, "confirmed")));
  let distWsol = 0n;
  try {
    const ata = await getAssociatedTokenAddress(NATIVE_MINT, DISTRIBUTION_PUBKEY, false, TOKEN_PROGRAM_ID);
    const acct = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    distWsol = acct.amount;
  } catch { /* no ATA */ }
  const lenderNative = BigInt(await withFailover((c) => c.getBalance(LENDER_PUBKEY, "confirmed")));

  const target = payableOwed + SAFETY_RESERVE_LAMPORTS;
  const gap = target > distNative ? target - distNative : 0n;
  Object.assign(baseRow, { distNative, distWsol, lenderNative, gap });

  // 4. No gap → already covered.
  if (gap < MIN_FUND_LAMPORTS) {
    await record({ ...baseRow, outcome: "skip_no_gap",
      notes: `dist=${fmt(distNative)} >= owed+reserve=${fmt(target)} (gap ${fmt(gap)} < min)` });
    return;
  }

  // 5. Load the lender key now — needed both for the in-tick wSOL unwrap and
  //    the funding transfer.
  let lenderKp;
  try {
    lenderKp = loadLenderKeypair();
  } catch (e) {
    await record({ ...baseRow, outcome: "sim_reject", funded: 0n,
      error: `lender key load failed: ${e.message?.slice(0, 160)}` });
    return;
  }
  if (!lenderKp.publicKey.equals(LENDER_PUBKEY)) {
    await record({ ...baseRow, outcome: "sim_reject", funded: 0n,
      error: `lender key ${lenderKp.publicKey.toBase58().slice(0, 10)}… ≠ ${LENDER_PUBKEY.toBase58().slice(0, 10)}…` });
    return;
  }

  // 6. What the lender can safely provide right now — via the shared helper,
  //    which subtracts the canonical 5-SOL reserve AND every UNCONFIRMED
  //    in-flight lender spend (so a sibling service's in-flight tx can't push
  //    4JSS below the gas floor). Fails CLOSED (0) if the read is uncertain.
  let lenderAvail = await availableLenderNative(connection);

  // 6b. IN-TICK LENDER wSOL UNWRAP — if the lender's NATIVE alone can't close
  //     the gap, the missing revenue is most likely sitting as wSOL in the
  //     lender's fee ATA that the hourly sweeper hasn't unwrapped yet. Unwrap
  //     it NOW (under the shared lock we already hold) so CHCAM tops up this
  //     5-min cadence instead of waiting ≤1h. Fires ONLY when actually needed
  //     (lender native can't cover the gap) and the wSOL is material.
  if (lenderAvail < gap) {
    const unwrapped = await unwrapLenderFeeWsol(bot, connection, lenderKp).catch(() => 0n);
    if (unwrapped > 0n) {
      lenderAvail = await availableLenderNative(connection); // re-read post-unwrap
      baseRow.lenderNative = BigInt(await withFailover((c) => c.getBalance(LENDER_PUBKEY, "confirmed")));
    }
  }

  if (lenderAvail < MIN_FUND_LAMPORTS) {
    await record({ ...baseRow, outcome: "skip_lender_low",
      notes: `lenderAvail=${fmt(lenderAvail)} < min; gap=${fmt(gap)} unmet (after in-tick unwrap attempt)` });
    await alertLenderLow(bot, { gap, lenderNative: baseRow.lenderNative, owed: payableOwed });
    return;
  }

  // 7. fundAmount = min(gap, lenderAvail, HARD CEILING). The ceiling is the
  //    real bound — independent of `owed` — so no counter value can move more
  //    than MAX_FUND per tick even if everything else is wrong.
  let fundAmount = gap;
  if (lenderAvail < fundAmount) fundAmount = lenderAvail;
  if (MAX_FUND_LAMPORTS < fundAmount) fundAmount = MAX_FUND_LAMPORTS;

  try {
    assertAllowedDestination("distribution-auto-funder", DISTRIBUTION_PUBKEY);
  } catch (e) {
    await record({ ...baseRow, outcome: "sim_reject", funded: 0n,
      error: e.message?.slice(0, 200), notes: "destination not on allowlist" });
    return;
  }

  const { blockhash, lastValidBlockHeight } = await withFailover((c) => c.getLatestBlockhash("confirmed"));
  const tx = new Transaction({ feePayer: LENDER_PUBKEY, blockhash, lastValidBlockHeight });
  tx.add(SystemProgram.transfer({ fromPubkey: LENDER_PUBKEY, toPubkey: DISTRIBUTION_PUBKEY, lamports: fundAmount }));

  // Guard: maxDecrease is bounded by fundAmount which is itself ≤ MAX_FUND.
  let guard;
  try {
    guard = await runPrivilegedSign({
      service: "distribution-auto-funder",
      tx,
      signers: [lenderKp],
      allowedDeltas: [{ pubkey: LENDER_PUBKEY, kind: "sol", maxDecrease: fundAmount + TX_FEE_HEADROOM + 5_000n }],
    });
  } catch (e) {
    await record({ ...baseRow, outcome: "sim_reject", funded: 0n, error: e.message?.slice(0, 200) });
    return;
  }
  const auditId = guard.auditId;

  let sig;
  try {
    sig = await withFailover((c) =>
      c.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" }),
    );
  } catch (e) {
    await recordPrivilegedSignResult({ auditId, status: "failed", error: e.message?.slice(0, 200) });
    await record({ ...baseRow, outcome: "send_error", funded: 0n, error: e.message?.slice(0, 200) });
    return;
  }
  await recordPrivilegedSignResult({ auditId, status: "broadcast", txSig: sig });

  // Confirm. We write EXACTLY ONE terminal audit row (no anchor row) so
  // SUM(funded_lamports) is always exact. A confirm-timeout does ONE
  // best-effort, history-aware status check for audit accuracy — never a
  // persistent in-flight marker (that earlier design silently halted the
  // funder). Either way the NEXT tick's gap, read from the live 'confirmed'
  // balance, is self-correcting: a landed tx already raised distNative (gap
  // shrinks → no re-fund); an expired tx (blockhash dead, ~90s) is safe to
  // re-fund. The 3-min interval floor guarantees the prior tx is resolved
  // on-chain before the next tick runs, so there is no re-send window.
  try {
    await withFailover((c) =>
      c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"),
    );
  } catch (e) {
    let landed = false;
    try {
      const r = await withFailover((c) => c.getSignatureStatuses([sig], { searchTransactionHistory: true }));
      const st = r?.value?.[0];
      landed = !!(st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"));
    } catch { /* status unknown */ }
    if (landed) {
      await recordPrivilegedSignResult({ auditId, status: "confirmed", txSig: sig });
      await record({ ...baseRow, outcome: "success", funded: fundAmount, txSig: sig, confirmedAt: new Date(),
        notes: "confirmed after initial timeout" });
    } else {
      await recordPrivilegedSignResult({ auditId, status: "broadcast", txSig: sig, error: `confirm-timeout: ${e.message?.slice(0, 120)}` });
      await record({ ...baseRow, outcome: "broadcast_timeout", funded: 0n, txSig: sig,
        notes: "confirm timed out; status unknown — next tick's gap (live balance) self-corrects" });
      console.warn(`[dist-funder] confirm timeout on ${sig.slice(0, 12)}… — recorded broadcast_timeout; gap self-corrects next tick`);
    }
    return;
  }
  await recordPrivilegedSignResult({ auditId, status: "confirmed", txSig: sig });
  await record({ ...baseRow, outcome: "success", funded: fundAmount, txSig: sig, confirmedAt: new Date(),
    notes: fundAmount < gap ? `partial: gap ${fmt(gap)}, capped by ${lenderAvail < gap ? "lender" : "per-tick ceiling"}` : "gap fully funded" });

  console.log(
    `[dist-funder] funded ${fmt(fundAmount)} SOL lender → distribution (gap ${fmt(gap)}, owed ${fmt(payableOwed)}, sig ${sig.slice(0, 12)}…)`,
  );

  try {
    await notifyAdmin(
      bot,
      `💸 *Distribution auto-funded*\n\n` +
        `Moved \`${fmt(fundAmount)}\` SOL: lender wallet → rewards distribution wallet.\n\n` +
        `• Payable owed (holder+LP): \`${fmt(payableOwed)}\` SOL` +
        ` (holder \`${fmt(holderOwed)}\`, LP \`${fmt(lpOwed)}\`)\n` +
        `• Distribution before: \`${fmt(distNative)}\` → after ~\`${fmt(distNative + fundAmount)}\` SOL\n` +
        `• Lender reserve kept: \`${fmt(LENDER_RESERVE_LAMPORTS)}\` SOL\n` +
        (fundAmount < gap
          ? `\n⚠️ Partial — ${lenderAvail < gap ? "lender-limited" : "per-tick ceiling"}. Remaining gap \`${fmt(gap - fundAmount)}\` SOL; will continue next tick.\n`
          : ``) +
        `\n_No manual funding needed. Halt anytime: DIST_FUNDER_DISABLED=true._`,
      { parse_mode: "Markdown" },
    );
  } catch { /* DM best-effort */ }
}

let _lastLenderLowAlert = 0;
async function alertLenderLow(bot, { gap, lenderNative, owed }) {
  if (Date.now() - _lastLenderLowAlert < 6 * 60 * 60 * 1000) return;
  _lastLenderLowAlert = Date.now();
  try {
    await notifyAdmin(
      bot,
      `🟠 *Distribution funding: lender low*\n\n` +
        `Distribution wallet is short \`${fmt(gap)}\` SOL but the lender wallet ` +
        `(\`${fmt(lenderNative)}\` SOL) is at/below its operational reserve.\n\n` +
        `Payable owed (holder+LP): \`${fmt(owed)}\` SOL.\n\n` +
        `This means the protocol's REAL collected fee revenue is below the accrued ` +
        `obligation right now — either fees simply haven't accumulated yet (the funder ` +
        `catches up on the next inflow) or the accrual over-credited. *Do NOT add personal funds* — investigate first.`,
      { parse_mode: "Markdown" },
    );
  } catch { /* best-effort */ }
}

let _lastImplausibleAlert = 0;
async function alertImplausibleOwed(bot, { payableOwed, holderOwed, lpOwed }) {
  if (Date.now() - _lastImplausibleAlert < 60 * 60 * 1000) return;
  _lastImplausibleAlert = Date.now();
  try {
    await notifyAdmin(
      bot,
      `🚨 *Distribution funder HALTED — implausible owed*\n\n` +
        `payableOwed = \`${fmt(payableOwed)}\` SOL exceeds the sanity ceiling ` +
        `(\`${fmt(OWED_SANITY_CEILING_LAMPORTS)}\` SOL). The funder moved NOTHING.\n\n` +
        `holder \`${fmt(holderOwed)}\`, LP \`${fmt(lpOwed)}\`. This usually means a pool ` +
        `counter was over-accrued (a non-idempotent credit, missed payout decrement, or ` +
        `bad x402/recovery accrual). Investigate the pool ledgers before raising ` +
        `DIST_FUNDER_OWED_CEILING_SOL.`,
      { parse_mode: "Markdown" },
    );
  } catch { /* best-effort */ }
}

function fmt(lamports) {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}

// ─── Start ────────────────────────────────────────────────────────
export function startDistributionAutoFunder(bot) {
  if (_timer) return;
  if (isDisabled()) {
    console.log("[dist-funder] DISABLED via DIST_FUNDER_DISABLED — not starting");
    return;
  }
  setTimeout(() => {
    tick(bot).catch((e) => console.warn(`[dist-funder] first tick: ${e.message?.slice(0, 160)}`));
    _timer = setInterval(() => {
      tick(bot).catch((e) => console.warn(`[dist-funder] tick: ${e.message?.slice(0, 160)}`));
    }, INTERVAL_MS);
  }, FIRST_RUN_MS);
  console.log(
    `[dist-funder] armed — first run in ${FIRST_RUN_MS / 60_000}min, then every ${INTERVAL_MS / 60_000}min ` +
      `(lender reserve ${fmt(LENDER_RESERVE_LAMPORTS)} SOL, per-tick ceiling ${fmt(MAX_FUND_LAMPORTS)} SOL)`,
  );
}

export function stopDistributionAutoFunder() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Event-driven nudge — fire an immediate, out-of-band funder tick (e.g. the
 * gap-monitor's self-heal when it spots a gap between scheduled ticks). This
 * is what turns the funder from "every 5 min" into "tops up within seconds of
 * a detected gap" without coupling to the hot loan/fee-accrual path.
 *
 * FULLY SAFE TO CALL FROM ANYWHERE, AT ANY RATE:
 *   • fire-and-forget — never awaits, never throws into the caller.
 *   • the tick-start floor in tick() guarantees a kick can NEVER run a tick
 *     within INTERVAL_FLOOR_MS (3 min) of the prior one, so the no-double-fund
 *     invariant holds no matter how often this is called.
 *   • the in-process reentrancy guard + shared lender lock still serialize it
 *     against the scheduled tick and every other lender-spending service.
 */
export function kickDistributionFunder(bot, reason = "kick") {
  if (isDisabled()) return;
  setTimeout(() => {
    tick(bot, { source: "kick" }).catch((e) =>
      console.warn(`[dist-funder] kick(${reason}) tick: ${e.message?.slice(0, 140)}`),
    );
  }, 0);
}

// ─── Status (for admin command / observability) ───────────────────
export async function getDistributionFunderStatus() {
  const connection = new Connection(RPC_URL, "confirmed");
  // Use the SAME canonical owed source the funding path uses so the status
  // readout never shows a higher (gross) figure than what actually gets funded.
  const { holderOwed, lpOwed, protocolOwed, payableOwed } = await readPayableOwed().catch(() => ({
    holderOwed: 0n, lpOwed: 0n, protocolOwed: 0n, payableOwed: 0n,
  }));
  const [distNative, distWsol, lenderNative, lenderAvail, recent] = await Promise.all([
    connection.getBalance(DISTRIBUTION_PUBKEY, "confirmed").then(BigInt).catch(() => null),
    getAssociatedTokenAddress(NATIVE_MINT, DISTRIBUTION_PUBKEY, false, TOKEN_PROGRAM_ID)
      .then((ata) => getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID))
      .then((a) => a.amount).catch(() => 0n),
    connection.getBalance(LENDER_PUBKEY, "confirmed").then(BigInt).catch(() => null),
    availableLenderNative(connection).catch(() => null),
    query(
      `SELECT id, outcome, initiated_at, funded_lamports::text AS funded,
              gap_lamports::text AS gap, tx_signature, notes, error_message
         FROM distribution_funding_events
        ORDER BY initiated_at DESC LIMIT 10`,
    ).catch(() => ({ rows: [] })),
  ]);
  const target = payableOwed + SAFETY_RESERVE_LAMPORTS;
  // CHCAM "spendable" = native + any wSOL (the funder unwraps CHCAM's own wSOL
  // in-tick, so it's effectively spendable). Gap is measured against native —
  // the conservative figure the funder actually targets.
  const spendable = distNative == null ? null : distNative + distWsol;
  const gapLamports = distNative == null ? null : (target > distNative ? target - distNative : 0n);

  // VERDICT — the whole point of surfacing this: a transient lag must NOT read
  // as a "shortfall" the operator hand-funds. Classify it honestly:
  //   • paused        — funder disabled
  //   • healthy       — CHCAM already covers owed+reserve
  //   • catching_up   — a gap exists BUT the lender can cover it → the funder
  //                     auto-tops-up within ~5 min; do NOT hand-fund.
  //   • lender_limited— a gap exists AND the lender can't cover it → real fee
  //                     revenue is below the accrued obligation; investigate,
  //                     still do NOT hand-fund.
  let verdict = "unknown";
  if (isDisabled()) verdict = "paused";
  else if (gapLamports == null) verdict = "unknown";
  else if (gapLamports < MIN_FUND_LAMPORTS) verdict = "healthy";
  else if (lenderAvail != null && lenderAvail >= gapLamports) verdict = "catching_up";
  else verdict = "lender_limited";

  return {
    disabled: isDisabled(),
    interval_min: INTERVAL_MS / 60_000,
    verdict,
    payable_owed_sol: Number(payableOwed) / LAMPORTS_PER_SOL,
    holder_owed_sol: Number(holderOwed) / LAMPORTS_PER_SOL,
    lp_owed_sol: Number(lpOwed) / LAMPORTS_PER_SOL,
    protocol_reserve_owed_sol: Number(protocolOwed) / LAMPORTS_PER_SOL, // excluded from gap
    distribution_native_sol: distNative == null ? null : Number(distNative) / LAMPORTS_PER_SOL,
    distribution_wsol_sol: Number(distWsol) / LAMPORTS_PER_SOL,
    distribution_spendable_sol: spendable == null ? null : Number(spendable) / LAMPORTS_PER_SOL,
    lender_native_sol: lenderNative == null ? null : Number(lenderNative) / LAMPORTS_PER_SOL,
    lender_available_sol: lenderAvail == null ? null : Number(lenderAvail) / LAMPORTS_PER_SOL,
    current_gap_sol: gapLamports == null ? null : Number(gapLamports) / LAMPORTS_PER_SOL,
    lender_reserve_sol: Number(LENDER_RESERVE_LAMPORTS) / LAMPORTS_PER_SOL,
    per_tick_ceiling_sol: Number(MAX_FUND_LAMPORTS) / LAMPORTS_PER_SOL,
    recent: recent.rows,
  };
}
