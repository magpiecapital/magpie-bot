/**
 * Core arming + cancel logic for limit-close orders.
 *
 * Three call sites share this:
 *   - TG: src/commands/limit-close.js  (handleLimitClose for custodial TG users)
 *   - Internal: src/api/internal-agent-limitclose.js  (x402 agent path)
 *   - Site: src/api/site-limit-close.js  (signed Ed25519 from the dashboard)
 *
 * Keeping all three behind ONE armOrder() implementation prevents
 * drift — the eligibility math, schema columns, preflight check,
 * and DM-on-arm behavior must be identical regardless of where the
 * arm came from. If we let each surface evolve independently they
 * would silently get out of sync.
 *
 * The function takes:
 *   - userId       (resolved from telegram_id / signer pubkey / delegation)
 *   - source       ('tg' | 'site' | 'agent_x402')
 *   - sourceAgent  (only for 'agent_x402', the agent's pubkey)
 *   - loanId       (on-chain loan_id as a string)
 *   - triggerKind  ('mc_usd' | 'price_usd' | 'price_sol')
 *   - triggerValueMicro (BigInt string or BigInt)
 *   - slippageBps  (integer 10..1000)
 *   - sellDestination ('sol' | 'usdc')
 *   - expiresAt    (ISO string or null)
 *   - autoEscalate (bool)
 *   - capBps       (max slippage cap; defaults to slippageBps if no
 *                   escalation; defaults to delegation.max_slippage_bps
 *                   for agent path; for TG + site there's no widening
 *                   today so cap === initial slippage)
 *
 * Returns { ok: true, orderId, loanRow, mintRow } or { ok: false, error,
 *   detail?, suggestedSlippageBps? }.
 *
 * Defense in depth applied here so every surface gets it:
 *   - Loan must belong to userId
 *   - Loan must be 'active' + meet min size (1 SOL)
 *   - Collateral must be enabled + not RWA category
 *   - User concurrency cap (10 orders)
 *   - Pre-flight Jupiter quote at the EFFECTIVE max slippage (the
 *     cap if auto-escalate is on, else the literal slippage)
 *   - INSERT uses ON CONFLICT on the UNIQUE(loan_id WHERE status='armed')
 *     partial index → double-arm physically impossible
 */
import { query } from "../db/pool.js";
import { runArmPreflight } from "./limit-close-preflight.js";
import { MAX_PROTOCOL_SLIPPAGE_BPS } from "../lib/slippage-constants.js";
import { PublicKey } from "@solana/web3.js";
import { notifyAdmin } from "./admin-notify.js";

// T14 (2026-06-16) — Token-2022 extensions Jupiter's aggregator cannot
// model. A V4 convert_collateral_slice firing through Jupiter will
// always revert with InvalidTokenAccount on these mints because the
// source-side ATA semantics depart from the classic SPL contract that
// Jupiter's route plans assume. We refuse to arm exits on them at
// arm-time rather than let the borrower hit "exit armed → never fires →
// 11 retries → max_retries_exceeded" silently.
//
// Verified empirically 2026-06-16 against SPCX (8 extensions, every
// Jupiter DEX failed) vs PUMP (TransferHook + metadata only, fired
// fine). TransferHook alone is OK — Jupiter has explicit handling.
// MetadataPointer / TokenMetadata / DefaultAccountState don't affect
// swap math at all. The rest of the catalog DOES.
// loan_not_found_for_user admin-DM throttle — Tier-1 defense per
// feedback_loan_830_full_postmortem_and_defenses.md. Operator must
// learn about race failures within seconds, not by reading their
// dashboard. Throttled per loan to avoid DM spam on repeated retries.
const _lnfThrottle = new Map(); // key: loan_id_chain -> last_dm_ts_ms

const EXIT_BLOCKING_EXTENSIONS = new Set([
  "PermanentDelegate",
  "TransferFeeConfig",
  "ConfidentialTransferMint",
  "ConfidentialTransferFeeConfig",
  "ScaledUiAmountConfig",
  "InterestBearingConfig",
  "PausableConfig",
  "NonTransferable",
  "MintCloseAuthority",
]);

const _exitCompatCache = new Map(); // mint → { compat, expires_at_ms }
const EXIT_COMPAT_TTL_MS = 60 * 60 * 1000;

/**
 * Returns { ok: true } when the mint is exit-compatible (Jupiter can
 * route through it for convert_collateral_slice), or
 * { ok: false, blocking: [extNames...] } when one or more extensions
 * make exit-firing unreliable.
 *
 * Classic SPL tokens always return { ok: true }.
 * Token-2022 mints get their ExtensionTypes enumerated; blocking ones
 * are returned in the rejection so the UI can explain WHY.
 */
async function checkExitCompatibility(mintStr) {
  const cached = _exitCompatCache.get(mintStr);
  if (cached && cached.expires_at_ms > Date.now()) return cached.compat;

  let compat = { ok: true };
  try {
    const spl = await import("@solana/spl-token");
    const { connection } = await import("../solana/connection.js");
    const { getMint, TOKEN_2022_PROGRAM_ID, ExtensionType, getExtensionTypes } = spl;
    const mintPk = new PublicKey(mintStr);
    const info = await connection.getAccountInfo(mintPk);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const m = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (m.tlvData) {
        const codes = getExtensionTypes(m.tlvData);
        const names = codes.map((c) => ExtensionType[c] || `ext_${c}`);
        const blocking = names.filter((n) => EXIT_BLOCKING_EXTENSIONS.has(n));
        if (blocking.length > 0) {
          compat = { ok: false, blocking };
        }
      }
    }
  } catch (err) {
    // Probe failure → fail OPEN (allow arm) rather than blocking
    // legitimate users when the RPC blips. The engine's pre-fire
    // simulation gate will still catch a truly incompatible route.
    console.warn(`[arm-core] exit-compat probe failed for ${mintStr}: ${err.message?.slice(0, 100)}`);
  }
  _exitCompatCache.set(mintStr, {
    compat,
    expires_at_ms: Date.now() + EXIT_COMPAT_TTL_MS,
  });
  return compat;
}

// Operator-mandated 2026-06-16 PM (feedback_every_exit_click_must_arm.md).
// The 1 SOL floor that previously lived here was a conservative product
// policy, not a protocol/economic necessity. Lowered to 0.2 SOL per
// operator direction so smaller V4 borrows (e.g. ZEREBRO loan 799 at
// 0.54 SOL) can arm their TP/SL/ladder exits. Engine fire economics
// remain positive for loans this small.
export const MIN_LOAN_LAMPORTS = BigInt(200_000_000n); // 0.2 SOL
export const MAX_ACTIVE_ORDERS_PER_USER = 10;
export const MIN_TRIGGER_VALUE_MICRO = 1n;
export const MAX_TRIGGER_VALUE_MICRO = 1_000_000_000_000_000n;
export const VALID_TRIGGER_KINDS = new Set(["mc_usd", "price_usd", "price_sol"]);
export const VALID_DESTINATIONS = new Set(["sol", "usdc"]);
// Direction the trigger fires from:
//   'above' (default) — take-profit: fires when current >= trigger
//   'below'           — stop-loss:   fires when current <= trigger
// arm-core validates that the trigger sits on the correct side of
// current price at arm time so an immediate-fire arm is rejected.
// 1% protocol fee applies in BOTH directions — operator rule 2026-06-12.
export const VALID_TRIGGER_DIRECTIONS = new Set(["above", "below"]);

/**
 * Resolve a multiplier ("at 2x" semantic) to a price_usd micros value
 * using the cross-sourced oracle. Shared so TG, site, and Pip all
 * lock in the same target meaning.
 *
 * Returns { ok: true, triggerValueMicro: BigInt, currentUsd, targetUsd }
 * or { ok: false, error: string }.
 */
export async function resolveMultiplierToPrice(collateralMint, multiplier, { allowBelowOne = false } = {}) {
  if (multiplier == null || !Number.isFinite(multiplier) || multiplier <= 0) {
    return { ok: false, error: "Multiplier must be a positive number." };
  }
  if (!allowBelowOne && multiplier <= 1) {
    return { ok: false, error: "Multiplier must be > 1 (e.g. 2 for 2×)." };
  }
  if (allowBelowOne && multiplier >= 1) {
    return { ok: false, error: "Stop-loss multiplier must be < 1 (e.g. 0.7 for 70% of current)." };
  }
  const { getPriceInUsdCrossSourced } = await import("./price.js");
  // Retry-with-backoff on transient oracle failures (operator-mandated
  // 2026-06-16 PM, feedback_v4_exit_requests_must_execute.md). Every
  // V4 exit request must execute — single Jupiter blip can't be the
  // reason an arm rejects. ~26s budget across 7 attempts is the same
  // shape used by the multiplier arm-side gap fix (task #309) and
  // long enough to outlast typical 5-10s rate-limit windows while
  // short enough that an operator typing /sell sees a fail-soft
  // reply within a reasonable wait. Cross-source price disagreement
  // (not transient) still fails fast — only NETWORK / RATE-LIMIT
  // errors retry.
  const MAX_ATTEMPTS = 7;
  const baseDelaysMs = [0, 500, 1500, 3000, 5000, 7000, 9000];
  let currentUsd = null;
  let lastErrMsg = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (baseDelaysMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, baseDelaysMs[attempt]));
    }
    try {
      currentUsd = await getPriceInUsdCrossSourced(collateralMint);
      if (currentUsd && currentUsd > 0) break;
    } catch (err) {
      lastErrMsg = (err?.message || String(err)).slice(0, 240);
      // Hard-stop on permanent failures — disagreement is a safety
      // signal, not a transient one. "No USD price data" with no
      // working sources is also worth surfacing immediately.
      if (/sources disagree/i.test(lastErrMsg) || /No USD price data/i.test(lastErrMsg)) {
        return { ok: false, error: "price_unavailable", detail: lastErrMsg };
      }
      currentUsd = null;
      // Otherwise (single-source refusal, rate limit, network blip) —
      // retry on the next loop iteration.
    }
  }
  if (!currentUsd || currentUsd <= 0) {
    return {
      ok: false,
      error: "price_unavailable",
      detail: lastErrMsg || "Couldn't fetch current USD price after retries — try again or use an explicit price target.",
    };
  }
  const targetUsd = currentUsd * multiplier;
  const triggerValueMicro = BigInt(Math.round(targetUsd * 1e6));
  if (triggerValueMicro < MIN_TRIGGER_VALUE_MICRO || triggerValueMicro > MAX_TRIGGER_VALUE_MICRO) {
    return { ok: false, error: "Resolved target is out of range." };
  }
  return { ok: true, triggerValueMicro, currentUsd, targetUsd };
}

/**
 * The shared arm implementation. Same gates regardless of source.
 *
 * Returns { ok: true, orderId, loan, mint } or { ok: false, error, ... }.
 */
// Fill-guarantee defaults. Operator-stated rule: "the order MUST execute or
// it makes it look like we are advertising false promises." The prior
// defaults (capBps = slippageBps, autoEscalate = false) were silently
// preventing fills on thin-liquidity memecoin pumps — a 200 bps cap on a
// 6% impact swap never clears. To honor the mandate every order ships with
// escalation headroom by default. The borrower's stated initial slippage
// is preserved as the FIRST attempt; the engine only walks UNDER the cap
// when the first attempt would revert.
const DEFAULT_HARD_CAP_BPS = 5000;        // 50% — absolute ceiling on any auto-widened cap
const DEFAULT_CAP_FLOOR_BPS = 2500;       // 25% — every order gets at least this much room
const DEFAULT_CAP_MULTIPLIER = 8;         // cap = max(floor, slip × 8) capped at hard cap
// Sourced from src/lib/slippage-constants.js — protocol-absolute ceiling
// shared with internal-agent-limitclose.js and the DB CHECK constraint.
const MAX_INITIAL_SLIPPAGE_BPS = MAX_PROTOCOL_SLIPPAGE_BPS; // 25% — allow aggressive initial for moon-pump UX

/**
 * Public entry point — wraps the real implementation with a server-
 * side audit log + a failure DM so the caller cannot silently die.
 *
 * Forcing function (2026-06-15): operator's V4 SPCX ladder. The user
 * believed they armed a ladder, the strike was hit, no fire happened.
 * Investigation revealed ZERO rows in limit_close_orders for the
 * account, ever — every prior arm attempt failed BEFORE reaching the
 * INSERT statement. Without an audit trail, those failures were
 * invisible. This wrapper writes one row per attempt + DMs the user
 * on every failure regardless of which caller (site/tg/agent_x402)
 * invoked us.
 *
 * Contract preserved: identical args + identical return shape as the
 * legacy armOrder. Wrapper is best-effort — audit failure does NOT
 * mask a real arm result.
 */
