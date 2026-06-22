/**
 * Loan tier resolver — picks the right tier set per collateral category.
 *
 * Until 2026-06-12 every callsite imported a hardcoded LTV_TIERS array
 * (30% / 25% / 20% with 2d / 3d / 7d terms and 3% / 2% / 1.5% fees) and
 * used it for every borrow regardless of collateral type. Tokenized
 * stocks (xStocks) have meaningfully lower volatility than memecoins,
 * so the protocol can safely offer higher LTVs, longer terms, and a
 * higher fee — but only on the RWA path.
 *
 * This module is the single source of truth that:
 *   - returns the hardcoded MEMECOIN_TIERS for memecoin/non-categorized
 *     collateral (unchanged from prior behavior)
 *   - returns the RWA tiers (read live from rwa_loan_tiers table) when
 *     category ∈ {stock, etf, metal}
 *
 * Callsites (src/commands/borrow.js, reborrow.js, simulate.js,
 * unlock.js, price.js, api/agent.js, services/community-pip.js) should
 * resolve via this module rather than embedding their own LTV_TIERS
 * array. That way, when the operator tunes the RWA numbers via the DB
 * (UPDATE rwa_loan_tiers SET ...) every surface picks up the change
 * without a code redeploy.
 *
 * Fee semantics are unchanged regardless of source: feeBps is applied
 * up front against loan_amount_pre_fee in recordLoan, and the resulting
 * feeLamports feeds the 70-10-10-10 accrual pipeline. Protocol slice
 * lands in 4JSSSaG3 via the existing PROTOCOL_FEE_DESTINATION flow.
 */
import { query } from "../db/pool.js";

// Same MEMECOIN_TIERS that has been used since v1. Kept as a constant
// here (not in DB) because (a) the memecoin path is stable and changing
// these is a much bigger product decision than tuning the RWA numbers,
// and (b) it lets the memecoin path be totally DB-independent.
export const MEMECOIN_TIERS = [
  { option: 0, ltv: 30, days: 2, feeBps: 300, label: "30% LTV · 2d · 3% fee (Express)" },
  { option: 1, ltv: 25, days: 3, feeBps: 200, label: "25% LTV · 3d · 2% fee (Quick)" },
  { option: 2, ltv: 20, days: 7, feeBps: 150, label: "20% LTV · 7d · 1.5% fee (Standard)" },
];

// V3-program RWA ladder. The values are baked into the V3 program
// on-chain (see magpie_lending_v3.json + project memory
// "magpie-v3-mainnet-live"). This is the source of truth used when a
// new RWA borrow routes to V3 (i.e., PROGRAM_ID_V3 is set AND
// ROUTE_RWA_TO_V3=true). We hardcode rather than read DB because the
// on-chain program enforces these exact values — any DB drift would
// just cause silent borrow failures.
export const V3_RWA_TIERS = [
  { option: 0, ltv: 50, days: 7,  feeBps: 250, label: "50% LTV · 7d · 2.5% fee (RWA Express V3)" },
  { option: 1, ltv: 60, days: 15, feeBps: 350, label: "60% LTV · 15d · 3.5% fee (RWA Quick V3)" },
  { option: 2, ltv: 70, days: 30, feeBps: 500, label: "70% LTV · 30d · 5% fee (RWA Standard V3)" },
];

// V4 inherits V3's dual-tier ladder verbatim — V4 adds the in-vault
// auto-sell capability without changing the tier economics. Keeping
// these as separate exports (rather than aliasing V3_RWA_TIERS) so
// labels can diverge later without affecting V3 borrowers.
export const V4_RWA_TIERS = [
  { option: 0, ltv: 50, days: 7,  feeBps: 250, label: "50% LTV · 7d · 2.5% fee (RWA Express V4)" },
  { option: 1, ltv: 60, days: 15, feeBps: 350, label: "60% LTV · 15d · 3.5% fee (RWA Quick V4)" },
  { option: 2, ltv: 70, days: 30, feeBps: 500, label: "70% LTV · 30d · 5% fee (RWA Standard V4)" },
];

