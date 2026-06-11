/**
 * Premium-tier eligibility screener.
 *
 * Runtime gate for v3 Premium-tier borrows. Every Premium-tier borrow
 * must pass this before the bot authority signs the on-chain
 * request_and_fund_loan instruction.
 *
 * STATUS: DRAFT. Not wired into the borrow flow. Activation gated on
 * MGP-002 + MGP-003 + MGP-004 passing, the v3 program being deployed,
 * and the activation runbook in
 * docs/PREMIUM-TIER-SCREENER-SPEC.md being completed.
 *
 * Same { blocked, reason, message } result shape as anti-exploit.js
 * so the existing borrow-error UX renders unchanged.
 */
import { query } from "../db/pool.js";

const PREMIUM_TIER_MIN_VOLUME_USD = Number(
  process.env.PREMIUM_TIER_MIN_VOLUME_USD || 250_000,
);
const PREMIUM_TIER_MAX_UNWIND_SECONDS = Number(
  process.env.PREMIUM_TIER_MAX_UNWIND_SECONDS || 3_600,
);
const PREMIUM_TIER_MAX_LOAN_LAMPORTS = BigInt(
  process.env.PREMIUM_TIER_MAX_LOAN_LAMPORTS || "10000000000", // 10 SOL
);

// Friday-close cutoff. Tokenized stocks' AMM peg degrades 3-5% on
// weekend news/earnings events because the Backed/MM arb path goes
// stale once Kraken's full equity book closes. We refuse to ORIGINATE
// new premium-tier loans inside the weekend window so the borrower
// can't open a loan against TSLAx at Friday 4pm ET and watch earnings
// blow up the collateral over the weekend before any liquidator can
// react with reliable price data. Existing loans roll through the
// weekend unaffected — repay/extend/topup remain available.
//
// Window definition (UTC):
//   - Window CLOSES Friday at PREMIUM_TIER_WEEKEND_CLOSE_HOUR (default 21:00 UTC = 16:00 ET = US RTH close)
//   - Window REOPENS Monday at PREMIUM_TIER_WEEKEND_OPEN_HOUR (default 13:30 UTC = 08:30 ET = pre-market open)
//   - All of Saturday + Sunday refuse.
//   - PREMIUM_TIER_WEEKEND_CUTOFF_DISABLED=true bypasses the gate entirely.
const PREMIUM_TIER_WEEKEND_CLOSE_HOUR_UTC = Number(
  process.env.PREMIUM_TIER_WEEKEND_CLOSE_HOUR || 21,
);
const PREMIUM_TIER_WEEKEND_OPEN_HOUR_UTC = Number(
  process.env.PREMIUM_TIER_WEEKEND_OPEN_HOUR || 13,
);
const PREMIUM_TIER_WEEKEND_OPEN_MINUTE_UTC = Number(
  process.env.PREMIUM_TIER_WEEKEND_OPEN_MINUTE || 30,
);
const PREMIUM_TIER_WEEKEND_CUTOFF_DISABLED =
  process.env.PREMIUM_TIER_WEEKEND_CUTOFF_DISABLED === "true";

/**
 * Returns true if `at` is inside the weekend cutoff window where new
 * premium-tier borrows are refused.
 */
export function isInWeekendCutoff(at = new Date()) {
  if (PREMIUM_TIER_WEEKEND_CUTOFF_DISABLED) return false;
  const dow = at.getUTCDay();           // 0 Sun, 5 Fri, 6 Sat
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();
  if (dow === 6 || dow === 0) return true;                // Sat / Sun all day
  if (dow === 5 && hour >= PREMIUM_TIER_WEEKEND_CLOSE_HOUR_UTC) return true;  // Fri after close
  if (dow === 1) {                                         // Mon before open
    if (hour < PREMIUM_TIER_WEEKEND_OPEN_HOUR_UTC) return true;
    if (hour === PREMIUM_TIER_WEEKEND_OPEN_HOUR_UTC && minute < PREMIUM_TIER_WEEKEND_OPEN_MINUTE_UTC) return true;
  }
  return false;
}