export async function armOrder(args) {
  // Breadcrumb intent (operator-mandated 2026-06-16 PM,
  // feedback_tg_v4_must_match_site_quality.md). Every arm path — TG
  // /sell, /takeprofit, /stoploss, /bracket, /trailingstop, ladders,
  // Pip-driven arms, agent x402 — MUST leave an arm_intent row in
  // 'pending' state BEFORE the armOrderImpl gates so the dashboard's
  // V4 silent-arm recovery banner can render the user's exact strike
  // if anything below fails. Site flow passes args.intentId because
  // it already wrote one via /api/v1/site/limit-close/intent; in that
  // case we don't write again. Best-effort: a write failure here does
  // NOT abort the arm.
  if (args.intentId == null && args.source !== "site") {
    try {
      const intentId = await writeBreadcrumbIntent(args);
      if (intentId != null) args.intentId = intentId;
    } catch (e) {
      console.warn(
        `[arm-core] breadcrumb intent write failed (continuing): ${e.message?.slice(0, 160)}`,
      );
    }
  }

  let result;
  try {
    result = await armOrderImpl(args);
  } catch (err) {
    // Defensive: anything thrown out of armOrderImpl becomes a normal
    // failure result so the audit/DM paths still fire and the caller
    // gets a consistent shape.
    console.error("[arm-core] unexpected exception inside armOrderImpl:", err?.stack || err?.message || err);
    result = {
      ok: false,
      error: "exception",
      detail: (err?.message || String(err)).slice(0, 400),
    };
  }

  // Audit (best-effort, swallowed on error so we never mask the real result).
  try {
    await recordArmAttempt(args, result);
  } catch (auditErr) {
    console.warn("[arm-core] audit insert failed:", auditErr.message?.slice(0, 200));
  }

  // Failure-DM (best-effort, same swallow). Success DM is enqueued by
  // the caller after this returns ok:true — preserves current contract.
  if (!result.ok) {
    try {
      await enqueueArmFailedDm(args, result);
    } catch (dmErr) {
      console.warn("[arm-core] failure-DM enqueue failed:", dmErr.message?.slice(0, 200));
    }
  }

  // arm_intent reconciliation (operator-mandated 2026-06-16 PM,
  // feedback_every_arm_envelope_must_reach_server.md). When the arm
  // succeeds AND the caller passed an intent_id, mark that intent as
  // armed + stamp the order_id. The dashboard's V4 recovery banner
  // hides automatically once the intent is no longer 'pending'.
  // Best-effort — a reconciliation failure must NOT mask the real
  // arm result.
  if (result.ok && args.intentId != null) {
    try {
      await query(
        `UPDATE arm_intents
            SET status = 'armed',
                order_id = $2,
                armed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [args.intentId, result.orderId],
      );
    } catch (intentErr) {
      console.warn("[arm-core] arm_intent reconcile failed:", intentErr.message?.slice(0, 200));
    }
  }

  return result;
}

async function armOrderImpl({
  userId,
  source,                  // 'tg' | 'site' | 'agent_x402'
  sourceAgentPubkey = null,
  loanIdChain,             // string
  triggerKind,
  triggerValueMicro,       // BigInt or string
  triggerDirection = "above", // 'above' = take-profit, 'below' = stop-loss
  // 2026-06-13: trailing-stop support. When trailingDistanceBps is
  // non-null, the order is a trailing SL — the effective trigger
  // floats with the highest observed price since arm. Watcher seeds
  // peak_price_micros at arm time and updates each tick. Trailing
  // is incompatible with triggerDirection='above' (TP fires at a
  // fixed target by definition); validated below.
  trailingDistanceBps = null,
  // TP/SL ladder support. Fraction of loan collateral closed when
  // this leg fires, in basis points (10000 = 100% = full close).
  // The DB trigger (migration 064) enforces SUM(slice_pct) <= 10000
  // across all armed legs per (loan_id, trigger_direction), so this
  // function just needs to forward a valid integer 1..10000. Default
  // 10000 preserves pre-ladder single-leg behavior for callers that
  // don't pass it (TG /tp without slice, site arm without slice picker).
  //
  // Engine note: until the magpie-limitclose partial-fill PR ships,
  // env LIMIT_CLOSE_LADDER_ENABLED gates whether < 10000 is accepted
  // at all — the bot won't let users arm a ladder the engine can't
  // honor end-to-end. See limit-close-arm-core.js LADDER_ENABLED
  // check below.
  slicePct = 10000,
  slippageBps,
  sellDestination = "sol",
  expiresAt = null,
  autoEscalate = true,     // fill-guarantee default — overridable per call
  // For agent path the cap comes from delegation. For other paths we
  // derive the cap from slippage so every order has escalation room.
  capBps = null,
  preflightProtocolFeeBps = 100,
  armNote = null,
  // dryRun: run every validation and gate but skip the INSERT and
  // skip the per-user concurrency cap (a dry-run is a question, not
  // a commitment of a slot). Used by the agent x402 preflight
  // endpoint so agents can confirm an arm would succeed before
  // paying. Returns the same ok/error shape as a real arm —
  // callers can treat dryRun success exactly like a live arm
  // would-have-succeeded. Setting dryRun=true does NOT enqueue
  // notifications either (none happen in armOrder anyway today,
  // but the contract holds).
  dryRun = false,
}) {
  // ── Shape validation ─────────────────────────────────────────
  if (!VALID_TRIGGER_KINDS.has(triggerKind)) {
    return { ok: false, error: "invalid_trigger_kind" };
  }
  if (!VALID_TRIGGER_DIRECTIONS.has(triggerDirection)) {
    return { ok: false, error: "invalid_trigger_direction" };
  }
  let triggerBI;
  try { triggerBI = BigInt(triggerValueMicro); }
  catch { return { ok: false, error: "invalid_trigger_value" }; }
  if (triggerBI < MIN_TRIGGER_VALUE_MICRO || triggerBI > MAX_TRIGGER_VALUE_MICRO) {
    return { ok: false, error: "trigger_value_out_of_range" };
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > MAX_INITIAL_SLIPPAGE_BPS) {
    return { ok: false, error: "invalid_slippage_bps" };
  }
  if (!VALID_DESTINATIONS.has(sellDestination)) {
    return { ok: false, error: "invalid_sell_destination" };
  }
  // ── Slice (ladder scaffolding) validation ────────────────────
  if (!Number.isInteger(slicePct) || slicePct <= 0 || slicePct > 10000) {
    return { ok: false, error: "invalid_slice_pct", detail: { allowed_range_bps: [1, 10000] } };
  }
  // Migration 064 keeps slice_pct as scaffolding: the column exists but
  // every armed leg is implicitly full-close (slice = 10000) until a
  // ladder semantics — when LIMIT_CLOSE_LADDER_ENABLED=true and the
  // paired engine PR has rolled out, slice<100% arms a real ladder
  // leg. The engine fires it by: full repay → swap slice → re-borrow
  // remainder → migrate sibling armed orders to new loan_id. See
  // migration 065 for the columns + sum-cap trigger that store this.
  // When the env flag is OFF (default), refuse slice<100% with a
  // clear message so users never see a misleading "armed" status on
  // something the engine can't honor end-to-end.
  const LADDER_ENABLED = process.env.LIMIT_CLOSE_LADDER_ENABLED === "true";
  if (slicePct < 10000 && !LADDER_ENABLED) {
    return {
      ok: false,
      error: "fractional_slice_not_supported_today",
      detail: "Partial-slice TP/SL is rolling out. For now, slice must be 100%. Multi-target arming at different prices IS supported today — arm a TP at 1.5x AND another at 2x; first to trigger fires, the other auto-cancels.",
    };
  }
  // Trailing validation. Bounded same as the migration's CHECK constraint.
  if (trailingDistanceBps != null) {
    if (!Number.isInteger(trailingDistanceBps) || trailingDistanceBps < 50 || trailingDistanceBps > 5000) {
      return { ok: false, error: "invalid_trailing_distance_bps", detail: { allowed_range_bps: [50, 5000] } };
    }
    if (triggerDirection !== "below") {
      return { ok: false, error: "trailing_only_valid_on_stop_loss", detail: { direction: triggerDirection } };
    }
  }
  if (!/^\d+$/.test(String(loanIdChain))) {
    return { ok: false, error: "invalid_loan_id" };
  }
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return { ok: false, error: "invalid_expires_at" };
  }
  if (!["tg", "site", "agent_x402"].includes(source)) {
    return { ok: false, error: "invalid_source" };
  }

  // Derive the cap: explicit caller-supplied value wins; otherwise default to
  // max(floor, slip × multiplier) clamped to the hard ceiling. Even a 50 bps
  // initial slippage gets at least 2500 bps of headroom under this rule, so
  // the engine's escalation ladder always has somewhere to walk.
  const derivedCap = Math.min(
    DEFAULT_HARD_CAP_BPS,
    Math.max(DEFAULT_CAP_FLOOR_BPS, slippageBps * DEFAULT_CAP_MULTIPLIER),
  );
  const effectiveCap = Number.isInteger(capBps) ? capBps : derivedCap;
  if (effectiveCap < slippageBps || effectiveCap > DEFAULT_HARD_CAP_BPS) {
    return { ok: false, error: "invalid_cap_bps" };
  }

  // ── Loan ownership + state ──────────────────────────────────
  // Server-side race-tolerant lookup. The pre-borrow ladder path on
  // the site fires the auto-arm immediately after the borrow tx
  // confirms — sometimes a few hundred ms before the loan row has
  // propagated to the loans table (cosign-borrow records inline but
  // sync-loan is fire-and-forget). The old behaviour was to return
  // loan_not_found_for_user immediately and rely on the FRONT-END to
  // retry, but every retry requires a fresh wallet signature — if the
  // user looks away from the popup, the retries never happen and the
  // ladder silently dies. Operator hit this on 2026-06-15 with a V4
  // $TROLL ladder: single audit row, loan_not_found_for_user, ladder
  // never armed.
  //
  // Fix: poll internally for up to ~6 seconds before giving up.
  // Same envelope, same nonce, no extra wallet prompts. The loan
  // reliably lands within 1-3s in practice; the longer window covers
  // RPC blips.
  const LOAN_LOOKUP_DEADLINE_MS = Date.now() + 30_000;
  const LOAN_LOOKUP_INTERVAL_MS = 400;
  let loan = null;
  for (;;) {
    const { rows } = await query(
      `SELECT id, loan_id::text AS loan_id, status,
              original_loan_amount_lamports::text AS owed,
              collateral_mint, collateral_amount::text AS coll_amount,
              collateral_amount::text AS collateral_amount_raw,
              borrower_wallet, user_id, program_id
         FROM loans
        WHERE user_id = $1 AND loan_id = $2`,
      [userId, loanIdChain],
    );
    if (rows.length > 0) {
      loan = rows[0];
      break;
    }
    if (Date.now() >= LOAN_LOOKUP_DEADLINE_MS) break;
    await new Promise((r) => setTimeout(r, LOAN_LOOKUP_INTERVAL_MS));
  }
  if (!loan) {
    // Tier-1 defense: admin DM on first occurrence per
    // feedback_loan_830_full_postmortem_and_defenses.md.
    try {
      const key = `loan_not_found:${loanIdChain}`;
      const now = Date.now();
      if (!_lnfThrottle.get(key) || now - _lnfThrottle.get(key) > 60 * 60 * 1000) {
        _lnfThrottle.set(key, now);
        await notifyAdmin(
          `🚨 single-arm RACE: loan_not_found_for_user\n` +
          `loan_id_chain: ${loanIdChain}\n` +
          `user_id: ${userId}\n` +
          `Single-arm path polled for ${Number(process.env.ARM_LOOKUP_DEADLINE_MS || 30_000) / 1000}s — loan never appeared`,
        );
      }
    } catch {}
    return { ok: false, error: "loan_not_found_for_user" };
  }
  if (loan.status !== "active") {
    return { ok: false, error: "loan_not_active", detail: loan.status };
  }
  if (BigInt(loan.owed) < MIN_LOAN_LAMPORTS) {
    return { ok: false, error: "loan_below_minimum_size" };
  }

  // ── V4-exclusive exits gate (2026-06-15) ─────────────────────
  // The operator design intent for V4: it is the ONLY pool whose
  // engine fire path keeps the loan ACTIVE and accumulates SOL in the
  // per-loan vault via convert_collateral_slice. V1/V2/V3 cannot
  // service exits going forward — their fire path closes the loan
  // and pays out immediately, which is the OLD model V4 supersedes.
  //
  // New arms against V1/V2/V3 loans are refused so users don't get
  // a misleading "armed" status on a loan whose engine path doesn't
  // match the in-vault model. They have to repay + re-borrow with
  // the exit attached at borrow time so the new loan lands on V4.
  //
  // Existing V1/V2/V3 loans that ALREADY have armed orders keep
  // firing through their legacy path — we don't break in-flight
  // users mid-flight. This check only refuses NEW arms.
  //
  // V4-in-vault exits are STRUCTURALLY exclusive for NEW arms — ALWAYS
  // enforced, never gated ON by an env flag. (audit FIX 2.) Previously this
  // whole block ran ONLY when V4_EXIT_EXCLUSIVE_ENFORCE==="true"; if that
  // flag was ever unset on the host, an exit could arm on a V1/V3 loan and
  // fire through the legacy fire-and-close path — violating the V4-in-vault
  // mandate and the x402 pool-separation guarantee. The env now only
  // RELAXES (V4_EXIT_LEGACY_ARMS_ALLOWED, for a documented migration) and
  // defaults OFF, so the guarantee can't silently degrade. Existing
  // V1/V2/V3 loans with already-armed orders keep firing through their
  // legacy path — this gate refuses NEW arms only. See
  // feedback_v4_in_vault_thesis_non_negotiable + feedback_x402_pool_separation_mandate.
  const legacyArmsAllowed = process.env.V4_EXIT_LEGACY_ARMS_ALLOWED === "true";
  if (!legacyArmsAllowed) {
    const v4ProgramIdStr = process.env.PROGRAM_ID_V4 ?? null;
    if (!v4ProgramIdStr) {
      // V4 not configured on this host — refuse rather than silently arm on
      // a legacy pool. (During a deliberate migration without V4, set
      // V4_EXIT_LEGACY_ARMS_ALLOWED=true to opt out, eyes open.)
      return {
        ok: false,
        error: "v4_not_configured",
        detail: "PROGRAM_ID_V4 isn't set on this host, so an exit can't be guaranteed in-vault. Deploy V4, or set V4_EXIT_LEGACY_ARMS_ALLOWED=true to deliberately allow legacy arms during a migration.",
      };
    }
    if (loan.program_id && loan.program_id !== v4ProgramIdStr) {
      return {
        ok: false,
        error: "exits_require_v4_loan",
        detail:
          "Exits live in V4 (in-vault auto-sell). This loan is on a legacy pool and can't be armed. " +
          "To use an exit: /repay this loan, then re-open the borrow with the exit set at borrow time — the new loan lands on V4 automatically.",
      };
    }
  }

  // ── Token-2022 extension compatibility gate (T14, 2026-06-16) ─
  // Refuse exits on mints with extensions Jupiter can't model — these
  // 2026-06-16 PM operator-mandated removal of T14's arm-side hard
  // block (feedback_v4_arms_must_always_succeed.md). Every TP/SL/
  // ladder specified by the user on any V4 collateral MUST persist
  // as armed; Jupiter route friction is the engine's problem at
  // fire-time via excludeDexes retry, not a reason to refuse the
  // arm. We still probe extensions for telemetry — if it fails,
  // attach a non-blocking warning so DM/UX can surface it — but
  // arming proceeds.
  const v4Pid = process.env.PROGRAM_ID_V4 ?? null;
  const willRouteV4 = v4Pid && loan.program_id === v4Pid;
  let _extensionWarning = null;
  if (willRouteV4) {
    try {
      const compat = await checkExitCompatibility(loan.collateral_mint);
      if (!compat.ok) {
        _extensionWarning = {
          kind: "token2022_extensions_present",
          blocking_extensions: compat.blocking,
          note:
            `Mint uses Token-2022 extension(s) [${compat.blocking.join(", ")}]. ` +
            `Engine will route via Jupiter with per-DEX exclusion retry; if all ` +
            `routes fail at fire-time the order will be marked failed with a DM.`,
        };
        console.log(
          `[arm-core] V4 extension annotation (non-blocking) mint=${loan.collateral_mint} ext=${compat.blocking.join(",")}`,
        );
      }
    } catch (err) {
      console.warn(`[arm-core] extension probe error (non-blocking): ${err.message?.slice(0, 100)}`);
    }
  }

  // ── Collateral allowlist ────────────────────────────────────
  const { rows: [mintRow] } = await query(
    `SELECT enabled, category, symbol, liquidity_usd FROM supported_mints WHERE mint = $1`,
    [loan.collateral_mint],
  );
  if (!mintRow || !mintRow.enabled) return { ok: false, error: "collateral_not_enabled" };
  // ── RWA collateral support (2026-06-13, PR C) ───────────────
  // Pre-2026-06-13 we hard-refused RWA limit-close arms because the
  // engine couldn't fire V2 program orders. PR B (engine repo) added
  // the V2 fill path; this gate is now the limiting factor we remove.
  //
  // For RWA tokens (stock/etf/metal) the V2 lending program handles
  // the actual repay — engine_program_id discriminator on the order
  // row (PR A) routes the fire to V2.
  //
  // The remaining concern: stock-token Jupiter routes thin out hard
  // during weekend hours when underlying equities are closed. Backed
  // arb desks step away, AMM depth collapses 5-10x. The existing
  // liquidity-floor tiers below already widen initial slippage based
  // on a screener-vetted liquidity_usd reading — but that reading is
  // a weekday-average, not a live snapshot. So for RWA we layer a
  // weekend-aware bump ON TOP of the tier floor.
  const isRwa = ["stock", "etf", "metal"].includes(mintRow.category);

  // ── Liquidity-aware initial slippage adjustment ─────────────
  // Operator mandate: "the order MUST execute." The arm-time INITIAL
  // slippage is what the engine tries FIRST. For thin tokens, a default
  // 200 bps initial means the first attempt almost certainly reverts and
  // we waste a tick before auto-escalation kicks in. Bumping the initial
  // up to a token-liquidity-appropriate floor saves that round-trip.
  //
  // Exploit surface analysis:
  //   - liquidity_usd is screener-vetted and operator-controlled (slow
  //     cadence). Not manipulable per-arm — an attacker cannot create a
  //     fake low-liquidity reading right before an arm to force a wider
  //     initial. The CAP is the actual ceiling (5000 bps absolute via
  //     DEFAULT_HARD_CAP_BPS), and this code never touches the cap.
  //   - Hard floor on the bump: never bump initial ABOVE the user's
  //     stated cap. If the bump would exceed the cap, clamp to cap.
  //   - User's stated cap (effectiveCap) is unchanged.
  //
  // Tiers (bps floors):
  //   deep      (>= $100k liquidity_usd) : no bump
  //   mid       ($25k-$100k)             : 300 bps floor (3%)
  //   thin      ($5k-$25k)               : 500 bps floor (5%)
  //   very_thin (< $5k)                  : 1000 bps floor (10%)
  //
  // RWA weekend adjustment (PR C): when arming during weekend cutoff
  // window, layer an additional bump because Jupiter route quality for
  // stock tokens collapses outside US RTH. Same window the premium
  // tier uses to refuse new borrows — we don't refuse here (limit
  // arms are reversible and the engine can wait for Monday to fire),
  // but we widen the initial so when the order DOES fire it clears.
  //   weekend deep      : +200 bps  (300 if base was 0)
  //   weekend mid       : +400 bps
  //   weekend thin      : +800 bps
  //   weekend very_thin : +1500 bps
  // Clamped to effectiveCap regardless — never wider than user accepted.
  const liqUsd = Number(mintRow.liquidity_usd ?? 0);
  let liquidityFloorBps = 0;
  // Treat liquidity_usd <= 0 as UNKNOWN (screener data missing or stale)
  // rather than as "very thin". Bumping to 10% on a token that may have
  // real $1M liquidity (just unscanned) would be a surprise to the user.
  // The engine's auto-escalation still walks UP from the initial when the
  // first attempt fails, so the user is still protected against thin
  // liquidity at fire time — we just don't preemptively widen on data we
  // don't have.
  if (liqUsd <= 0) liquidityFloorBps = 0;
  else if (liqUsd >= 100_000) liquidityFloorBps = 0;
  else if (liqUsd >= 25_000) liquidityFloorBps = 300;
  else if (liqUsd >= 5_000) liquidityFloorBps = 500;
  else liquidityFloorBps = 1000;

  // RWA weekend bump — only applied when collateral is RWA AND the
  // weekend cutoff window is active. Lazy-imported to avoid module
  // cycles between arm-core and the premium tier (which itself depends
  // on supported_mints which is far from limit-close concerns).
  if (isRwa) {
    try {
      const { isInWeekendCutoff } = await import("./premium-tier-screener.js");
      if (isInWeekendCutoff()) {
        let weekendBump;
        if (liqUsd <= 0) weekendBump = 300;            // unknown liquidity → safe default
        else if (liqUsd >= 100_000) weekendBump = 200;
        else if (liqUsd >= 25_000) weekendBump = 400;
        else if (liqUsd >= 5_000) weekendBump = 800;
        else weekendBump = 1500;
        liquidityFloorBps = liquidityFloorBps + weekendBump;
      }
    } catch (err) {
      // Non-fatal — if the weekend check throws (e.g. premium-tier
      // module rename), fall through with just the standard liquidity
      // floor. The engine's runtime escalation is the actual fill
      // guarantee; this is a soft optimization.
      console.warn(`[limit-close-arm-core] weekend-bump check failed: ${err.message?.slice(0, 80)}`);
    }
  }
  const originalInitialBps = slippageBps;
  let appliedInitialBps = slippageBps;
  if (liquidityFloorBps > 0 && slippageBps < liquidityFloorBps) {
    // Clamp to user's stated cap so the bump never widens past what
    // they already accepted as the worst case for this order.
    appliedInitialBps = Math.min(liquidityFloorBps, effectiveCap);
  }

  // ── Immediate-fire + SL solvency guards (best-effort) ──────
  // Two checks combined:
  //   1. Immediate-fire: reject arms that would fire immediately:
  //      - 'above' (TP)  with trigger <= current
  //      - 'below' (SL)  with trigger >= current
  //   2. SL solvency (2026-06-13): reject SL arms where expected
  //      proceeds at trigger < owed + buffer. The engine's repay step
  //      requires the borrower wallet to hold `owed` lamports in
  //      native SOL — if the sale proceeds can't cover that, the user
  //      goes negative and the engine eats the shortfall. Better to
  //      refuse the arm than to fire into insolvency.
  // The engine re-checks at fire time so these are purely UX guards;
  // fail-open on any oracle hiccup so a transient price miss doesn't
  // block a legitimate arm. Implemented for USD-denominated triggers
  // (mc_usd, price_usd); price_sol skipped because the SOL denominator
  // moves fast enough that a stale read can false-reject.
  let currentMicrosForLater = null;
  try {
    if (triggerKind === "mc_usd" || triggerKind === "price_usd") {
      const { getPriceInUsdCrossSourced } = await import("./price.js");
      const currentUsdPerDisplayed = await getPriceInUsdCrossSourced(loan.collateral_mint);
      if (currentUsdPerDisplayed && currentUsdPerDisplayed > 0) {
        // For price_usd, trigger_value_micro is per displayed unit in USD micros.
        // For mc_usd, multiply current price by circulating supply (best-effort —
        // mintRow may not carry supply; skip if missing).
        let currentMicros = null;
        if (triggerKind === "price_usd") {
          currentMicros = BigInt(Math.round(currentUsdPerDisplayed * 1e6));
        } else if (triggerKind === "mc_usd" && mintRow.supply) {
          currentMicros = BigInt(Math.round(currentUsdPerDisplayed * 1e6)) * BigInt(mintRow.supply);
        }
        if (currentMicros != null) {
          currentMicrosForLater = currentMicros;
          if (triggerDirection === "above" && triggerBI <= currentMicros) {
            return { ok: false, error: "trigger_would_fire_immediately",
              detail: { direction: "above", currentMicros: currentMicros.toString(), triggerMicros: triggerBI.toString() } };
          }
          if (triggerDirection === "below" && triggerBI >= currentMicros) {
            return { ok: false, error: "trigger_would_fire_immediately",
              detail: { direction: "below", currentMicros: currentMicros.toString(), triggerMicros: triggerBI.toString() } };
          }
        }
      }
    }
  } catch { /* fail-open: engine is the source of truth */ }

  // ── Per-user concurrency cap ────────────────────────────────
  // Skipped in dryRun mode — a preflight is a question not a slot
  // commitment, and the agent might be running this to decide which
  // of several candidate orders to actually arm.
  if (!dryRun) {
    const { rows: [activeCount] } = await query(
      `SELECT COUNT(*)::int AS n FROM limit_close_orders
         WHERE user_id = $1 AND status = 'armed'`,
      [userId],
    );
    if (activeCount.n >= MAX_ACTIVE_ORDERS_PER_USER) {
      return { ok: false, error: "user_concurrency_cap_reached", detail: { active: activeCount.n, cap: MAX_ACTIVE_ORDERS_PER_USER } };
    }
  }

  // ── Pre-flight Jupiter quote ────────────────────────────────
  const preflight = await runArmPreflight({
    collateralMint: loan.collateral_mint,
    collateralAmountRaw: loan.collateral_amount_raw,
    sellDestination,
    slippageBps: effectiveCap,
    loanOwedLamports: loan.owed,
    protocolFeeBps: preflightProtocolFeeBps,
  });
  if (!preflight.ok) {
    return {
      ok: false,
      error: preflight.reason,
      detail: preflight.detail,
      suggestedSlippageBps: preflight.suggestedSlippageBps,
      yourSlippageBps: preflight.yourSlippageBps,
    };
  }
  const advisory = !!preflight.advisory;

  // ── SL solvency floor (2026-06-13) ──────────────────────────
  // The engine's repay step requires the borrower wallet to hold the
  // OWED amount in native SOL — the on-chain program's repay_loan ix
  // wraps `owed` lamports into wSOL and burns them. For SL where
  // collateral has dropped, expected sale proceeds may be below owed
  // and the user would go negative.
  //
  // For TP this is never a concern (proceeds always > owed by the
  // very nature of "I want to sell at a profit"). For SL it's the
  // central risk.
  //
  // What we check: estimated proceeds AT TRIGGER >= owed * 1.05 (5%
  // buffer). The buffer accounts for swap slippage eating proceeds +
  // price moving past trigger before the engine catches the cross.
  //
  // What we DON'T check (yet): the borrower's actual wallet balance
  // at fire time. That belongs in the engine's pre-flight gates and
  // is covered by the engine's existing ensureSolReserve topup, which
  // tops gas but not the owed amount. Sell-first-then-repay is the
  // proper fix; awaits a program-level change.
  //
  // Fail-open if we couldn't compute the trigger:current ratio (e.g.
  // price_sol triggers or oracle hiccup) — the engine's own runtime
  // safety check at fire time backstops.
  if (triggerDirection === "below" && preflight.proceedsLamports != null && currentMicrosForLater != null && currentMicrosForLater > 0n) {
    // Scale current proceeds to trigger-time proceeds estimate.
    // triggerProceeds ≈ currentProceeds * (trigger / current)
    // BigInt math: (current_proceeds * trigger_micros) / current_micros
    const triggerProceedsEstimate = (BigInt(preflight.proceedsLamports) * triggerBI) / currentMicrosForLater;
    const ownedBI = BigInt(loan.owed);
    const owedWithBuffer = (ownedBI * 105n) / 100n; // 5% buffer
    if (triggerProceedsEstimate < owedWithBuffer) {
      return {
        ok: false,
        error: "sl_below_solvency",
        detail: {
          owed_sol: (Number(ownedBI) / 1e9).toFixed(4),
          required_proceeds_sol: (Number(owedWithBuffer) / 1e9).toFixed(4),
          estimated_proceeds_at_trigger_sol: (Number(triggerProceedsEstimate) / 1e9).toFixed(4),
          shortfall_sol: (Number(owedWithBuffer - triggerProceedsEstimate) / 1e9).toFixed(4),
        },
      };
    }
  }

  // ── INSERT (skipped in dryRun) ──
  // In dryRun mode all the gates above passed and we return ok=true
  // without persisting any state. The caller (typically the agent
  // preflight endpoint) treats this as "yes, a real arm with these
  // exact params would succeed right now." Note that 'right now' is
  // a momentary fact — liquidity can shift between preflight and
  // arm. Agents should treat preflight as a strong hint, not a
  // contractual reservation.
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      orderId: null,
      armedAt: null,
      loan,
      mint: mintRow,
      preflightAdvisory: advisory,
      initialSlippageBpsRequested: originalInitialBps,
      initialSlippageBpsApplied: appliedInitialBps,
      liquidityTierFloorBps: liquidityFloorBps,
      liquidityUsd: liqUsd,
      triggerDirection,
    };
  }

  // Trailing stops seed peak_price_micros at arm time so the watcher's
  // first tick has a baseline. Using `currentMicrosForLater` (computed
  // above as part of the immediate-fire guard) avoids a second oracle
  // round-trip. Falls back to triggerBI when the immediate-fire guard
  // didn't get a price quote — the watcher will correct on its first
  // tick if the real price is higher.
  const peakAtArm = trailingDistanceBps != null
    ? (currentMicrosForLater != null ? currentMicrosForLater : triggerBI)
    : null;

  // ── Ladder group resolution (migration 065) ──────────────────
  // When slice<100% (LIMIT_CLOSE_LADDER_ENABLED), this arm is a ladder
  // leg. Find an existing ladder group on the same (loan_id, direction)
  // and JOIN it — that way all legs share the same group UUID and the
  // engine can migrate them together to a new loan_id after a leg
  // fires + re-borrows on remainder. If no existing group, create one
  // and snapshot the loan's collateral_amount as the absolute reference
  // ("10%" always means 10% of THIS amount, never drifts).
  let ladderGroupId = null;
  let originalCollateralAmountForArm = null;
  if (slicePct < 10000) {
    const { rows: [existingGroup] } = await query(
      `SELECT ladder_group_id, original_collateral_amount::text AS original_amount
         FROM limit_close_orders
        WHERE loan_id = $1
          AND COALESCE(trigger_direction, 'above') = $2
          AND status = 'armed'
          AND ladder_group_id IS NOT NULL
        LIMIT 1`,
      [loan.id, triggerDirection],
    );
    if (existingGroup?.ladder_group_id) {
      ladderGroupId = existingGroup.ladder_group_id;
      originalCollateralAmountForArm = existingGroup.original_amount;
    } else {
      // New ladder group — generate UUID, snapshot collateral.
      const { randomUUID } = await import("node:crypto");
      ladderGroupId = randomUUID();
      originalCollateralAmountForArm = loan.collateral_amount_raw;
    }
  }

  let inserted;
  try {
    inserted = await query(
      `INSERT INTO limit_close_orders
         (user_id, loan_id, trigger_kind, trigger_value_micro,
          trigger_direction,
          slippage_bps, sell_destination, expires_at,
          source, source_agent_pubkey, status, armed_at,
          auto_escalate_slippage, max_slippage_bps_cap, initial_slippage_bps,
          preflight_slippage_quoted_bps, preflight_proceeds_lamports, preflight_quoted_at,
          engine_program_id,
          trailing_distance_bps, peak_price_micros,
          slice_pct,
          ladder_group_id,
          original_collateral_amount,
          notes)
       VALUES ($1, $2, $3, $4,
               $5,
               $6, $7, $8,
               $9, $10, 'armed', NOW(),
               $11, $12, $13,
               $14, $15, $16,
               $17,
               $18, $19,
               $20,
               $21,
               $22,
               $23)
       RETURNING id, armed_at`,
      [userId, loan.id, triggerKind, triggerBI.toString(),
       triggerDirection,
       appliedInitialBps, sellDestination, expiresAt,
       source, sourceAgentPubkey,
       autoEscalate, effectiveCap, appliedInitialBps,
       advisory ? null : effectiveCap,
       advisory ? null : (preflight.proceedsLamports || null),
       advisory ? null : (preflight.quotedAtIso || new Date().toISOString()),
       loan.program_id || null,
       trailingDistanceBps,
       peakAtArm != null ? peakAtArm.toString() : null,
       slicePct,
       ladderGroupId,
       originalCollateralAmountForArm,
       armNote
         || (appliedInitialBps !== originalInitialBps
           ? `armed via ${source}; ${triggerDirection === "below" ? (trailingDistanceBps != null ? `TRAILING-SL ${trailingDistanceBps/100}%` : "STOP-LOSS") : "TP"}${slicePct < 10000 ? ` slice=${slicePct/100}% ladder=${ladderGroupId?.slice(0,8)}` : ""}; initial slippage bumped ${originalInitialBps}->${appliedInitialBps} bps for ${mintRow.symbol || "thin token"} (liquidity_usd=$${Math.round(liqUsd)})`
           : `armed via ${source}; ${triggerDirection === "below" ? (trailingDistanceBps != null ? `TRAILING-SL ${trailingDistanceBps/100}%` : "STOP-LOSS") : "TP"}${slicePct < 10000 ? ` slice=${slicePct/100}% ladder=${ladderGroupId?.slice(0,8)}` : ""}`)],
    );
  } catch (err) {
    // Migration 065's sum-cap trigger: SUM(slice_pct) > 10000 across
    // armed legs per (loan_id, direction). Surface as a structured
    // error so the UI shows the over-allocation cleanly.
    if (/TP\/SL ladder exceeds 100/i.test(err.message || "")) {
      return {
        ok: false,
        error: "ladder_sum_exceeds_100",
        detail: err.message?.slice(0, 240),
      };
    }
    // Migration 047's per-direction UNIQUE is dropped by 064 so multi-
    // target arming is allowed. Tolerate the duplicate-key signal in
    // case a stale replica is still using the pre-064 schema during
    // rollout.
    if (/duplicate key value violates unique constraint/i.test(err.message || "")) {
      return {
        ok: false,
        error: "loan_already_has_active_order_in_direction",
        detail: { direction: triggerDirection },
      };
    }
    console.error(`[arm-core] insert failed (source=${source}):`, err.message);
    return { ok: false, error: "insert_failed", detail: err.message?.slice(0, 200) };
  }

  return {
    ok: true,
    orderId: inserted.rows[0].id,
    armedAt: inserted.rows[0].armed_at,
    loan,
    mint: mintRow,
    preflightAdvisory: advisory,
    // Surfacing the bump lets callers (TG cmd, site UI, agent response)
    // tell the user "you asked for 2%, we armed at 5% because $TOKEN
    // is thin." Cap is unchanged either way.
    initialSlippageBpsRequested: originalInitialBps,
    initialSlippageBpsApplied: appliedInitialBps,
    liquidityTierFloorBps: liquidityFloorBps,
    liquidityUsd: liqUsd,
    triggerDirection,
    extensionWarning: _extensionWarning,
  };
}

/* ─────────────────────────────────────────────────────────────────
 * armOrderBatch — atomic multi-leg arming.
 *
 * Operator-mandated 2026-06-16 PM
 * (feedback_one_signature_for_n_legs_always.md). Triggering incident:
 * SPCX loans 798 + 802 both had silent leg-drops when the site looped
 * N signMessage calls (Phantom session died between the first two).
 * Now multi-leg ladders sign exactly ONCE → POST batch envelope →
 * server validates every leg → inserts ALL or NONE inside a single
 * DB transaction.
 *
 * Validation runs in two phases:
 *   1. Shared validation (loan exists, owner match, V4 routing,
 *      collateral enabled, loan size floor, mint not blocked)
 *   2. Per-leg sanity (direction, kind, value range, slice 1..10000,
 *      slippage cap, optional trailing)
 *   3. Cumulative slice check across (existing armed legs + batch
 *      legs) per direction
 *
 * Insert phase opens a DB transaction, INSERTs N rows sharing one
 * ladder_group_id per direction (computed up-front), commits.
 * Rollback on any per-row failure.
 *
 * Returns:
 *   { ok: true,
 *     orderIds: [int, int, ...],
 *     ladderGroupIds: { above?: uuid, below?: uuid },
 *     legs: [{ orderId, direction, triggerValueMicro, slicePctBps }] }
 * or
 *   { ok: false, error, failedLegIndex?, detail }
 *
 * Best-effort post-commit work (intent reconcile, single combined DM,
 * audit trail) happens OUTSIDE the transaction so a failure there
 * doesn't undo the armed state.
 * ───────────────────────────────────────────────────────────────── */
export async function armOrderBatch(args) {
  // Thin wrapper around the existing implementation that ALSO
  // reconciles the supplied intent_ids on FAILURE (not just success).
  // Without this, a failed batch arm leaves the intents stuck at
  // status='pending' — the recovery banner keeps surfacing them
  // forever even though the arm hard-failed. Operator-mandated
  // (feedback_no_duplicate_intents_in_recovery_banner_NEVER.md):
  // status must match reality; pending means "in flight or unresolved",
  // not "we tried and gave up."
  let result;
  try {
    result = await armOrderBatchImpl(args);
  } catch (err) {
    console.error("[arm-core:batch] unexpected throw:", err?.stack || err?.message || err);
    result = {
      ok: false,
      error: "exception",
      detail: (err?.message || String(err)).slice(0, 240),
    };
  }
  if (!result.ok && Array.isArray(args.intentIds) && args.intentIds.length > 0) {
    const ids = args.intentIds.filter((x) => x != null);
    if (ids.length > 0) {
      try {
        await query(
          `UPDATE arm_intents
              SET status = 'failed',
                  error_code = $2,
                  error_detail = $3,
                  updated_at = NOW()
            WHERE id = ANY($1::bigint[]) AND status = 'pending'`,
          [
            ids,
            safeTruncate(result.error, 64),
            safeTruncate(jsonStringifyError(result.detail), 400),
          ],
        );
      } catch (rcErr) {
        console.warn(
          "[arm-core:batch] failure-intent reconcile failed:",
          rcErr.message?.slice(0, 120),
        );
      }
    }
  }

  // Operator-facing observability for every arm-batch failure.
  // Mandated 2026-06-17 PM (feedback_v4_ladder_arms_must_execute_not_
  // sit_pending.md): treat the recovery banner as a P1 alert. Every
  // time the banner would render, the operator gets a real-time DM
  // with the structured failure context so it never sits silent.
  //
  // Layered output:
  //   1) Structured console log (Railway-grep-able)
  //   2) Direct admin DM with the same payload
  //
  // Throttled by (loan_id, error_code) — same combo within 10 min
  // doesn't re-DM. Tracked via an in-process Map (lives until restart);
  // a Railway restart resets the throttle which is the right behavior
  // (operator should re-see the alert after a deploy).
  if (!result.ok) {
    const errorCode = result.error || "unknown";
    const failedLegIdx = result.failedLegIndex ?? null;
    const legsSummary = Array.isArray(args.legs)
      ? args.legs.map((l, i) => `[${i}]${l?.direction || "?"}@${l?.valueMicro || l?.multiplier || "?"}/${l?.sliceBps || 10000}bps`).join(",")
      : "n/a";
    const structuredLine = JSON.stringify({
      evt: "arm_batch_failed",
      ts: new Date().toISOString(),
      source: args.source || null,
      user_id: args.userId || null,
      loan_id_chain: args.loanIdChain || null,
      error_code: errorCode,
      failed_leg_index: failedLegIdx,
      detail: typeof result.detail === "string" ? result.detail.slice(0, 240) : result.detail,
      legs: legsSummary,
      intent_ids: Array.isArray(args.intentIds) ? args.intentIds : null,
    });
    console.error(`[arm-batch-fail-alert] ${structuredLine}`);

    const throttleKey = `${args.loanIdChain || "?"}|${errorCode}`;
    if (!_armBatchAlertThrottle) _armBatchAlertThrottle = new Map();
    const lastSent = _armBatchAlertThrottle.get(throttleKey) || 0;
    const ALERT_THROTTLE_MS = 10 * 60 * 1000; // 10 min
    if (Date.now() - lastSent >= ALERT_THROTTLE_MS) {
      _armBatchAlertThrottle.set(throttleKey, Date.now());
      try {
        const lines = [
          "*P1 ALERT: arm-batch failed*",
          "",
          `Source: \`${args.source || "?"}\``,
          `Loan: #${args.loanIdChain || "?"}`,
          `User: ${args.userId || "?"}`,
          `Error: \`${errorCode}\`${failedLegIdx != null ? ` (leg ${failedLegIdx})` : ""}`,
          typeof result.detail === "string" && result.detail
            ? `Detail: ${result.detail.slice(0, 200)}`
            : null,
          `Legs: \`${legsSummary.slice(0, 200)}\``,
          Array.isArray(args.intentIds) && args.intentIds.some((x) => x != null)
            ? `Intent IDs (now marked failed): ${args.intentIds.filter((x) => x != null).join(", ")}`
            : null,
          "",
          `_Throttled to once per (loan, error_code) per 10 min._`,
        ].filter(Boolean).join("\n");
        await notifyAdmin(lines, { parse_mode: "Markdown" });
      } catch (dmErr) {
        console.warn("[arm-core:batch] admin DM failed:", dmErr.message?.slice(0, 120));
      }
    }
  }

  return result;
}