// Categories that route to the RWA tier set. Source of truth for the
// vocabulary lives in src/solana/program.js (RWA_CATEGORIES); we mirror
// it here to avoid circular imports between solana + services layers.
const RWA_CATEGORIES = new Set(["stock", "etf", "metal"]);

// Read the V3 routing flags via env (avoid importing program.js here to
// keep the resolver dependency-free and circular-import-safe). The
// resolver only needs to know IF V3 will handle RWA borrows; it doesn't
// need the PublicKey itself.
function isRwaRoutingToV3() {
  return (
    !!process.env.PROGRAM_ID_V3 &&
    process.env.ROUTE_RWA_TO_V3 === "true"
  );
}

function isRwaRoutingToV4() {
  return (
    !!process.env.PROGRAM_ID_V4 &&
    process.env.ROUTE_RWA_TO_V4 === "true"
  );
}

// Short cache so a borrow flow that touches getEligibleTiers multiple
// times within the same tick doesn't re-query the DB. 30s is well below
// the cadence at which the operator would realistically tune the table.
const CACHE_TTL_MS = 30_000;
let cachedRwaTiers = null;
let cachedAt = 0;

async function getRwaTiersFromDb() {
  const now = Date.now();
  if (cachedRwaTiers && now - cachedAt < CACHE_TTL_MS) return cachedRwaTiers;
  try {
    const { rows } = await query(
      `SELECT option, ltv_pct, duration_days, fee_bps, label, notes
         FROM rwa_loan_tiers
        WHERE enabled = TRUE
        ORDER BY option ASC`,
    );
    if (rows.length === 0) {
      // Defensive: if migration 040 hasn't applied yet OR the operator
      // disabled every row, fall back to the memecoin tiers so RWA
      // borrows don't fail outright. They just don't get the favorable
      // RWA-specific economics until the DB is set up.
      return MEMECOIN_TIERS;
    }
    cachedRwaTiers = rows.map((r) => ({
      option: r.option,
      ltv: r.ltv_pct,
      days: r.duration_days,
      feeBps: r.fee_bps,
      label: `${r.ltv_pct}% LTV · ${r.duration_days}d · ${(r.fee_bps / 100).toFixed(1)}% fee (${r.label})`,
      notes: r.notes,
    }));
    cachedAt = now;
    return cachedRwaTiers;
  } catch (err) {
    // Same defensive fallback: never let a bad DB query nuke the
    // borrow flow. Memecoin tiers are guaranteed to clear; we'd rather
    // a worse-economics borrow succeed than block legitimate RWA
    // borrowers.
    console.warn(`[loan-tier-resolver] rwa tier read failed, falling back to memecoin tiers: ${err.message}`);
    return MEMECOIN_TIERS;
  }
}

/**
 * Pick the right tier set for the borrow. category is the value of
 * supported_mints.category (string).
 *
 * Returns an array of tier objects: { option, ltv, days, feeBps, label }.
 */
export async function getEligibleTiers({ category }) {
  if (category && RWA_CATEGORIES.has(category)) {
    // Highest-version routing takes precedence:
    //   V4 (if configured + ROUTE_RWA_TO_V4=true) → V4_RWA_TIERS
    //   V3 (if configured + ROUTE_RWA_TO_V3=true) → V3_RWA_TIERS
    //   else                                     → DB-tunable rwa_loan_tiers (V2)
    // Existing loans aren't affected — they keep their own program_id
    // and continue to repay/extend against whatever program issued them.
    if (isRwaRoutingToV4()) {
      return V4_RWA_TIERS;
    }
    if (isRwaRoutingToV3()) {
      return V3_RWA_TIERS;
    }
    return await getRwaTiersFromDb();
  }
  return MEMECOIN_TIERS;
}

/**
 * Look up a tier by option index for a given category. Same defaulting
 * as getEligibleTiers. Returns undefined if option is out of range.
 */
export async function getTierByOption({ category, option }) {
  const tiers = await getEligibleTiers({ category });
  return tiers.find((t) => t.option === Number(option));
}

/**
 * Clear the in-memory cache. The operator-facing /reload-tiers admin
 * command can call this after tuning the rwa_loan_tiers table to skip
 * the 30s TTL.
 */
export function clearTierCache() {
  cachedRwaTiers = null;
  cachedAt = 0;
}
