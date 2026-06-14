/**
 * GET /api/v1/loan-tiers?category=<memecoin|stock|etf|metal>
 *
 * Returns the loan tier ladder for the requested collateral category.
 * Public read — no auth. Used by the site dashboard borrow form so
 * the displayed LTV/term/fee numbers always match the bot's
 * loan-tier-resolver (which is fed by the rwa_loan_tiers table).
 *
 * Without this endpoint, the site has to hard-code mirror constants
 * (PR #50 does today). When the operator tunes rwa_loan_tiers via the
 * DB, the site silently drifts until someone redeploys with updated
 * constants. With this endpoint the site fetches once on dashboard
 * mount, so DB tuning propagates without code changes.
 *
 * Response shape:
 *   {
 *     category: "memecoin" | "stock" | "etf" | "metal",
 *     source:   "MEMECOIN_TIERS" | "rwa_loan_tiers",
 *     tiers: [
 *       { option, ltv_pct, duration_days, fee_bps, label },
 *       ...
 *     ]
 *   }
 *
 * No body for any error — just status + minimal JSON. Cached at the
 * edge: 60s public + 60s SMaxAge so dashboards don't hammer this
 * endpoint with every page hydration.
 */
import { getEligibleTiers } from "../services/loan-tier-resolver.js";

export async function handleLoanTiers(req, url) {
  const categoryRaw = (url.searchParams.get("category") || "memecoin").toLowerCase();

  // Accept anything; the resolver returns MEMECOIN_TIERS for unknown
  // categories, which is the safer default. We don't pre-filter so
  // the operator can experiment with new categories.
  let tiers;
  try {
    tiers = await getEligibleTiers({ category: categoryRaw });
  } catch (err) {
    console.warn(`[loan-tiers-api] resolver failed for category=${categoryRaw}:`, err.message);
    return {
      status: 500,
      body: { error: "resolver_failed" },
    };
  }

  const isRwa = ["stock", "etf", "metal"].includes(categoryRaw);
  // Report which source the tiers actually came from so callers can
  // tell V2-DB-tunable rwa_loan_tiers apart from V3-baked V3_RWA_TIERS
  // without having to know about env-flag routing.
  const v3RwaRoutingOn = !!process.env.PROGRAM_ID_V3 && process.env.ROUTE_RWA_TO_V3 === "true";
  const source = isRwa
    ? (v3RwaRoutingOn ? "V3_RWA_TIERS" : "rwa_loan_tiers")
    : "MEMECOIN_TIERS";
  return {
    status: 200,
    headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
    body: {
      category: categoryRaw,
      source,
      tiers: tiers.map((t) => ({
        option: t.option,
        ltv_pct: t.ltv,
        duration_days: t.days,
        fee_bps: t.feeBps,
        label: t.label,
      })),
    },
  };
}