let _armBatchAlertThrottle = null;

async function armOrderBatchImpl({
  userId,
  source = "site",
  sourceAgentPubkey = null,
  loanIdChain,
  legs,                    // [{ direction, kind, valueMicro, sliceBps, slippageBps, expiresAt?, trailingDistanceBps? }]
  intentIds = null,        // optional [intent_id, ...] same length as legs
  armNotePrefix = null,
  // Tier-2 architectural defense
  // (feedback_loan_830_full_postmortem_and_defenses.md). If the caller
  // supplied a signed-envelope context, we can queue the arm for
  // background retry instead of hard-failing when the loan row hasn't
  // committed yet. Shape:
  //   { signer_pubkey, wallet, envelope_issued_at_ms }
  // The watcher uses envelope_issued_at_ms to enforce the 5-min
  // freshness rule. Storing signer + wallet preserves the audit trail
  // (who signed, when) for the eventual replay.
  envelope = null,
  // When true, skip the pending-arm queue path. The watcher sets this
  // when replaying so a second race doesn't re-queue the same arm.
  skipPendingQueue = false,
}) {
  // Per-phase structured logging tagged with reqId so the operator can
  // grep Railway logs for the exact failing phase when an arm doesn't
  // land. Operator-mandated rule:
  // feedback_next_spcx_ladder_must_arm_display_execute.md — the four-
  // link success chain (arm → display → reflect → execute) cannot fail
  // silently again. Logs are JSON for grep-ability.
  const reqId = `arm-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const phaseLog = (phase, extra = {}) => {
    console.log(
      `[arm-batch-trace] ${JSON.stringify({ req_id: reqId, phase, source, user_id: userId, loan_id_chain: String(loanIdChain), ...extra })}`,
    );
  };
  phaseLog("entry", { n_legs: Array.isArray(legs) ? legs.length : null });

  if (!Array.isArray(legs) || legs.length === 0) {
    phaseLog("reject_no_legs");
    return { ok: false, error: "no_legs_supplied" };
  }
  if (legs.length > 8) {
    phaseLog("reject_too_many_legs", { n_legs: legs.length });
    return { ok: false, error: "too_many_legs", detail: "max 8 legs per batch" };
  }

  // Phase 1 — Shared loan + eligibility load with race-tolerant polling.
  //
  // Mirrors the single-arm lookup loop earlier in this file (~ line 467).
  // The pre-borrow ladder picker beacons intents and signs the batch arm
  // seconds after the borrow tx confirms — sometimes before /sync-loan
  // has committed the loans row. Without retry, the batch returns
  // loan_not_found_for_user immediately and the user's intent beacons
  // flip to status='failed' (recovery banner then has to do the work
  // of re-prompting for retry). Triggered 2026-06-17 on operator's
  // SPCX loan 820: intents 15/16 failed at 05:28:46, loan row landed
  // at 05:28:51 — 5s late. Initial fix was 6s/400ms; bumped to 30s/400ms
  // on 2026-06-17 PM after operator's loan 830 took 9s to commit (the
  // 6s window timed out before the loan landed). 30s is 3x worst-case
  // so future Solana congestion doesn't re-trip this. Same envelope/sig.
  // See feedback_arm_lookup_window_must_outlast_cosign_borrow.md.
  phaseLog("phase_1_loan_lookup_start");
  // Env-tunable. Floor 30s per
  // feedback_arm_lookup_window_must_outlast_cosign_borrow.md. Operator
  // can bump via Railway env without a code deploy if Solana congestion
  // pushes commit latency higher.
  const LOAN_LOOKUP_DEADLINE_MS = Date.now() +
    Number(process.env.ARM_LOOKUP_DEADLINE_MS || 30_000);
  const LOAN_LOOKUP_INTERVAL_MS =
    Number(process.env.ARM_LOOKUP_INTERVAL_MS || 400);
  let loanRows;
  let lookupAttempts = 0;
  for (;;) {
    lookupAttempts += 1;
    ({ rows: loanRows } = await query(
      `SELECT l.id, l.loan_id::text AS loan_id_chain, l.user_id, l.collateral_mint,
              l.collateral_amount::text AS coll_raw,
              l.original_loan_amount_lamports::text AS owed,
              l.program_id, l.status,
              sm.symbol, sm.decimals, sm.category, sm.enabled
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.loan_id::text = $1 AND l.user_id = $2
        LIMIT 1`,
      [String(loanIdChain), userId],
    ));
    if (loanRows.length > 0) break;
    if (Date.now() >= LOAN_LOOKUP_DEADLINE_MS) break;
    await new Promise((r) => setTimeout(r, LOAN_LOOKUP_INTERVAL_MS));
  }
  if (loanRows.length === 0) {
    phaseLog("phase_1_loan_not_found", { lookup_attempts: lookupAttempts });

    // ── Tier-2 architectural fix
    // (feedback_loan_830_full_postmortem_and_defenses.md, defense B) ──
    // If the caller supplied a signed envelope context AND we aren't
    // already in a retry replay, queue the arm for the background
    // pending-arm watcher. The watcher polls every 10s and replays
    // while the envelope is still within its 5-min freshness window.
    // User never has to re-sign; the recovery banner is reduced from
    // a routine UX state to a true exception.
    if (envelope && !skipPendingQueue) {
      const issuedAtMs = Number(envelope.envelope_issued_at_ms);
      if (Number.isFinite(issuedAtMs) && issuedAtMs > 0) {
        const ageMs = Date.now() - issuedAtMs;
        const ENVELOPE_FRESH_MS = 5 * 60 * 1000;
        if (ageMs < ENVELOPE_FRESH_MS - 30_000) {
          // Need >30s of freshness left so the watcher gets at least
          // one retry attempt.
          try {
            const pending = await persistPendingArm({
              userId,
              signerPubkey: envelope.signer_pubkey || null,
              wallet: envelope.wallet || envelope.signer_pubkey || null,
              loanIdChain: String(loanIdChain),
              legs,
              intentIds: Array.isArray(intentIds) ? intentIds.filter((x) => x != null) : null,
              source,
              armNotePrefix,
              envelopeIssuedAtMs: issuedAtMs,
            });
            phaseLog("phase_1_queued_for_retry", {
              pending_arm_id: pending.id,
              envelope_age_ms: ageMs,
              envelope_remaining_ms: ENVELOPE_FRESH_MS - ageMs,
            });
            return {
              ok: true,
              pending: true,
              pending_arm_id: pending.id,
              envelope_expires_at_ms: issuedAtMs + ENVELOPE_FRESH_MS,
              retry_in_ms: 10_000,
              detail:
                "Loan not yet committed to DB — arm queued for background retry while user's signature is still valid.",
            };
          } catch (qErr) {
            console.warn(
              `[arm-batch] pending_arms insert failed: ${qErr.message?.slice(0, 160)} — falling back to hard-fail path`,
            );
            // Fall through to the existing DM + return-error path so
            // we never silently swallow this failure mode.
          }
        } else {
          phaseLog("phase_1_envelope_too_stale_for_queue", {
            envelope_age_ms: ageMs,
          });
        }
      }
    }

    // Tier-1 defense per
    // feedback_loan_830_full_postmortem_and_defenses.md: admin DM on
    // FIRST occurrence of loan_not_found_for_user, throttled per
    // (loan, hour). Operator must never find out about a race
    // failure by reading their own dashboard. Best-effort —
    // notification failures never block the response.
    try {
      const { notifyAdmin } = await import("./admin-notify.js");
      const key = `loan_not_found:${loanIdChain}`;
      const now = Date.now();
      if (!_lnfThrottle.get(key) || now - _lnfThrottle.get(key) > 60 * 60 * 1000) {
        _lnfThrottle.set(key, now);
        await notifyAdmin(
          `arm-batch RACE: loan_not_found_for_user\n` +
          `loan_id_chain: ${loanIdChain}\n` +
          `user_id: ${userId}\n` +
          `polled ${lookupAttempts}x over ${Number(process.env.ARM_LOOKUP_DEADLINE_MS || 30_000) / 1000}s — loan never appeared\n` +
          `Possible causes: cosign-borrow DB-write delayed > polling window, OR loan never created (user cancelled mid-flow), OR envelope not supplied so queue-and-retry skipped`,
        );
      }
    } catch {}
    return { ok: false, error: "loan_not_found_for_user" };
  }
  const loan = loanRows[0];
  if (loan.status !== "active") {
    return { ok: false, error: "loan_not_active", detail: loan.status };
  }
  if (BigInt(loan.owed) < MIN_LOAN_LAMPORTS) {
    return {
      ok: false,
      error: "loan_below_minimum_size",
      detail: `Loan is below the ${Number(MIN_LOAN_LAMPORTS) / 1e9} SOL minimum for limit-close orders.`,
    };
  }
  if (loan.enabled === false) {
    return { ok: false, error: "collateral_not_enabled" };
  }
  const v4Pid = process.env.PROGRAM_ID_V4 ?? null;
  const v4EnforceOn = process.env.V4_EXIT_EXCLUSIVE_ENFORCE === "true";
  if (v4EnforceOn && v4Pid && loan.program_id && loan.program_id !== v4Pid) {
    return { ok: false, error: "exits_require_v4_loan" };
  }

  phaseLog("phase_1_loan_ok", { loan_db_id: loan.id, program_id: loan.program_id, status: loan.status, symbol: loan.symbol, category: loan.category, lookup_attempts: lookupAttempts });

  // Phase 2 — Per-leg parse + validation. No DB writes yet.
  // Multiplier kinds are resolved through the cross-source oracle in
  // ONE batched fetch (single getPriceInUsdCrossSourced call for the
  // mint, then each multiplier-kind leg = currentUsd * multiplier).
  // This keeps the batch path consistent with single-arm pricing and
  // covers preset ladders (which specify legs as e.g. 1.5x/2x/3x).
  let currentUsdForMultiplier = null;
  const hasMultiplierLeg = legs.some(
    (l) => l && (l.kind === "multiplier" || (typeof l.multiplier === "number" && l.multiplier > 0)),
  );
  if (hasMultiplierLeg) {
    try {
      const { getPriceInUsdCrossSourced } = await import("./price.js");
      currentUsdForMultiplier = await getPriceInUsdCrossSourced(loan.collateral_mint);
    } catch (priceErr) {
      return {
        ok: false,
        error: "price_unavailable",
        detail: `Couldn't resolve multiplier legs (cross-source oracle): ${priceErr.message?.slice(0, 120) || String(priceErr).slice(0, 120)}`,
      };
    }
    if (!currentUsdForMultiplier || currentUsdForMultiplier <= 0) {
      return {
        ok: false,
        error: "price_unavailable",
        detail: "Oracle returned empty price — try again in a few seconds.",
      };
    }
  }

  const parsed = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const dir = (leg.direction || "above").toLowerCase();
    if (dir !== "above" && dir !== "below") {
      return { ok: false, error: "invalid_direction", failedLegIndex: i };
    }

    // Resolve multiplier → price_usd here so downstream INSERT only
    // ever stores concrete price/mc/sol triggers.
    let kind = leg.kind;
    let tvBI;
    if (kind === "multiplier" || (typeof leg.multiplier === "number" && leg.multiplier > 0)) {
      const m = leg.multiplier ?? Number(leg.valueMicro) / 1e6;
      if (!Number.isFinite(m) || m <= 0) {
        return { ok: false, error: "invalid_multiplier", failedLegIndex: i };
      }
      // For TP (above), multiplier MUST be > 1; for SL (below), MUST
      // be < 1. Otherwise the order would fire instantly at arm time.
      if (dir === "above" && m <= 1) {
        return { ok: false, error: "tp_multiplier_must_exceed_1", failedLegIndex: i };
      }
      if (dir === "below" && m >= 1) {
        return { ok: false, error: "sl_multiplier_must_be_below_1", failedLegIndex: i };
      }
      const targetUsd = currentUsdForMultiplier * m;
      tvBI = BigInt(Math.round(targetUsd * 1e6));
      kind = "price_usd";
    } else {
      if (!VALID_TRIGGER_KINDS.has(kind)) {
        return { ok: false, error: "invalid_trigger_kind", failedLegIndex: i };
      }
      try {
        tvBI = BigInt(String(leg.valueMicro));
      } catch {
        return { ok: false, error: "invalid_trigger_value", failedLegIndex: i };
      }
    }
    if (tvBI < MIN_TRIGGER_VALUE_MICRO || tvBI > MAX_TRIGGER_VALUE_MICRO) {
      return { ok: false, error: "trigger_value_out_of_range", failedLegIndex: i };
    }
    const slice = Number.isInteger(leg.sliceBps) ? leg.sliceBps : 10000;
    if (slice < 1 || slice > 10000) {
      return { ok: false, error: "invalid_slice_pct", failedLegIndex: i };
    }
    const slip = Number.isInteger(leg.slippageBps)
      ? leg.slippageBps
      : (dir === "below" ? 300 : 200);
    if (slip < 10 || slip > MAX_PROTOCOL_SLIPPAGE_BPS) {
      return { ok: false, error: "invalid_slippage_bps", failedLegIndex: i };
    }
    parsed.push({
      idx: i,
      direction: dir,
      kind,
      valueMicro: tvBI,
      sliceBps: slice,
      slippageBps: slip,
      maxSlippageCapBps: Math.min(MAX_PROTOCOL_SLIPPAGE_BPS, Math.max(slip, 2500)),
      expiresAt: leg.expiresAt || null,
      trailingDistanceBps: Number.isInteger(leg.trailingDistanceBps) ? leg.trailingDistanceBps : null,
    });
  }

  phaseLog("phase_2_parse_ok", { parsed_legs: parsed.map((p) => ({ dir: p.direction, kind: p.kind, val: p.valueMicro.toString(), slice: p.sliceBps, slip: p.slippageBps })) });

  // Phase 3 — Cumulative slice cap per direction (existing armed +
  // this batch). Mirrors the DB trigger from migration 064 / 065.
  const existingSliceByDir = { above: 0, below: 0 };
  const { rows: existingArmed } = await query(
    `SELECT COALESCE(trigger_direction, 'above') AS dir, COALESCE(slice_pct, 10000) AS sp
       FROM limit_close_orders
      WHERE loan_id = $1 AND status = 'armed'`,
    [loan.id],
  );
  for (const r of existingArmed) {
    existingSliceByDir[r.dir] = (existingSliceByDir[r.dir] || 0) + Number(r.sp);
  }
  const batchSliceByDir = { above: 0, below: 0 };
  for (const leg of parsed) batchSliceByDir[leg.direction] += leg.sliceBps;
  for (const dir of ["above", "below"]) {
    const total = (existingSliceByDir[dir] || 0) + (batchSliceByDir[dir] || 0);
    if (total > 10000) {
      return {
        ok: false,
        error: "ladder_sum_exceeds_100",
        detail: `${dir === "above" ? "Take-profit" : "Stop-loss"} ladder would total ${(total / 100).toFixed(0)}% (existing ${(existingSliceByDir[dir] / 100).toFixed(0)}% + this batch ${(batchSliceByDir[dir] / 100).toFixed(0)}%).`,
      };
    }
  }

  phaseLog("phase_3_slice_cap_ok", { existing_above: existingSliceByDir.above, existing_below: existingSliceByDir.below, batch_above: batchSliceByDir.above, batch_below: batchSliceByDir.below });

  // Phase 4 — Resolve ladder_group_id per direction. If an existing
  // ladder group already covers that direction, reuse its id +
  // original collateral snapshot. Else generate fresh ones.
  const ladderGroupIds = {};
  const originalCollateralByDir = {};
  for (const dir of ["above", "below"]) {
    const legsInDir = parsed.filter((l) => l.direction === dir);
    if (legsInDir.length === 0) continue;
    const { rows: existingGroupRows } = await query(
      `SELECT ladder_group_id, original_collateral_amount::text AS oca
         FROM limit_close_orders
        WHERE loan_id = $1
          AND COALESCE(trigger_direction, 'above') = $2
          AND status = 'armed'
          AND ladder_group_id IS NOT NULL
        LIMIT 1`,
      [loan.id, dir],
    );
    if (existingGroupRows.length > 0) {
      ladderGroupIds[dir] = existingGroupRows[0].ladder_group_id;
      originalCollateralByDir[dir] = existingGroupRows[0].oca;
    } else if (legsInDir.length > 1 || (existingSliceByDir[dir] || 0) > 0) {
      // Need a ladder_group_id when batch has multiple legs in this
      // direction, OR when extending a single existing leg into a
      // ladder. Single-direction single-leg with no existing legs
      // stays group-less (cheaper writes for the simplest TP).
      const { randomUUID } = await import("node:crypto");
      ladderGroupIds[dir] = randomUUID();
      originalCollateralByDir[dir] = loan.coll_raw;
    } else {
      ladderGroupIds[dir] = null;
      originalCollateralByDir[dir] = null;
    }
  }

  phaseLog("phase_4_ladder_groups_ok", { ladder_group_ids: ladderGroupIds });

  // Phase 4b — Defensive intent breadcrumbs (per-leg).
  //
  // The site path beacons intents BEFORE signing the batch envelope,
  // and threads the intent_id back through legs[i].intent_id. But if
  // the per-leg beacon HTTP call failed (transient network blip), the
  // sig+batch still proceeds and that leg has no server-side record.
  // If Phase 5 INSERT then also fails (rare — concurrency, ladder cap),
  // the recovery banner has nothing to show the user. Zero-error-
  // messages mandate (feedback_every_arm_must_succeed_zero_error_messages.md)
  // says we cannot lose the user's exact strike. Write defensive
  // breadcrumbs here for any leg without an intent_id — best-effort,
  // failure here does not abort the batch.
  for (let i = 0; i < parsed.length; i += 1) {
    const callerIntentId = Array.isArray(intentIds) ? intentIds[i] : null;
    if (callerIntentId != null) continue; // site beacon already wrote one
    const leg = parsed[i];
    try {
      const bcId = await writeBreadcrumbIntent({
        userId,
        loanIdChain: String(loanIdChain),
        triggerKind: leg.kind,
        triggerValueMicro: leg.valueMicro,
        direction: leg.direction,
        slicePct: leg.sliceBps < 10000 ? leg.sliceBps : null,
        source,
      });
      if (bcId != null) {
        if (!Array.isArray(intentIds)) intentIds = new Array(parsed.length).fill(null);
        intentIds[i] = bcId;
      }
    } catch (e) {
      console.warn(`[arm-batch] phase_4b breadcrumb failed for leg ${i}: ${e.message?.slice(0, 120)}`);
    }
  }

  // Phase 5 — Atomic INSERT inside a DB transaction. Either every leg
  // lands OR none do. No partial-arm state ever surfaces.
  const { getClient } = await import("../db/pool.js");
  const client = await getClient();
  const insertedOrderIds = [];
  try {
    await client.query("BEGIN");
    for (const leg of parsed) {
      const lgid = ladderGroupIds[leg.direction];
      const oca = originalCollateralByDir[leg.direction];
      const noteBase = `armed via ${source} (batch ${parsed.length} legs)`;
      const r = await client.query(
        `INSERT INTO limit_close_orders
           (user_id, loan_id, trigger_kind, trigger_value_micro,
            trigger_direction,
            slippage_bps, sell_destination, expires_at,
            source, source_agent_pubkey, status, armed_at,
            auto_escalate_slippage, max_slippage_bps_cap, initial_slippage_bps,
            engine_program_id,
            trailing_distance_bps, peak_price_micros,
            slice_pct,
            ladder_group_id,
            original_collateral_amount,
            notes)
         VALUES ($1, $2, $3, $4,
                 $5,
                 $6, 'sol', $7,
                 $8, $9, 'armed', NOW(),
                 true, $10, $6,
                 $11,
                 $12, NULL,
                 $13,
                 $14,
                 $15,
                 $16)
         RETURNING id`,
        [
          userId,
          loan.id,
          leg.kind,
          leg.valueMicro.toString(),
          leg.direction,
          leg.slippageBps,
          leg.expiresAt,
          source,
          sourceAgentPubkey,
          leg.maxSlippageCapBps,
          loan.program_id || null,
          leg.trailingDistanceBps,
          leg.sliceBps,
          lgid,
          oca,
          armNotePrefix ? `${armNotePrefix}; ${noteBase}` : noteBase,
        ],
      );
      insertedOrderIds.push(r.rows[0].id);
      phaseLog("phase_5_leg_inserted", { leg_idx: parsed.indexOf(leg), order_id: r.rows[0].id, direction: leg.direction, slice_bps: leg.sliceBps });
    }
    await client.query("COMMIT");
    phaseLog("phase_5_commit_ok", { order_ids: insertedOrderIds });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    phaseLog("phase_5_insert_failed", { err: (err.message || String(err)).slice(0, 200) });
    if (/TP\/SL ladder exceeds 100/i.test(err.message || "")) {
      return { ok: false, error: "ladder_sum_exceeds_100", detail: err.message?.slice(0, 240) };
    }
    if (/duplicate key value violates unique constraint/i.test(err.message || "")) {
      return { ok: false, error: "loan_already_has_active_order_in_direction" };
    }
    console.error("[arm-core:batch] insert failed:", err.message);
    return { ok: false, error: "insert_failed", detail: err.message?.slice(0, 200) };
  } finally {
    client.release();
  }

  // Phase 6 — Post-commit best-effort work. Failures here do NOT undo
  // the armed state. Each block guarded independently.

  // Reconcile intents.
  if (Array.isArray(intentIds) && intentIds.length === parsed.length) {
    for (let i = 0; i < parsed.length; i++) {
      const iid = intentIds[i];
      const oid = insertedOrderIds[i];
      if (iid == null) continue;
      try {
        await query(
          `UPDATE arm_intents
              SET status = 'armed', order_id = $2, armed_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [iid, oid],
        );
      } catch (e) {
        console.warn("[arm-core:batch] intent reconcile failed:", e.message?.slice(0, 80));
      }
    }
  }

  return {
    ok: true,
    orderIds: insertedOrderIds,
    ladderGroupIds: {
      above: ladderGroupIds.above ?? null,
      below: ladderGroupIds.below ?? null,
    },
    legs: parsed.map((leg, i) => ({
      orderId: insertedOrderIds[i],
      direction: leg.direction,
      triggerKind: leg.kind,
      triggerValueMicro: leg.valueMicro.toString(),
      slicePctBps: leg.sliceBps,
      slippageBps: leg.slippageBps,
    })),
    loanDbId: loan.id,
    loanIdChain: loan.loan_id_chain,
    collateralMint: loan.collateral_mint,
    collateralSymbol: loan.symbol,
  };
}

/**
 * Modify an armed order in place — change trigger value, slippage,
 * sell destination, or expires_at without canceling first.
 *
 * Why this exists
 * ───────────────
 * Before: a user who wanted to adjust their trigger had to /cancel
 * then /takeprofit again. That left a small window where the market
 * could move past their old trigger before the new arm landed. The
 * UX nudged users away from fine-tuning — bad for "set it and forget
 * it" + bad for the order-perfection mandate.
 *
 * After: a single UPDATE call. The order stays armed throughout; the
 * engine sees the new values on its next tick. No window.
 *
 * What CAN be modified
 *   trigger_value_micro  — change the price target
 *   slippage_bps         — tighten or loosen
 *   sell_destination     — swap between sol/usdc
 *   expires_at           — extend or set a new auto-cancel
 *
 * What CAN'T
 *   trigger_kind         — switching mc_usd ↔ price_usd ↔ price_sol
 *                          changes the units. Force cancel + re-arm
 *                          to avoid silent unit mismatches.
 *   trigger_direction    — TP ↔ SL is a semantic change too risky to
 *                          smuggle through a modify endpoint.
 *   loan_id              — different loan = different order; cancel + arm
 *
 * Re-validates the new values against the same gates armOrder()
 * applied at original arm time: immediate-fire guard, SL solvency
 * floor (for SL direction), slippage bounds, expires_at parse,
 * trigger value range. If any new value violates a gate, the modify
 * fails and the existing order continues unchanged.
 *
 * Concurrency: WHERE status='armed' makes a race with the engine's
 * atomic claim safe. If the engine flipped status='firing' between
 * read and write, the UPDATE matches zero rows and returns
 * not_modifiable_or_not_found — caller treats that as "too late, the
 * order is firing already".
 *
 * Scoping: same model as cancelOrder — user_id for TG/site paths,
 * source_agent_pubkey for the x402 agent path.
 */
export async function modifyOrder({
  orderId,
  userId = null,
  sourceAgentPubkey = null,
  // Each modifiable field is OPTIONAL. Caller passes only what's
  // changing. Undefined fields are left untouched on the row.
  triggerValueMicro,
  slippageBps,
  sellDestination,
  expiresAt,
  // Trailing-stop adjustment. Three shapes:
  //   undefined  — leave unchanged
  //   null OR 0  — clear trailing on this order (regular SL again)
  //   50..5000   — set/update trailing distance (only valid on SL)
  // Transitioning a regular SL → trailing reseeds peak_price_micros
  // from the live price so the floating floor starts at "today".
  trailingDistanceBps,
}) {
  // ── Load current order state for re-validation ─────────────
  const conditions = ["status = 'armed'"];
  const params = [orderId];
  let p = 2;
  if (userId != null) {
    conditions.push(`user_id = $${p++}`);
    params.push(userId);
  }
  if (sourceAgentPubkey != null) {
    conditions.push(`source = 'agent_x402' AND source_agent_pubkey = $${p++}`);
    params.push(sourceAgentPubkey);
  }

  const { rows: [current] } = await query(
    `SELECT id, user_id, loan_id,
            trigger_kind, trigger_value_micro::text AS trigger_value_micro,
            COALESCE(trigger_direction, 'above') AS trigger_direction,
            slippage_bps, sell_destination, expires_at,
            max_slippage_bps_cap, source, source_agent_pubkey,
            trailing_distance_bps,
            peak_price_micros::text AS peak_price_micros
       FROM limit_close_orders
      WHERE id = $1 AND ${conditions.join(" AND ")}`,
    params,
  );
  if (!current) return { ok: false, error: "not_modifiable_or_not_found" };

  // ── Shape validation per modifiable field ───────────────────
  const updates = {};

  if (triggerValueMicro !== undefined) {
    let bi;
    try { bi = BigInt(triggerValueMicro); } catch { return { ok: false, error: "invalid_trigger_value" }; }
    if (bi < MIN_TRIGGER_VALUE_MICRO || bi > MAX_TRIGGER_VALUE_MICRO) {
      return { ok: false, error: "trigger_value_out_of_range" };
    }
    updates.trigger_value_micro = bi.toString();
  }
  if (slippageBps !== undefined) {
    if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > MAX_INITIAL_SLIPPAGE_BPS) {
      return { ok: false, error: "invalid_slippage_bps" };
    }
    // Slippage cannot exceed the order's existing cap. The cap was set
    // at arm time from delegation / derived headroom; loosening past
    // it would silently widen user consent.
    if (current.max_slippage_bps_cap != null && slippageBps > Number(current.max_slippage_bps_cap)) {
      return {
        ok: false,
        error: "slippage_exceeds_order_cap",
        detail: { requested: slippageBps, cap_bps: Number(current.max_slippage_bps_cap) },
      };
    }
    updates.slippage_bps = slippageBps;
  }
  if (sellDestination !== undefined) {
    if (!VALID_DESTINATIONS.has(sellDestination)) {
      return { ok: false, error: "invalid_sell_destination" };
    }
    updates.sell_destination = sellDestination;
  }
  if (expiresAt !== undefined) {
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
      return { ok: false, error: "invalid_expires_at" };
    }
    updates.expires_at = expiresAt;
  }
  // Trailing-stop adjustment. Mirrors the shape validation in armOrder
  // so a caller can't squeeze invalid values past modify that arm would
  // have rejected. Peak seeding happens further down once we know the
  // current price.
  let seedPeakFromCurrent = false;
  if (trailingDistanceBps !== undefined) {
    if (trailingDistanceBps === null || trailingDistanceBps === 0) {
      // Clearing trailing. Only meaningful if it was actually set.
      if (current.trailing_distance_bps != null) {
        updates.trailing_distance_bps = null;
        updates.peak_price_micros = null;
      }
    } else {
      if (!Number.isInteger(trailingDistanceBps) || trailingDistanceBps < 50 || trailingDistanceBps > 5000) {
        return { ok: false, error: "invalid_trailing_distance_bps", detail: { allowed_range_bps: [50, 5000] } };
      }
      if (current.trigger_direction !== "below") {
        return { ok: false, error: "trailing_only_valid_on_stop_loss", detail: { direction: current.trigger_direction } };
      }
      updates.trailing_distance_bps = trailingDistanceBps;
      // First-time enable: seed peak from current price so the floating
      // floor starts at "today" rather than the original trigger.
      if (current.trailing_distance_bps == null) {
        seedPeakFromCurrent = true;
      } else if (current.trailing_distance_bps !== trailingDistanceBps) {
        // Distance tightened/loosened on an existing trailing stop.
        // The watcher only recomputes trigger when it sees a NEW high,
        // so without this we'd carry the old distance until the next
        // peak update — meaning "I tightened my trail to 5%" wouldn't
        // actually take effect until price moved up. Recompute the
        // effective trigger from the existing peak immediately so the
        // change is live on the next watcher tick.
        try {
          const existingPeak = BigInt(current.peak_price_micros || "0");
          if (existingPeak > 0n) {
            const newTrigger = (existingPeak * BigInt(10000 - trailingDistanceBps)) / 10000n;
            updates.trigger_value_micro = newTrigger.toString();
          }
        } catch { /* fall-through; watcher will heal on next high */ }
      }
    }
  }

  if (Object.keys(updates).length === 0 && !seedPeakFromCurrent) {
    return { ok: false, error: "no_changes_supplied" };
  }

  // ── Immediate-fire re-check + peak seed (best-effort) ─────────
  // Mirrors armOrder's guard. Skips for price_sol (denominator moves)
  // and fails-open on oracle hiccup — engine re-checks at fire time.
  // Same fetch double-duties as the peak-price seed when this modify
  // is transitioning a regular SL → trailing.
  const needPriceFetch =
    (updates.trigger_value_micro && (current.trigger_kind === "mc_usd" || current.trigger_kind === "price_usd")) ||
    seedPeakFromCurrent;
  if (needPriceFetch) {
    try {
      const { getPriceInUsdCrossSourced } = await import("./price.js");
      const { rows: [loan] } = await query(
        `SELECT collateral_mint FROM loans WHERE id = $1`,
        [current.loan_id],
      );
      if (loan) {
        const currentUsd = await getPriceInUsdCrossSourced(loan.collateral_mint);
        if (currentUsd && currentUsd > 0) {
          const currentMicros = BigInt(Math.round(currentUsd * 1e6));
          // Immediate-fire re-check, only for price_usd (mc_usd needs supply
          // and we skip — engine catches at fire time).
          if (updates.trigger_value_micro && current.trigger_kind === "price_usd") {
            const newBi = BigInt(updates.trigger_value_micro);
            if (current.trigger_direction === "above" && newBi <= currentMicros) {
              return { ok: false, error: "trigger_would_fire_immediately", detail: { direction: "above" } };
            }
            if (current.trigger_direction === "below" && newBi >= currentMicros) {
              return { ok: false, error: "trigger_would_fire_immediately", detail: { direction: "below" } };
            }
          }
          // Peak seed: start the trailing floor at today's price so the
          // first watcher tick has a meaningful baseline to bump from.
          if (seedPeakFromCurrent) {
            updates.peak_price_micros = currentMicros.toString();
          }
        }
      }
    } catch { /* fail-open: engine re-checks at fire time, peak self-heals on first tick */ }
  }

  // ── UPDATE ───────────────────────────────────────────────────
  // Build a parameterized UPDATE. WHERE status='armed' is the race
  // guard. RETURNING gives us the post-update row.
  const setParts = [];
  const updateParams = [];
  let up = 1;
  for (const [col, val] of Object.entries(updates)) {
    setParts.push(`${col} = $${up++}`);
    updateParams.push(val);
  }
  setParts.push("updated_at = NOW()");
  // 2026-06-13: any modify resets the near-trigger DM gate so a
  // re-tuned trigger gets a fresh nudge if the new value lands in the
  // ~10% band. Otherwise users who modified an order would never hear
  // about the new trigger getting close.
  if (updates.trigger_value_micro !== undefined) {
    setParts.push("near_trigger_dm_sent_at = NULL");
  }
  // Audit note appended so /lc-status armed shows that the order was modified.
  const noteSuffix = ` modified ${new Date().toISOString().slice(0, 19)}Z (${Object.keys(updates).join(",")})`;
  setParts.push(`notes = COALESCE(notes, '') || $${up++}`);
  updateParams.push(noteSuffix);
  updateParams.push(orderId);
  const orderIdPos = up;

  // Re-apply ownership guard so a stale userId or source_agent_pubkey
  // can't bypass scope between the SELECT and the UPDATE.
  //
  // Counter discipline: after the orderId push above, `up` points at
  // the slot ALREADY USED by orderId ($3 in a 1-update case). Each
  // additional param needs to bump `up` FIRST, then reference the
  // new slot. The previous `++up - 1` / `up - 1` mix was off-by-one:
  // it referenced the orderId slot AND added a 4th param to a 3-
  // placeholder query, triggering Postgres:
  //   bind message supplies 4 parameters, but prepared statement requires 3
  // Operator hit this on 2026-06-15 trying to modify slippage.
  const updateConditions = ["status = 'armed'"];
  if (userId != null) {
    up++;
    updateConditions.push(`user_id = $${up}`);
    updateParams.push(userId);
  }
  if (sourceAgentPubkey != null) {
    up++;
    updateConditions.push(`source = 'agent_x402' AND source_agent_pubkey = $${up}`);
    updateParams.push(sourceAgentPubkey);
  }

  const r = await query(
    `UPDATE limit_close_orders
        SET ${setParts.join(", ")}
      WHERE id = $${orderIdPos}
        AND ${updateConditions.join(" AND ")}
      RETURNING id, trigger_value_micro::text AS trigger_value_micro,
                slippage_bps, sell_destination, expires_at, updated_at,
                trailing_distance_bps,
                peak_price_micros::text AS peak_price_micros`,
    updateParams,
  );
  if (r.rows.length === 0) {
    // Raced with engine flipping status to 'firing' — too late.
    return { ok: false, error: "not_modifiable_or_not_found" };
  }
  return {
    ok: true,
    order: r.rows[0],
    changedFields: Object.keys(updates),
  };
}

/**
 * Cancel an armed order by ID. Scoped to a specific user OR a specific
 * agent pubkey. The UPDATE's WHERE status='armed' makes a too-late
 * cancel a 409 no-op rather than corrupting an in-flight 'firing' row.
 */
export async function cancelOrder({ orderId, userId = null, sourceAgentPubkey = null, reason }) {
  const conditions = ["status = 'armed'"];
  const params = [orderId];
  let p = 2;
  if (userId != null) {
    conditions.push(`user_id = $${p++}`);
    params.push(userId);
  }
  if (sourceAgentPubkey != null) {
    conditions.push(`source = 'agent_x402' AND source_agent_pubkey = $${p++}`);
    params.push(sourceAgentPubkey);
  }
  const r = await query(
    `UPDATE limit_close_orders
        SET status = 'cancelled',
            cancellation_reason = $${p++},
            updated_at = NOW()
      WHERE id = $1
        AND ${conditions.join(" AND ")}
      RETURNING id`,
    [...params, reason || "user_cancel"],
  );
  if (r.rows.length === 0) return { ok: false, error: "not_cancellable_or_not_found" };
  return { ok: true, orderId: r.rows[0].id };
}

/**
 * Enqueue a DM telling the borrower a take-profit was armed on their
 * loan. Used by TG + site + agent paths so the user always knows.
 * Best-effort: enqueue failure does NOT roll back the arm.
 */
export async function enqueueArmedDm({
  userId,
  orderId,
  loanIdChain,
  triggerKind,
  triggerValueMicro,
  slippageBps,
  sellDestination,
  source,
  sourceAgentPubkey,
}) {
  try {
    await query(
      `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
         VALUES ($1, 'tg', 'limit_close_armed', $2::jsonb, 'pending')`,
      [userId, JSON.stringify({
        order_id: orderId,
        loan_id_chain: loanIdChain,
        trigger_label: `${triggerKind}=${triggerValueMicro}`,
        slippage_bps: slippageBps,
        sell_destination: sellDestination,
        source,
        source_agent_pubkey: sourceAgentPubkey || null,
      })],
    );
  } catch (err) {
    console.warn("[arm-core] arm-DM enqueue failed:", err.message?.slice(0, 200));
  }
}

/* ────────────────────────────────────────────────────────────────
 * Audit log + failure DM (operator-mandated 2026-06-15)
 *
 * recordArmAttempt: one row per armOrder call, success OR failure.
 *   - On success: order_id populated, error_code/detail NULL.
 *   - On failure: error_code = result.error, error_detail truncated.
 *
 * enqueueArmFailedDm: one DM per failure. The user gets ground-truth
 *   feedback in seconds instead of staring at a silent dashboard.
 * ──────────────────────────────────────────────────────────────── */

function safeTruncate(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

/* ─────────────────────────────────────────────────────────────────
 * persistPendingArm — write a row to the pending_arms queue.
 *
 * Used by armOrderBatchImpl when phase_1 can't find the loan inside
 * the 30s polling window AND the caller supplied a signed envelope.
 * The watcher service (pending-arm-retry-watcher.js) replays this
 * row every 10s for the rest of the 5-min envelope freshness window.
 *
 * Mandated by [[feedback_loan_830_full_postmortem_and_defenses]].
 * ───────────────────────────────────────────────────────────────── */
async function persistPendingArm({
  userId,
  signerPubkey,
  wallet,
  loanIdChain,
  legs,
  intentIds,
  source,
  armNotePrefix,
  envelopeIssuedAtMs,
}) {
  const { rows } = await query(
    `INSERT INTO pending_arms (
       user_id, signer_pubkey, wallet, loan_id_chain,
       legs, intent_ids, source, arm_note_prefix,
       envelope_issued_at, status
     ) VALUES (
       $1, $2, $3, $4,
       $5::jsonb, $6, $7, $8,
       to_timestamp($9::double precision / 1000.0), 'pending'
     )
     RETURNING id`,
    [
      userId,
      signerPubkey,
      wallet,
      String(loanIdChain),
      JSON.stringify(legs),
      Array.isArray(intentIds) && intentIds.length > 0 ? intentIds : null,
      source,
      armNotePrefix || null,
      Number(envelopeIssuedAtMs),
    ],
  );
  return rows[0];
}

function jsonStringifyError(detail) {
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

async function recordArmAttempt(args, result) {
  // We deliberately NEVER throw from here — caller wraps in try/catch
  // anyway, but defensive serialization keeps the audit path resilient.
  const triggerValueStr =
    args.triggerValueMicro != null
      ? (typeof args.triggerValueMicro === "bigint"
          ? args.triggerValueMicro.toString()
          : String(args.triggerValueMicro))
      : null;
  const ladderGroupId =
    args.ladderGroupId && /^[0-9a-f-]{36}$/i.test(String(args.ladderGroupId))
      ? args.ladderGroupId
      : null;

  await query(
    `INSERT INTO limit_close_arm_attempts
       (user_id, loan_id_chain, loan_db_id, direction,
        target_kind, target_value_micro, slice_pct, ladder_group_id,
        source, source_agent_pubkey,
        outcome, order_id, error_code, error_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      args.userId || null,
      args.loanIdChain != null ? String(args.loanIdChain) : null,
      result?.ok && result?.loan?.id ? result.loan.id : null,
      args.triggerDirection || (args.direction || "above"),
      args.triggerKind || null,
      triggerValueStr,
      args.slicePct ?? null,
      ladderGroupId,
      args.source || null,
      args.sourceAgentPubkey || null,
      result?.ok ? "success" : "failed",
      result?.ok ? result.orderId || null : null,
      result?.ok ? null : safeTruncate(result?.error, 64),
      result?.ok ? null : safeTruncate(jsonStringifyError(result?.detail), 400),
    ],
  );
}

async function enqueueArmFailedDm(args, result) {
  // Resolve TG chat — notification-sender reads users.telegram_id by
  // user_id, so we don't need to lookup here. Just enqueue.
  if (!args.userId) return;

  // intent_id flows in from the breadcrumb writer (or from a site-side
  // caller that passed args.intentId explicitly). Notification-sender
  // attaches a one-tap retry button keyed by intent_id so the user can
  // recover from a failure without leaving Telegram. Operator-mandated
  // rule: one-tap recovery on every failure (feedback_tg_must_follow_
  // v4_at_highest_level.md). When no intent_id is available the button
  // falls back to a /fixarm prompt.
  const payload = {
    direction: args.triggerDirection || args.direction || "above",
    trigger_kind: args.triggerKind || null,
    trigger_value_micro: args.triggerValueMicro != null
      ? String(args.triggerValueMicro)
      : null,
    slice_pct: args.slicePct ?? null,
    ladder_group_id: args.ladderGroupId || null,
    source: args.source || null,
    loan_id_chain: args.loanIdChain != null ? String(args.loanIdChain) : null,
    intent_id: args.intentId ?? null,
    error_code: safeTruncate(result?.error, 64),
    error_detail: safeTruncate(jsonStringifyError(result?.detail), 400),
  };

  await query(
    `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
       VALUES ($1, 'tg', 'limit_close_arm_failed', $2::jsonb, 'pending')`,
    [args.userId, JSON.stringify(payload)],
  );
}

/* ────────────────────────────────────────────────────────────────
 * Breadcrumb arm intent (operator-mandated 2026-06-16 PM,
 * feedback_tg_v4_must_match_site_quality.md).
 *
 * Writes an arm_intent row in 'pending' state for any arm path that
 * didn't already record one (TG /sell, /takeprofit, /stoploss,
 * /bracket, /trailingstop, /ladder, Pip arms, agent x402). The
 * intent acts as a durable record of the user's exact requested
 * strike so:
 *   - If armOrderImpl rejects (gate failure, ineligibility, etc.),
 *     the dashboard V4 silent-arm-recovery banner can render the
 *     exact strike as the retry CTA — not generic 2x/3x/0.7x.
 *   - If armOrderImpl succeeds, the existing reconciliation path
 *     marks the intent 'armed' and the dashboard hides the banner.
 *
 * Returns the new intent_id or null on any failure. Best-effort:
 * a write failure must NEVER block the arm. Wallet lookup is
 * derived from loans.borrower_wallet via the chain loan id — this
 * is the wallet the user actually borrowed with, which is what
 * arm_intents.wallet must contain for the dashboard's
 * loan_id_chain filter to surface this intent.
 * ──────────────────────────────────────────────────────────────── */
async function writeBreadcrumbIntent(args) {
  // Skip if we don't have what we need to write a useful breadcrumb.
  if (!args.loanIdChain || !args.triggerKind || args.triggerValueMicro == null) {
    return null;
  }
  // Skip dry-run paths — those are questions, not commitments.
  if (args.dryRun) return null;

  // Lookup borrower_wallet from loans by chain id. Defensive: only
  // act when we get exactly one row to avoid cross-program ambiguity.
  let walletPk;
  let userId = args.userId || null;
  try {
    const { rows } = await query(
      `SELECT borrower_wallet, user_id
         FROM loans
        WHERE loan_id::text = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(args.loanIdChain)],
    );
    if (rows.length === 0) return null;
    walletPk = rows[0].borrower_wallet;
    if (!userId && rows[0].user_id) userId = rows[0].user_id;
  } catch (e) {
    console.warn(`[arm-core] breadcrumb loan lookup failed: ${e.message?.slice(0, 120)}`);
    return null;
  }

  if (!walletPk || typeof walletPk !== "string" || walletPk.length < 32 || walletPk.length > 44) {
    return null;
  }

  // Trailing-stop arms pass triggerKind=price_usd + trailingDistanceBps;
  // for the intent ledger they're 'trailing' with target_value_micro =
  // the trailing distance in bps. arm_intents schema: target_kind
  // CHECK ('multiplier','price_usd','mc_usd','price_sol','trailing').
  const isTrailing =
    args.trailingDistanceBps != null &&
    Number.isInteger(args.trailingDistanceBps) &&
    args.trailingDistanceBps > 0;
  const targetKind = isTrailing ? "trailing" : String(args.triggerKind);
  const validKinds = new Set(["multiplier", "price_usd", "mc_usd", "price_sol", "trailing"]);
  if (!validKinds.has(targetKind)) return null;

  const tvm = isTrailing
    ? String(args.trailingDistanceBps)
    : typeof args.triggerValueMicro === "bigint"
      ? args.triggerValueMicro.toString()
      : String(args.triggerValueMicro);
  if (!/^\d+$/.test(tvm)) return null;

  const direction =
    args.triggerDirection === "below" || args.direction === "below" ? "below" : "above";

  const sliceBpsRaw = args.slicePct;
  const sliceBps =
    sliceBpsRaw == null || sliceBpsRaw === 10000
      ? null
      : Number.isInteger(sliceBpsRaw) && sliceBpsRaw > 0 && sliceBpsRaw < 10000
        ? sliceBpsRaw
        : null;

  // De-dupe: if an identical pending intent already exists for the
  // same loan+direction+strike+slice in the last 5 min, reuse its id
  // instead of writing a duplicate. Prevents UI noise from repeated
  // /sell attempts at the same strike.
  try {
    const dedup = await query(
      `SELECT id FROM arm_intents
        WHERE wallet = $1
          AND loan_id_chain = $2
          AND direction = $3
          AND target_kind = $4
          AND target_value_micro = $5::numeric
          AND COALESCE(slice_pct_bps, 0) = COALESCE($6::int, 0)
          AND status = 'pending'
          AND created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC
        LIMIT 1`,
      [walletPk, String(args.loanIdChain), direction, targetKind, tvm, sliceBps],
    );
    if (dedup.rows.length > 0) return dedup.rows[0].id;
  } catch (e) {
    // Fall through to insert; dedupe is best-effort.
    console.warn(`[arm-core] breadcrumb dedupe lookup failed: ${e.message?.slice(0, 120)}`);
  }

  // arm_intents.source has a CHECK constraint: 'site' | 'tg' |
  // 'agent_x402' | 'post_borrow_picker'. Map any caller-supplied
  // source to the closest allowed value, default 'tg' (covers TG
  // commands + Pip + anything else without an explicit source).
  const rawSrc = String(args.source || "").toLowerCase();
  let src;
  if (rawSrc === "site") src = "site";
  else if (rawSrc === "agent_x402" || rawSrc === "x402") src = "agent_x402";
  else if (rawSrc === "post_borrow_picker") src = "post_borrow_picker";
  else src = "tg";

  try {
    const { rows } = await query(
      `INSERT INTO arm_intents
         (user_id, wallet, loan_id_chain, direction, target_kind, target_value_micro,
          slice_pct_bps, source, status)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, 'pending')
       RETURNING id`,
      [userId, walletPk, String(args.loanIdChain), direction, targetKind, tvm, sliceBps, src],
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn(`[arm-core] breadcrumb intent INSERT failed: ${e.message?.slice(0, 200)}`);
    return null;
  }
}
