/**
 * GET /api/v1/v4/feed-health?mint=<base58>
 *
 * Sprint Item 3 of 6 (feedback_v4_hardening_sprint_2026_06_17.md).
 *
 * Returns whether a token's V4 price feed is fresh enough for a borrow
 * to succeed without hitting StalePriceAttestation. The site calls this
 * BEFORE rendering the borrow CTA — if the feed is cold, the dashboard
 * can show "Refreshing oracle…" and quietly call /api/v1/price/refresh
 * in the background instead of letting the user click Borrow and hit a
 * rejected wallet simulation.
 *
 * Response (200 OK)
 * ─────────────────
 *   {
 *     ok: true,
 *     mint: "...",
 *     feed_age_seconds_v4: 27.4 | null,
 *     feed_age_seconds_default: 31.0,
 *     fresh_v4: true,
 *     fresh_default: true,
 *     fresh_for_borrow: true,        // both fresh = ready
 *     threshold_seconds: 60,          // contract wall is 120s; we
 *                                     // use 60s headroom
 *     recommendation: "ready" | "refresh_recommended" | "refresh_required",
 *     supported: true,
 *     enabled: true
 *   }
 *
 * Errors
 * ──────
 *   400  invalid_mint | missing_params
 *   404  mint_not_supported
 *   409  mint_disabled
 *   500  rpc_error
 *
 * NO mutations — read-only. Cheap (one or two RPC reads). Safe to poll
 * from the site every few seconds while the borrow form is open.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const FRESH_THRESHOLD_SEC = 60; // 60s headroom under the 120s contract wall

function isValidPubkey(s) {
  if (!s || typeof s !== "string") return false;
  if (s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export async function handleV4FeedHealth(req, url) {
  if (req.method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const mintStr = url.searchParams.get("mint") || "";
  if (!mintStr) {
    return {
      status: 400,
      body: { error: "missing_params", detail: "mint required" },
    };
  }
  if (!isValidPubkey(mintStr)) {
    return { status: 400, body: { error: "invalid_mint" } };
  }

  // Allowlist — only enabled supported_mints. Matches the /price/refresh
  // allowlist so this endpoint has the same DOS surface (none).
  const { rows: [mintRow] } = await query(
    `SELECT mint, enabled FROM supported_mints WHERE mint = $1`,
    [mintStr],
  );
  if (!mintRow) {
    return { status: 404, body: { error: "mint_not_supported", mint: mintStr } };
  }
  if (!mintRow.enabled) {
    return { status: 409, body: { error: "mint_disabled", mint: mintStr } };
  }

  const { getPriceFeedAgeSeconds } = await import("../services/price-attestor.js");
  const { PROGRAM_ID_V4 } = await import("../solana/program.js");

  let ageSecDefault = null;
  let ageSecV4 = null;

  try {
    ageSecDefault = await getPriceFeedAgeSeconds(mintStr);
  } catch (err) {
    console.warn(`[v4-feed-health] default age read failed: ${err.message?.slice(0, 100)}`);
  }
  if (PROGRAM_ID_V4) {
    try {
      ageSecV4 = await getPriceFeedAgeSeconds(mintStr, PROGRAM_ID_V4);
    } catch (err) {
      console.warn(`[v4-feed-health] V4 age read failed: ${err.message?.slice(0, 100)}`);
    }
  }

  const freshDefault = ageSecDefault !== null && ageSecDefault <= FRESH_THRESHOLD_SEC;
  // V4 is required only when V4 routing is wired. If PROGRAM_ID_V4 isn't
  // set, V4 freshness isn't gating anything.
  const v4Required = !!PROGRAM_ID_V4;
  const freshV4 = !v4Required || (ageSecV4 !== null && ageSecV4 <= FRESH_THRESHOLD_SEC);
  const freshForBorrow = freshDefault && freshV4;

  // Recommendation buckets — the site picks UI state from this.
  //
  //   "ready"                 both feeds fresh — show normal borrow CTA
  //   "refresh_recommended"   one feed is in the warning zone (60-90s)
  //                           — site should kick off /price/refresh
  //                           silently and still allow the CTA
  //   "refresh_required"      a feed is cold (> 90s or null) — site
  //                           shows "Refreshing oracle…" and disables
  //                           CTA until /price/refresh confirms
  const WARN_THRESHOLD_SEC = 90;
  function bucket(age) {
    if (age === null) return "missing";
    if (age <= FRESH_THRESHOLD_SEC) return "fresh";
    if (age <= WARN_THRESHOLD_SEC) return "warning";
    return "stale";
  }
  const bucketDefault = bucket(ageSecDefault);
  const bucketV4 = v4Required ? bucket(ageSecV4) : "n/a";
  let recommendation;
  if (freshForBorrow) {
    recommendation = "ready";
  } else if (bucketDefault === "stale" || bucketV4 === "stale" || bucketV4 === "missing" || bucketDefault === "missing") {
    recommendation = "refresh_required";
  } else {
    recommendation = "refresh_recommended";
  }

  return {
    status: 200,
    body: {
      ok: true,
      mint: mintStr,
      feed_age_seconds_default: ageSecDefault,
      feed_age_seconds_v4: ageSecV4,
      fresh_default: freshDefault,
      fresh_v4: freshV4,
      fresh_for_borrow: freshForBorrow,
      threshold_seconds: FRESH_THRESHOLD_SEC,
      recommendation,
      supported: true,
      enabled: true,
      generated_at: new Date().toISOString(),
    },
  };
}