/**
 * Returns a human-readable next-open timestamp in UTC for the message.
 */
function nextWeekendOpenIso(at = new Date()) {
  const dow = at.getUTCDay();
  const next = new Date(at);
  // Find next Monday (or stay on Monday if today is Monday before open)
  let daysToAdd;
  if (dow === 5) daysToAdd = 3;                  // Fri → Mon
  else if (dow === 6) daysToAdd = 2;             // Sat → Mon
  else if (dow === 0) daysToAdd = 1;             // Sun → Mon
  else daysToAdd = 0;                            // Mon early
  next.setUTCDate(at.getUTCDate() + daysToAdd);
  next.setUTCHours(PREMIUM_TIER_WEEKEND_OPEN_HOUR_UTC, PREMIUM_TIER_WEEKEND_OPEN_MINUTE_UTC, 0, 0);
  return next.toISOString().slice(0, 16) + " UTC";
}

/**
 * @param {object} opts
 * @param {string} opts.collateralMint base58 pubkey
 * @param {bigint} opts.proposedLoanLamports
 * @param {string} opts.borrowerPubkey base58
 * @param {"v1" | "v3-premium"} opts.pool
 * @param {number} [opts.now] Unix seconds; defaults to current
 * @returns {Promise<{ blocked: boolean, reason: string, message?: string }>}
 */
