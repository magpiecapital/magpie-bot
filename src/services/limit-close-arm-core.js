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

  // ── Immediate-fire guard (best-effort) ──────────────────────
  // Reject arms that would fire immediately:
  //   - 'above' (TP)  with trigger <= current
  //   - 'below' (SL)  with trigger >= current
  // The engine re-checks at fire time so this is purely a UX guard;
  // fail-open on any oracle hiccup so a transient price miss doesn't
  // block a legitimate arm. Implemented for USD-denominated triggers
  // (mc_usd, price_usd); price_sol skipped because the SOL denominator
  // moves fast enough that a stale read can false-reject.
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
  const { rows: [activeCount] } = await query(
    `SELECT COUNT(*)::int AS n FROM limit_close_orders
       WHERE user_id = $1 AND status = 'armed'`,
    [userId],
  );
  if (activeCount.n >= MAX_ACTIVE_ORDERS_PER_USER) {
    return { ok: false, error: "user_concurrency_cap_reached", detail: { active: activeCount.n, cap: MAX_ACTIVE_ORDERS_PER_USER } };
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

  // ── INSERT ──
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
