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

export const MIN_LOAN_LAMPORTS = BigInt(1_000_000_000n); // 1 SOL
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
  const currentUsd = await getPriceInUsdCrossSourced(collateralMint);
  if (!currentUsd || currentUsd <= 0) {
    return { ok: false, error: "Couldn't fetch current USD price right now — try again or use an explicit price target." };
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

export async function armOrder({
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
  const { rows: [loan] } = await query(
    `SELECT id, loan_id::text AS loan_id, status,
            original_loan_amount_lamports::text AS owed,
            collateral_mint, collateral_amount::text AS coll_amount,
            collateral_amount::text AS collateral_amount_raw,
            borrower_wallet, user_id, program_id
       FROM loans
      WHERE user_id = $1 AND loan_id = $2`,
    [userId, loanIdChain],
  );
  if (!loan) return { ok: false, error: "loan_not_found_for_user" };
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
  // V4_EXIT_EXCLUSIVE_ENFORCE env gates the rollout: set to "true"
  // to enforce, anything else (or unset) keeps legacy arming. Lets
  // the operator stage the cut-over without a code redeploy.
  if (process.env.V4_EXIT_EXCLUSIVE_ENFORCE === "true") {
    const v4ProgramIdStr = process.env.PROGRAM_ID_V4 ?? null;
    if (!v4ProgramIdStr) {
      // Defensive: enforce-on without V4 deployed would silently break
      // every arm. Refuse with a clear message instead.
      return {
        ok: false,
        error: "v4_not_configured",
        detail: "V4_EXIT_EXCLUSIVE_ENFORCE is on but PROGRAM_ID_V4 isn't set on this host. Either deploy V4 first, or unset V4_EXIT_EXCLUSIVE_ENFORCE.",
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
  const updateConditions = ["status = 'armed'"];
  if (userId != null) {
    updateConditions.push(`user_id = $${++up - 1}`);
    updateParams.push(userId);
    up++;
  }
  if (sourceAgentPubkey != null) {
    updateConditions.push(`source = 'agent_x402' AND source_agent_pubkey = $${up - 1}`);
    updateParams.push(sourceAgentPubkey);
    up++;
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
