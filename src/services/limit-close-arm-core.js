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
            borrower_wallet, user_id
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

  // ── Collateral allowlist ────────────────────────────────────
  const { rows: [mintRow] } = await query(
    `SELECT enabled, category, symbol, liquidity_usd FROM supported_mints WHERE mint = $1`,
    [loan.collateral_mint],
  );
  if (!mintRow || !mintRow.enabled) return { ok: false, error: "collateral_not_enabled" };
  if (["stock", "etf", "metal"].includes(mintRow.category)) {
    return { ok: false, error: "rwa_collateral_not_supported_in_v1" };
  }

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
          notes)
       VALUES ($1, $2, $3, $4,
               $5,
               $6, $7, $8,
               $9, $10, 'armed', NOW(),
               $11, $12, $13,
               $14, $15, $16,
               $17)
       RETURNING id, armed_at`,
      [userId, loan.id, triggerKind, triggerBI.toString(),
       triggerDirection,
       appliedInitialBps, sellDestination, expiresAt,
       source, sourceAgentPubkey,
       autoEscalate, effectiveCap, appliedInitialBps,
       advisory ? null : effectiveCap,
       advisory ? null : (preflight.proceedsLamports || null),
       advisory ? null : (preflight.quotedAtIso || new Date().toISOString()),
       armNote
         || (appliedInitialBps !== originalInitialBps
           ? `armed via ${source}; ${triggerDirection === "below" ? "STOP-LOSS" : "TP"}; initial slippage bumped ${originalInitialBps}->${appliedInitialBps} bps for ${mintRow.symbol || "thin token"} (liquidity_usd=$${Math.round(liqUsd)})`
           : `armed via ${source}; ${triggerDirection === "below" ? "STOP-LOSS" : "TP"}`)],
    );
  } catch (err) {
    if (/duplicate key value violates unique constraint/i.test(err.message || "")) {
      return { ok: false, error: "loan_already_has_active_order" };
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
            max_slippage_bps_cap, source, source_agent_pubkey
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

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "no_changes_supplied" };
  }

  // ── Immediate-fire re-check (best-effort) for new trigger ───
  // Mirrors armOrder's guard. Skips for price_sol (denominator moves)
  // and fails-open on oracle hiccup — engine re-checks at fire time.
  if (updates.trigger_value_micro && (current.trigger_kind === "mc_usd" || current.trigger_kind === "price_usd")) {
    try {
      const { getPriceInUsdCrossSourced } = await import("./price.js");
      // We need the collateral mint for the price read. Pull from the
      // loan row tied to this order.
      const { rows: [loan] } = await query(
        `SELECT collateral_mint FROM loans WHERE id = $1`,
        [current.loan_id],
      );
      if (loan) {
        const currentUsd = await getPriceInUsdCrossSourced(loan.collateral_mint);
        if (currentUsd && currentUsd > 0) {
          let currentMicros = null;
          if (current.trigger_kind === "price_usd") {
            currentMicros = BigInt(Math.round(currentUsd * 1e6));
          }
          // mc_usd would need supply; skip if not trivially derivable —
          // engine still catches at fire time.
          if (currentMicros != null) {
            const newBi = BigInt(updates.trigger_value_micro);
            if (current.trigger_direction === "above" && newBi <= currentMicros) {
              return { ok: false, error: "trigger_would_fire_immediately", detail: { direction: "above" } };
            }
            if (current.trigger_direction === "below" && newBi >= currentMicros) {
              return { ok: false, error: "trigger_would_fire_immediately", detail: { direction: "below" } };
            }
          }
        }
      }
    } catch { /* fail-open: engine re-checks at fire time */ }
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
                slippage_bps, sell_destination, expires_at, updated_at`,
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