export async function screenPremiumBorrow(opts) {
  if (opts.pool !== "v3-premium") {
    return { blocked: false, reason: "non_premium_skip" };
  }

  const gateStart = Date.now();
  const gateTimes = {};

  // ── Gate 0: Friday-close cutoff ───────────────────────────────────
  // Refuse to ORIGINATE new premium-tier loans during the weekend window.
  // Cheap to evaluate (no DB / RPC) so it short-circuits before the rest.
  // Existing premium loans roll through the weekend unaffected.
  const at = opts.now ? new Date(opts.now * 1000) : new Date();
  if (isInWeekendCutoff(at)) {
    const reopens = nextWeekendOpenIso(at);
    return refused(
      "weekend_cutoff",
      `New premium-tier borrows pause Friday ${PREMIUM_TIER_WEEKEND_CLOSE_HOUR_UTC.toString().padStart(2, "0")}:00 UTC → Monday ${PREMIUM_TIER_WEEKEND_OPEN_HOUR_UTC.toString().padStart(2, "0")}:${PREMIUM_TIER_WEEKEND_OPEN_MINUTE_UTC.toString().padStart(2, "0")} UTC so US-equity peg + oracle data stay reliable. Existing premium loans are unaffected — repay/extend/topup remain available. New borrows reopen ${reopens}.`,
    );
  }

  // ── Gate 1: category gate ────────────────────────────────────────
  let t = Date.now();
  const { rows: [mintRow] } = await query(
    `SELECT enabled, protected, category
       FROM supported_mints WHERE mint = $1`,
    [opts.collateralMint],
  );
  gateTimes.category = Date.now() - t;

  if (!mintRow) {
    return refused("category_unknown_mint",
      "Token isn't in the protocol's approved list. Not eligible for Premium tier.");
  }
  if (mintRow.category !== "stock") {
    return refused("category_not_stock",
      "This token isn't eligible for Premium-tier borrowing. Premium tier is restricted to tokenized stocks; use a different tier for non-stock collateral.");
  }
  if (!mintRow.enabled) {
    return refused("category_disabled",
      "This token has been disabled and is not eligible for any new borrows. Existing loans can still be repaid.");
  }
  if (!mintRow.protected) {
    return refused("category_not_protected",
      "This stock hasn't completed the protected-collateral review yet. Not eligible for Premium tier.");
  }

  // ── Gate 2: Premium whitelist gate ───────────────────────────────
  t = Date.now();
  const { rows: [wlRow] } = await query(
    `SELECT mint, max_open_lamports, tier, max_ltv_bps
       FROM premium_tier_whitelist
       WHERE mint = $1 AND enabled = TRUE`,
    [opts.collateralMint],
  );
  gateTimes.whitelist = Date.now() - t;

  if (!wlRow) {
    return refused("not_on_premium_whitelist",
      "This stock isn't yet on the Premium-tier whitelist. The operator adds stocks via governance proposals (see magpie.capital/governance). For now, use a shorter-tier loan.");
  }

  // ── Gate 2b: tier-aware max LTV ──────────────────────────────────
  // The 90-day vol analysis (2026-06-10) showed crypto-adjacent
  // equities (COINx, MSTRx, HOODx, CRCLx) realize ~2.5x the volatility
  // of pure equities + ETFs. Migration 018 split the whitelist into
  // two tiers with different max LTV caps to match.
  //
  // proposedLtvBps is REQUIRED. A previous version made this optional
  // ("if not passed, no-op") — but every borrow path that calls this
  // function has an LTV; making it optional just meant a caller bug
  // (forgot to pass the field) silently disabled the entire tier-LTV
  // check and let a 70% LTV crypto-adjacent loan through against a
  // 50%-capped position. Fail closed.
  if (opts.proposedLtvBps == null) {
    return refused("proposed_ltv_missing",
      "Premium-tier screening requires a proposed LTV. Internal error — caller did not supply opts.proposedLtvBps.");
  }
  if (!Number.isInteger(opts.proposedLtvBps) || opts.proposedLtvBps <= 0 || opts.proposedLtvBps > 10_000) {
    return refused("proposed_ltv_invalid",
      `Premium-tier screening received an invalid proposed LTV (${opts.proposedLtvBps}). Expected an integer in bps between 1 and 10000.`);
  }
  const maxLtvBps = Number(wlRow.max_ltv_bps);
  if (!Number.isFinite(maxLtvBps) || maxLtvBps <= 0) {
    return refused("tier_max_ltv_missing",
      "This stock's Premium-tier max LTV isn't configured. Contact support — the operator needs to update the whitelist row.");
  }
  if (opts.proposedLtvBps > maxLtvBps) {
    const tierLabel = wlRow.tier === "crypto_adjacent"
      ? "crypto-adjacent equity (higher realized volatility)"
      : "blue-chip equity / ETF";
    return refused("ltv_exceeds_tier_cap",
      `This stock is in the Premium-tier *${tierLabel}* bucket, which caps LTV at ${(maxLtvBps / 100).toFixed(0)}%. You requested ${(opts.proposedLtvBps / 100).toFixed(0)}%. Lower your collateral amount or use a longer-term Express/Quick/Standard tier instead.`);
  }

  // ── Gate 3: institutional price feed gate ────────────────────────
  t = Date.now();
  const feedHealth = await fetchOracleFeedHealth(opts.collateralMint).catch(() => null);
  gateTimes.feed = Date.now() - t;

  if (!feedHealth || feedHealth.status !== "live") {
    return refused("feed_offline",
      "The price feed for this stock is currently offline. Premium tier requires a live institutional feed (Pyth/Switchboard). Try again when the feed recovers.");
  }
  if (feedHealth.age_seconds > 60) {
    return refused("feed_stale",
      `The price feed for this stock is ${Math.round(feedHealth.age_seconds)}s old (Premium tier requires fresh feed). Try again in a moment.`);
  }
  if (feedHealth.confidence_bps > 250) {
    return refused("feed_degraded",
      "The price feed for this stock is in a degraded-confidence state. Premium tier requires the feed in healthy mode. Try again later.");
  }

  // ── Gate 4: 24h volume floor ─────────────────────────────────────
  t = Date.now();
  const { rows: [mkt] } = await query(
    `SELECT volume_24h_usd, liquidity_usd
       FROM mint_market_metadata WHERE mint = $1`,
    [opts.collateralMint],
  );
  gateTimes.volume = Date.now() - t;

  const vol = Number(mkt?.volume_24h_usd || 0);
  if (vol < PREMIUM_TIER_MIN_VOLUME_USD) {
    return refused("volume_too_low",
      `This stock's 24h volume ($${Math.round(vol).toLocaleString()}) is below the Premium-tier floor ($${PREMIUM_TIER_MIN_VOLUME_USD.toLocaleString()}). Premium tier requires deep on-chain liquidity to safely support 30-day borrows.`);
  }

  // ── Gate 5: liquidation-solvability simulation ───────────────────
  t = Date.now();
  // collateralAmount implied by loan / LTV(40%) — caller passes loan,
  // we work backwards through the 40% LTV at the v3 Premium tier.
  const impliedCollateralUsd = Number(opts.proposedLoanLamports) / 1e9 * (1 / 0.40) * 200; // assumes ~$200/SOL placeholder; use feedHealth.price_sol_usd in production
  const liquidityUsd = Number(mkt?.liquidity_usd || 0);
  const sim = simulateLiquidation({
    collateralUsd: impliedCollateralUsd,
    liquidityUsd,
    worstCaseSlipBps: 1000,
  });
  gateTimes.simulation = Date.now() - t;

  if (!sim.solvable) {
    return refused("not_solvable",
      "At your borrow size, the protocol's liquidation simulator can't guarantee unwind at current on-chain depth. Try a smaller loan.");
  }
  if (sim.unwind_seconds_estimate > PREMIUM_TIER_MAX_UNWIND_SECONDS) {
    return refused("unwind_too_slow",
      `At your borrow size, liquidation unwind is estimated at ${Math.round(sim.unwind_seconds_estimate / 60)} minutes (Premium tier requires ≤${Math.round(PREMIUM_TIER_MAX_UNWIND_SECONDS / 60)} minutes). Try a smaller loan, or wait for deeper liquidity.`);
  }

  // ── Gate 6: per-borrower credit gate ─────────────────────────────
  t = Date.now();
  const { rows: [credit] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'liquidated'
                          AND start_timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '90 days'))::int AS recent_liquidations,
       COUNT(*) FILTER (WHERE status = 'repaid')::int      AS lifetime_repaid,
       COUNT(*) FILTER (WHERE status = 'liquidated')::int  AS lifetime_liquidated
     FROM loans
     WHERE borrower_wallet = $1`,
    [opts.borrowerPubkey],
  );
  gateTimes.credit = Date.now() - t;

  if ((credit?.recent_liquidations || 0) > 0) {
    return refused("recent_liquidation",
      "Premium tier requires a clean repayment history. You have a liquidation in the last 90 days; wait it out before requesting Premium-tier loans.");
  }
  // First-time Premium borrowers need 3+ successful repays on existing tiers
  const { rows: [premiumHist] } = await query(
    `SELECT COUNT(*)::int AS n FROM loans
       WHERE borrower_wallet = $1 AND pool = 'v3-premium' AND status IN ('repaid', 'active')`,
    [opts.borrowerPubkey],
  );
  if ((premiumHist?.n || 0) === 0 && (credit?.lifetime_repaid || 0) < 3) {
    return refused("insufficient_history",
      "Premium tier requires at least 3 successful repays on the existing tiers (Express/Quick/Standard) before your first Premium borrow. Build that history first.");
  }

  // ── Gate 7: per-token aggregate cap ──────────────────────────────
  t = Date.now();
  const { rows: [agg] } = await query(
    `SELECT COALESCE(SUM(original_loan_amount_lamports), 0)::TEXT AS open_lamports
       FROM loans
       WHERE collateral_mint = $1 AND status = 'active' AND pool = 'v3-premium'`,
    [opts.collateralMint],
  );
  gateTimes.aggregate_cap = Date.now() - t;

  const currentlyOpen = BigInt(agg?.open_lamports || "0");
  const cap = BigInt(String(wlRow.max_open_lamports));
  if (currentlyOpen + opts.proposedLoanLamports > cap) {
    const openSol = (Number(currentlyOpen) / 1e9).toFixed(2);
    const capSol = (Number(cap) / 1e9).toFixed(2);
    return refused("aggregate_cap_reached",
      `This stock has reached the Premium-tier aggregate exposure cap (${openSol} of ${capSol} SOL already lent). New Premium-tier loans pause against this mint until existing loans repay or roll off.`);
  }

  // ── Gate 8: per-loan absolute cap ────────────────────────────────
  if (opts.proposedLoanLamports > PREMIUM_TIER_MAX_LOAN_LAMPORTS) {
    const capSol = (Number(PREMIUM_TIER_MAX_LOAN_LAMPORTS) / 1e9).toFixed(0);
    return refused("per_loan_cap",
      `Premium-tier loans are capped at ${capSol} SOL per loan in v0. The cap will be raised as the tier matures and the operator has more liquidation data.`);
  }

  // ── All gates passed ─────────────────────────────────────────────
  console.log(JSON.stringify({
    event: "premium_screen",
    ts: new Date().toISOString(),
    collateralMint: opts.collateralMint,
    borrower: opts.borrowerPubkey,
    proposed_loan_sol: Number(opts.proposedLoanLamports) / 1e9,
    result: "ok",
    total_ms: Date.now() - gateStart,
    gate_durations_ms: gateTimes,
  }));
  return { blocked: false, reason: "ok" };

  function refused(reason, message) {
    console.log(JSON.stringify({
      event: "premium_screen",
      ts: new Date().toISOString(),
      collateralMint: opts.collateralMint,
      borrower: opts.borrowerPubkey,
      proposed_loan_sol: Number(opts.proposedLoanLamports) / 1e9,
      result: `refused:${reason}`,
      total_ms: Date.now() - gateStart,
      gate_durations_ms: gateTimes,
    }));
    return { blocked: true, reason, message };
  }
}

/**
 * Placeholder — wire to Pyth/Switchboard SDK during activation.
 * Returns { source, price_usd, slot, age_seconds, confidence_bps, status }.
 * `status` ∈ "live" | "degraded" | "offline".
 */
async function fetchOracleFeedHealth(_mint) {
  throw new Error("fetchOracleFeedHealth not yet implemented — wire Pyth/Switchboard during activation");
}

/**
 * Pure-math liquidation simulator. Estimates whether the collateral
 * can be unwound on-chain within MAX_UNWIND_SECONDS at current pair
 * depth + worst-case slippage.
 *
 * Returns { solvable, unwind_seconds_estimate, max_safe_collateral_usd }.
 */
function simulateLiquidation({ collateralUsd, liquidityUsd, worstCaseSlipBps }) {
  if (liquidityUsd <= 0) {
    return { solvable: false, unwind_seconds_estimate: Infinity, max_safe_collateral_usd: 0 };
  }
  // Naive: unwind time ∝ (collateralUsd / liquidityUsd). 1× = 60s; 2× = 240s; etc.
  // Conservative: cubic relationship past 1× to penalize concentrated positions.
  const ratio = collateralUsd / liquidityUsd;
  const unwindSeconds = ratio <= 1
    ? 60 * ratio
    : 60 + Math.pow(ratio, 3) * 60;
  const solvable = ratio < 0.5; // refuse if loan > 50% of pair liquidity
  const slipFactor = 1 + worstCaseSlipBps / 10_000;
  const maxSafe = (liquidityUsd * 0.5) / slipFactor;
  return {
    solvable,
    unwind_seconds_estimate: unwindSeconds,
    max_safe_collateral_usd: maxSafe,
  };
}
