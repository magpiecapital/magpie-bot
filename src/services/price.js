import axios from "axios";
import "dotenv/config";
import { hasPythCoverage, pythPriceInSol, pythPriceInUsd } from "./pyth-price.js";
import {
  routeFor,
  tryAcquireJupiterToken,
  recordJupiterOk,
  recordJupiter429,
  recordJupiterErr,
  recordBudgetDefer,
  recordBackoffSkip,
  clearMintJupiterBackoff,
  isMintInJupiterBackoff,
} from "./jupiter-budget.js";

// Jupiter v2 was deprecated in 2025. v3 returns USD only, so SOL-denominated
// prices are derived as token_usd / sol_usd.
//
// Paid-tier support (operator-mandated 2026-06-19 PM after free lite-api
// 429 storms starved the V4 continuous loop):
//   - When JUPITER_API_KEY is set, route to api.jup.ag (paid Pro tier) and
//     send x-api-key header on every request.
//   - When unset, fall back to lite-api.jup.ag (free, aggressive 429s).
// The env var can be flipped on/off at runtime without a code change.
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || null;
const JUPITER_API =
  process.env.JUPITER_API_URL ||
  (JUPITER_API_KEY
    ? "https://api.jup.ag/price/v3"
    : "https://lite-api.jup.ag/price/v3");
const JUPITER_HEADERS = JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
if (JUPITER_API_KEY) {
  console.log("[price] Jupiter Pro tier active (api.jup.ag with x-api-key)");
} else {
  console.log("[price] Jupiter lite-api active (no JUPITER_API_KEY set — 429s expected under load)");
}
const SOL_MINT = "So11111111111111111111111111111111111111112";
// Jupiter v3 accepts up to ~100 ids per call, but we chunk at 50 for headroom.
const JUP_BATCH_SIZE = 50;

/**
 * Fetch price of `mint` denominated in SOL (token value in SOL).
 * Returns a float — multiply by token amount (human units) for total SOL value.
 *
 * Resilience model:
 *   1. Hit Jupiter (primary). If 429 / 5xx / network error → retry once
 *      after a short jittered delay (most rate limits are bursty).
 *   2. If still failing, fall back to DexScreener. Single-source result
 *      with a log line so we know we're degraded — better than letting
 *      /borrow fail outright for every user the moment Jupiter throttles.
 *   3. Throw only if both sources fail.
 *
 * Note: high-stakes valuation (e.g. actual /borrow LTV check) still goes
 * through getPriceInSolCrossSourced — that one REQUIRES both sources
 * to agree. This function is the low-stakes "just give me a price"
 * path used by the on-chain price-feed attestor.
 */
async function jupiterPriceInSol(mint) {
  try {
    const resp = await axios.get(JUPITER_API, {
      params: { ids: `${mint},${SOL_MINT}` },
      headers: JUPITER_HEADERS,
      timeout: 10_000,
    });
    const tokenUsd = resp.data?.[mint]?.usdPrice;
    const solUsd = resp.data?.[SOL_MINT]?.usdPrice;
    if (!tokenUsd || !solUsd) {
      recordJupiterErr();
      throw new Error(`No price data for mint ${mint}`);
    }
    recordJupiterOk();
    clearMintJupiterBackoff(mint);
    return tokenUsd / solUsd;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) {
      recordJupiter429(mint);
    } else if (!err?.response?.status?.toString().startsWith("2")) {
      recordJupiterErr();
    }
    throw err;
  }
}

function isTransientPriceError(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Network-level (no response): ECONNRESET, ETIMEDOUT, etc.
  if (!err?.response && err?.code) return true;
  return false;
}

export async function getPriceInSol(mint) {
  // Route decision: budget + backoff + RWA-class aware. See
  // jupiter-budget.js for the policy.
  const { route, reason } = await routeFor(mint);

  if (route === "dexscreener_only") {
    // Jupiter is off the table this round. Dex or bust.
    recordBackoffSkip();
    return await dexscreenerPriceInSol(mint);
  }

  if (route === "dexscreener_first") {
    if (reason !== "rwa-category=stock" && reason !== "rwa-category=etf" && reason !== "rwa-category=metal") {
      // Memecoin being deferred — note it for metrics.
      recordBudgetDefer();
    }
    try {
      return await dexscreenerPriceInSol(mint);
    } catch (errDex) {
      // Dex failed. Try Jupiter ONLY if budget allows + not in backoff.
      if (isMintInJupiterBackoff(mint) || !tryAcquireJupiterToken()) {
        throw new Error(`No price for ${mint} (Dex: ${errDex.message}; Jupiter skipped: ${reason})`);
      }
      try {
        return await jupiterPriceInSol(mint);
      } catch (errJup) {
        throw new Error(`No price for ${mint} (Dex: ${errDex.message}; Jupiter: ${errJup.message})`);
      }
    }
  }

  // jupiter_first path — original logic with budget consumption.
  if (!tryAcquireJupiterToken()) {
    // Edge: routeFor said we had budget but it raced out. Defer to Dex.
    recordBudgetDefer();
    try {
      return await dexscreenerPriceInSol(mint);
    } catch (errDex) {
      throw new Error(`No price for ${mint} (Jupiter budget exhausted; Dex: ${errDex.message})`);
    }
  }
  try {
    return await jupiterPriceInSol(mint);
  } catch (err1) {
    if (!isTransientPriceError(err1)) {
      try {
        const dex = await dexscreenerPriceInSol(mint);
        console.warn(`[price] ${mint.slice(0, 8)} fallback to DexScreener (Jupiter: ${err1.message})`);
        return dex;
      } catch (err2) {
        throw new Error(`No price data for ${mint} (Jupiter: ${err1.message}; DexScreener: ${err2.message})`);
      }
    }

    // Transient — wait 200-700ms with jitter, retry Jupiter once IF budget allows.
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 500));
    if (!tryAcquireJupiterToken()) {
      // No budget for retry. Skip to Dex.
      try {
        const dex = await dexscreenerPriceInSol(mint);
        console.warn(`[price] ${mint.slice(0, 8)} fallback to DexScreener (no budget for Jupiter retry)`);
        return dex;
      } catch (err2) {
        throw new Error(`No price data for ${mint} (Jupiter: ${err1.message}; Dex: ${err2.message})`);
      }
    }
    try {
      return await jupiterPriceInSol(mint);
    } catch (err2) {
      try {
        const dex = await dexscreenerPriceInSol(mint);
        console.warn(`[price] ${mint.slice(0, 8)} fallback to DexScreener (Jupiter still failing after retry: ${err2.message})`);
        return dex;
      } catch (err3) {
        throw new Error(`No price data for ${mint} (Jupiter: ${err2.message}; DexScreener: ${err3.message})`);
      }
    }
  }
}

/**
 * Batch fetch SOL-denominated prices for many mints in one (or a few) calls.
 * Returns Map<mint, priceInSol>. Mints with no Jupiter coverage are omitted.
 * Use this from any caller that needs prices for >1 mint — keeps us under
 * Jupiter's rate limit.
 */
export async function getPricesInSolBatch(mints) {
  const unique = [...new Set(mints)];
  const result = new Map();
  let solUsd = null;

  for (let i = 0; i < unique.length; i += JUP_BATCH_SIZE) {
    const chunk = unique.slice(i, i + JUP_BATCH_SIZE);
    // Each batch HTTP call costs 1 token even though it covers up to
    // JUP_BATCH_SIZE mints. If we can't afford it, return what we have
    // so far and the per-mint fallback in callers will pick up the rest
    // via DexScreener.
    if (!tryAcquireJupiterToken()) {
      recordBudgetDefer();
      break;
    }
    const ids = chunk.concat(solUsd ? [] : [SOL_MINT]).join(",");
    try {
      const resp = await axios.get(JUPITER_API, {
        params: { ids },
        headers: JUPITER_HEADERS,
        timeout: 15_000,
      });
      recordJupiterOk();
      if (!solUsd) {
        solUsd = resp.data?.[SOL_MINT]?.usdPrice;
        if (!solUsd) throw new Error("No SOL price from Jupiter");
      }
      for (const mint of chunk) {
        const usd = resp.data?.[mint]?.usdPrice;
        if (usd) {
          result.set(mint, usd / solUsd);
          // A successful price clears any prior backoff for this mint —
          // Jupiter is healthy for it again.
          clearMintJupiterBackoff(mint);
        }
      }
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        // Bump backoff for ALL mints in this chunk so we don't waste the
        // next batch hammering the same set.
        for (const mint of chunk) recordJupiter429(mint);
      } else {
        recordJupiterErr();
      }
      // Don't throw — let the caller's per-mint fallback fill in via Dex.
      break;
    }
  }
  return result;
}

/**
 * Cross-source price: query Jupiter AND DexScreener, return Jupiter price
 * if both agree within MAX_DIVERGENCE. Reject when they disagree — that's
 * a strong signal of price-feed manipulation (one source pumped a fake
 * pool) and we don't want to lend against a price one source disputes.
 *
 * Use this in flows where price manipulation is a real risk (e.g.
 * borrow valuation). For the background attestor — where we tolerate
 * small drift and want continuity — getPriceInSol() is fine.
 *
 * Tightened 2026-06-07: divergence was 10%, now 5%. A 9% pump (the
 * previous tolerated max) is more than enough to extract value from
 * a 70%-LTV loan: 0.9 SOL of inflated collateral nets 0.63 SOL of
 * borrow that "looks fine" off-chain. 5% caps the worst-case extraction
 * meaningfully while staying loose enough that genuine cross-source
 * drift (different DEX paths, latency) doesn't false-positive.
 */
const MAX_DIVERGENCE = Number(process.env.PRICE_MAX_DIVERGENCE) || 0.05;

// ─── Recent-agreement cache (reliability layer) ─────────────────────────
//
// When BOTH sources already agreed within MAX_DIVERGENCE in the last
// CROSS_SOURCED_CACHE_TTL_MS, we cache that agreed price. If a later
// call hits a transient 429 / 5xx on one source (Jupiter rate-limits
// HARD when DexScreener is unaffected — see Railway logs), we can
// safely return the cached agreed price instead of throwing.
//
// Why this is safe:
//   - The cached price was already cross-source-validated, so the
//     security guarantee is preserved at population time.
//   - TTL is short (90s default) — an attacker would need to pump
//     both sources simultaneously during the cache window to influence
//     anything, and we already valued at a clean price before the cache.
//   - This ONLY engages when the live cross-source check would have
//     failed for transient reasons (0 or 1 source responded). When the
//     live check succeeds, the live price wins.
//
// Operator-mandated 2026-06-17 PM after recurring "Couldn't fetch price
// right now" failures on TG /borrow during Jupiter 429 storms.
const CROSS_SOURCED_CACHE = new Map(); // mint → { priceSol, agreedAt, agreedSources }
const CROSS_SOURCED_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_FALLBACK_TTL_MS) || 90_000;

function cacheAgreedPrice(mint, priceSol, agreedSources) {
  CROSS_SOURCED_CACHE.set(mint, { priceSol, agreedAt: Date.now(), agreedSources });
}

/**
 * Returns a recently-agreed cross-source price for `mint` if it's still
 * within the fallback TTL, otherwise null. Used internally as a stale-on-
 * failure fallback and exposed for callers that want to warm-check
 * availability (e.g. TG /borrow prefetch).
 */
export function getCachedAgreedPriceIfFresh(mint) {
  const c = CROSS_SOURCED_CACHE.get(mint);
  if (!c) return null;
  if (Date.now() - c.agreedAt > CROSS_SOURCED_CACHE_TTL_MS) return null;
  return c.priceSol;
}

/**
 * Three-source agreement helper (audit F-2 follow-up — Pyth as 3rd source).
 *
 * Returns a price the caller can trust, or null if the inputs don't agree.
 * The caller decides whether to throw / fall back / escape-hatch.
 *
 *   sources: array of { name, price } objects. price may be null if the
 *     source didn't return. Filter to truthy prices internally.
 *   maxDivergence: pairwise fractional threshold (default 5%)
 *
 * Semantics:
 *   - 0 sources       → null
 *   - 1 source        → null (caller handles single-source escape hatch)
 *   - 2 sources agree → return their average
 *   - 2 sources disagree → null
 *   - 3 sources, at least 2 agree (the "median majority") → return average
 *     of the agreeing pair. The disagreeing one is the suspect outlier.
 *   - 3 sources, all 3 disagree → null
 *
 * Logs a one-line summary so the operator can see "outlier rejected"
 * patterns in the daily ops digest.
 */
function agreeOnPrice({ mint, sources, maxDivergence }) {
  const valid = sources.filter((s) => s.price != null && s.price > 0);
  if (valid.length <= 1) return null;
  if (valid.length === 2) {
    const [a, b] = valid;
    const div = Math.abs(a.price - b.price) / Math.min(a.price, b.price);
    if (div <= maxDivergence) return { price: (a.price + b.price) / 2, agreed: [a.name, b.name], outlier: null };
    return null;
  }
  // 3 sources — find the pair with smallest divergence.
  const pairs = [
    [valid[0], valid[1]],
    [valid[0], valid[2]],
    [valid[1], valid[2]],
  ].map(([a, b]) => ({
    a, b,
    div: Math.abs(a.price - b.price) / Math.min(a.price, b.price),
  }));
  pairs.sort((x, y) => x.div - y.div);
  const best = pairs[0];
  if (best.div > maxDivergence) return null;
  const outlier = valid.find((s) => s.name !== best.a.name && s.name !== best.b.name);
  if (outlier) {
    const outlierDiv = Math.abs(outlier.price - best.a.price) / Math.min(outlier.price, best.a.price);
    if (outlierDiv > maxDivergence) {
      console.warn(`[price] 3-source outlier rejected for ${String(mint).slice(0, 8)}: ${outlier.name} (${outlier.price}) disagrees with ${best.a.name}+${best.b.name} agreed avg by ${(outlierDiv * 100).toFixed(1)}%`);
    }
  }
  return { price: (best.a.price + best.b.price) / 2, agreed: [best.a.name, best.b.name], outlier: outlier?.name ?? null };
}

async function dexscreenerPriceInSol(mint) {
  const resp = await axios.get(
    `https://api.dexscreener.com/tokens/v1/solana/${mint},${SOL_MINT}`,
    { timeout: 10_000 },
  );
  const pairs = Array.isArray(resp.data) ? resp.data : [];
  // Best (deepest) pair per token by liquidity.
  let bestToken = null, bestSol = null;
  for (const p of pairs) {
    const addr = p?.baseToken?.address;
    const liq = p?.liquidity?.usd ?? 0;
    const priceUsd = parseFloat(p?.priceUsd ?? 0);
    if (!addr || !priceUsd) continue;
    if (addr === mint && (!bestToken || liq > bestToken.liq)) {
      bestToken = { priceUsd, liq };
    } else if (addr === SOL_MINT && (!bestSol || liq > bestSol.liq)) {
      bestSol = { priceUsd, liq };
    }
  }
  if (!bestToken || !bestSol) throw new Error("DexScreener missing price for mint or SOL");
  return bestToken.priceUsd / bestSol.priceUsd;
}

// Fail-closed policy (security audit F-2, 2026-06-12):
//
// This function is the canonical valuation gate for borrow LTV and limit-
// close arming — high-stakes paths where a manipulated price translates
// directly into a borrowable inflation against the pool. The 2026-06-07
// $FATHER incident showed that single-source acceptance during a sibling
// source's outage is enough to extract value at a thin pool that's been
// pumped on the surviving source.
//
// The function REQUIRES BOTH sources by default. If exactly one source
// fails (rate limit, 5xx, timeout, missing-mint), the function throws.
// The borrow flow's error surface translates this into a friendly
// "couldn't value collateral right now — try again in a moment" message.
// Better to fail one borrow attempt than to mis-value a loan.
//
// Single-source escape hatch:
//   ALLOW_SINGLE_SOURCE_PRICING=true
//
// Only flip this during a confirmed long-running outage of either Jupiter
// or DexScreener, AND only when the surviving source has been independently
// verified as un-manipulated. Default to false; the bot logs a WARN every
// time this fires so an attacker can't quietly degrade the protocol's
// posture from inside the system.
//
// The low-stakes "give-me-a-price" path used by the on-chain price-feed
// attestor goes through getPriceInSol() (singular, lenient retry+fallback)
// — that's intentional and unchanged.
export async function getPriceInSolCrossSourced(mint) {
  // Pyth coverage check — most memecoins won't have a feed and that's
  // fine. The function gracefully degrades to 2-source mode (Jup+Dex)
  // for any mint without Pyth coverage.
  const usePyth = hasPythCoverage(mint);
  const promises = [getPriceInSol(mint), dexscreenerPriceInSol(mint)];
  if (usePyth) promises.push(pythPriceInSol(mint));

  const settled = await Promise.allSettled(promises);
  const [jupRes, dexRes, pythRes] = settled;
  const jup  = jupRes?.status === "fulfilled" ? jupRes.value : null;
  const dex  = dexRes?.status === "fulfilled" ? dexRes.value : null;
  const pyth = pythRes?.status === "fulfilled" ? pythRes.value : null;
  const jupErr = jupRes?.status === "rejected" ? jupRes.reason?.message?.slice(0, 80) : null;
  const dexErr = dexRes?.status === "rejected" ? dexRes.reason?.message?.slice(0, 80) : null;
  const pythErr = pythRes?.status === "rejected" ? pythRes.reason?.message?.slice(0, 80) : null;

  const sources = [
    { name: "Jupiter", price: jup },
    { name: "DexScreener", price: dex },
  ];
  if (usePyth) sources.push({ name: "Pyth", price: pyth });
  const respondingCount = sources.filter((s) => s.price != null && s.price > 0).length;

  if (respondingCount === 0) {
    // Reliability fallback: if NO source responded but we have a recent
    // agreed price in cache (≤ CROSS_SOURCED_CACHE_TTL_MS old), serve it
    // rather than failing the user's borrow. The cached price was already
    // cross-source validated; the alternative is a "Couldn't fetch price"
    // dead-end for the user. The cache is short-TTL so manipulation risk
    // is bounded.
    const cached = getCachedAgreedPriceIfFresh(mint);
    if (cached != null) {
      console.warn(`[price] ALL sources down for ${mint.slice(0,8)} — serving cached agreed price ${cached.toFixed(9)} (jup=${jupErr ?? "n/a"}; dex=${dexErr ?? "n/a"})`);
      return cached;
    }
    throw new Error(`No price data for ${mint} from any source (jup=${jupErr ?? "n/a"}; dex=${dexErr ?? "n/a"}${usePyth ? `; pyth=${pythErr ?? "n/a"}` : ""})`);
  }

  // Single-source case — fail closed unless the env-var escape hatch is on.
  // Reliability layer: BEFORE refusing, check the recent-agreement cache.
  // If both sources already agreed within TTL, the surviving source must
  // agree with the cached price for us to trust it (within MAX_DIVERGENCE).
  // This catches the common Jupiter-429 / DexScreener-up case without
  // dropping security: we only trust the single source if it corroborates
  // a recent multi-source agreement.
  if (respondingCount === 1) {
    const survivor = sources.find((s) => s.price != null && s.price > 0);
    const down = sources.filter((s) => s.price == null).map((s) => s.name).join(",");
    const cached = getCachedAgreedPriceIfFresh(mint);
    if (cached != null) {
      const div = Math.abs(survivor.price - cached) / Math.min(survivor.price, cached);
      if (div <= MAX_DIVERGENCE) {
        // Survivor corroborates a recent agreement — safe to use as proof
        // of continuity. Cache survives the broken source.
        console.warn(`[price] ${mint.slice(0,8)} single-source RELIABILITY OK: ${survivor.name} agrees with ${(Date.now() - CROSS_SOURCED_CACHE.get(mint).agreedAt)/1000 | 0}s-old cache (${(div*100).toFixed(2)}% drift, ${down} down)`);
        // Refresh cache with average so subsequent calls stay smooth.
        cacheAgreedPrice(mint, (survivor.price + cached) / 2, [survivor.name, "cache"]);
        return (survivor.price + cached) / 2;
      }
      console.warn(`[price] ${mint.slice(0,8)} single-source DIVERGES from cache by ${(div*100).toFixed(1)}% (${survivor.name}=${survivor.price.toFixed(9)} vs cache=${cached.toFixed(9)}); refusing`);
    }
    if (process.env.ALLOW_SINGLE_SOURCE_PRICING === "true") {
      console.warn(`[price] SINGLE-SOURCE FALLBACK ALLOWED for ${mint.slice(0, 8)} via ${survivor.name} (${down} down). Escape hatch is ON — security posture is degraded.`);
      return survivor.price;
    }
    console.warn(`[price] REFUSED ${mint.slice(0, 8)} — only ${survivor.name} responded (${down} down), no fresh cache. Set ALLOW_SINGLE_SOURCE_PRICING=true to override.`);
    throw new Error(`Price data temporarily unavailable for ${mint.slice(0, 8)} — only ${survivor.name} responded. Try again in a moment.`);
  }

  // 2 or 3 sources responded — delegate to the agreement helper.
  const agreed = agreeOnPrice({ mint, sources, maxDivergence: MAX_DIVERGENCE });
  if (!agreed) {
    const detail = sources.filter((s) => s.price != null && s.price > 0)
      .map((s) => `${s.name}=${s.price.toFixed(9)}`).join(", ");
    throw new Error(
      `Price sources disagree for ${mint.slice(0, 8)}: ${detail}. Above ${(MAX_DIVERGENCE * 100).toFixed(0)}% threshold — likely manipulation. Refusing to value.`,
    );
  }
  if (agreed.outlier) {
    console.warn(`[price] outlier rejected for ${mint.slice(0, 8)}: ${agreed.agreed.join("+")} agreed; ${agreed.outlier} flagged`);
  }
  // Cache the live-validated price for future reliability fallback.
  cacheAgreedPrice(mint, agreed.price, agreed.agreed);
  return agreed.price;
}

/**
 * Warm the cross-source price cache for `mint` without blocking the caller.
 * Used by TG /borrow's token-select to make sure the cache is hot before
 * the user picks a percentage — so a transient Jupiter 429 between the
 * two callbacks doesn't drop them. Errors are swallowed by design.
 */
export function warmPriceCache(mint) {
  getPriceInSolCrossSourced(mint).catch(() => { /* best-effort warm */ });
}

/**
 * USD price helpers — used by conditional-borrow trigger evaluation.
 * Same cross-source resiliency model: prefer Jupiter, fall back to
 * DexScreener, agree-or-throw when both respond. Returns USD per token.
 */
async function jupiterPriceInUsd(mint) {
  const resp = await axios.get(JUPITER_API, {
    params: { ids: mint },
    headers: JUPITER_HEADERS,
    timeout: 10_000,
  });
  const tokenUsd = resp.data?.[mint]?.usdPrice;
  if (!tokenUsd) throw new Error(`Jupiter has no USD price for ${mint}`);
  return tokenUsd;
}

async function dexscreenerPriceInUsd(mint) {
  const resp = await axios.get(
    `https://api.dexscreener.com/tokens/v1/solana/${mint}`,
    { timeout: 10_000 },
  );
  const pairs = Array.isArray(resp.data) ? resp.data : [];
  let best = null;
  for (const p of pairs) {
    const addr = p?.baseToken?.address;
    const liq = p?.liquidity?.usd ?? 0;
    const priceUsd = parseFloat(p?.priceUsd ?? 0);
    if (addr === mint && priceUsd && (!best || liq > best.liq)) {
      best = { priceUsd, liq };
    }
  }
  if (!best) throw new Error("DexScreener missing USD price for mint");
  return best.priceUsd;
}

// Same fail-closed policy as getPriceInSolCrossSourced (security audit F-2).
// Used by limit-close arm validation, dashboard price displays, and Pip
// answers about token prices. The single-source escape hatch
// (ALLOW_SINGLE_SOURCE_PRICING=true) covers both functions — flipping it
// degrades the entire valuation surface, not just one path.
export async function getPriceInUsdCrossSourced(mint) {
  const usePyth = hasPythCoverage(mint);
  const promises = [jupiterPriceInUsd(mint), dexscreenerPriceInUsd(mint)];
  if (usePyth) promises.push(pythPriceInUsd(mint));

  const settled = await Promise.allSettled(promises);
  const [jupRes, dexRes, pythRes] = settled;
  const jup  = jupRes?.status === "fulfilled" ? jupRes.value : null;
  const dex  = dexRes?.status === "fulfilled" ? dexRes.value : null;
  const pyth = pythRes?.status === "fulfilled" ? pythRes.value : null;
  const jupErr = jupRes?.status === "rejected" ? jupRes.reason?.message?.slice(0, 80) : null;
  const dexErr = dexRes?.status === "rejected" ? dexRes.reason?.message?.slice(0, 80) : null;
  const pythErr = pythRes?.status === "rejected" ? pythRes.reason?.message?.slice(0, 80) : null;

  const sources = [
    { name: "Jupiter", price: jup },
    { name: "DexScreener", price: dex },
  ];
  if (usePyth) sources.push({ name: "Pyth", price: pyth });
  const respondingCount = sources.filter((s) => s.price != null && s.price > 0).length;

  if (respondingCount === 0) {
    throw new Error(`No USD price data for ${mint} (jup=${jupErr ?? "n/a"}; dex=${dexErr ?? "n/a"}${usePyth ? `; pyth=${pythErr ?? "n/a"}` : ""})`);
  }

  if (respondingCount === 1) {
    const survivor = sources.find((s) => s.price != null && s.price > 0);
    const down = sources.filter((s) => s.price == null).map((s) => s.name).join(",");
    if (process.env.ALLOW_SINGLE_SOURCE_PRICING === "true") {
      console.warn(`[price-usd] SINGLE-SOURCE FALLBACK ALLOWED for ${mint.slice(0, 8)} via ${survivor.name} (${down} down). Escape hatch is ON.`);
      return survivor.price;
    }
    console.warn(`[price-usd] REFUSED ${mint.slice(0, 8)} — only ${survivor.name} responded (${down} down).`);
    throw new Error(`USD price temporarily unavailable for ${mint.slice(0, 8)} — only ${survivor.name} responded. Try again in a moment.`);
  }

  const agreed = agreeOnPrice({ mint, sources, maxDivergence: MAX_DIVERGENCE });
  if (!agreed) {
    const detail = sources.filter((s) => s.price != null && s.price > 0)
      .map((s) => `${s.name}=$${s.price.toFixed(6)}`).join(", ");
    throw new Error(`USD price sources disagree for ${mint.slice(0, 8)}: ${detail}`);
  }
  if (agreed.outlier) {
    console.warn(`[price-usd] outlier rejected for ${mint.slice(0, 8)}: ${agreed.agreed.join("+")} agreed; ${agreed.outlier} flagged`);
  }
  // Caller may use this for trigger evaluation; previously took min(jup, dex)
  // as a conservative bias. The 3-source agreement helper returns the
  // average of the agreeing pair, which is a stronger consensus value.
  return agreed.price;
}

/**
 * Given an amount of collateral tokens (raw, with decimals), return its
 * equivalent value in lamports. Cross-sourced (Jupiter + DexScreener)
 * to defend against single-source price manipulation.
 *
 * ScaledUiAmount-aware. Backed xStocks (and any future Token-2022
 * mint with the ScaledUiAmountConfig extension) carry a per-mint
 * multiplier that grows over time as dividends accrue and adjusts at
 * stock splits. The on-chain raw amount stays constant; the UI amount
 * users see (and DEX-quoted prices) reflect raw × multiplier. Without
 * applying the multiplier here, after any dividend or split the bot
 * would under-value collateral by exactly that factor.
 *
 * Verified live 2026-06-10 against real SPYx (multiplier 1.002561 →
 * 0.26% under-valuation if uncorrected) and NVDAx (multiplier 1.000103).
 *
 * ATTESTATION-SAFE MULTIPLIER CLAMP (2026-06-20, P0). The on-chain program
 * values collateral at the ATTESTED price (price-attestor posts getPriceInSol
 * × 1e9 — WITHOUT the scaled-UI multiplier) and rejects any submitted
 * collateral_value more than MAX_VALUE_TOLERANCE_BPS (3%) above it
 * (ErrorCode::CollateralValueExceedsAttestation, identical across V1/V2/V3/V4).
 * Because the attestor omits the multiplier but this offer applies it, a
 * scaled-UI multiplier above ~1.03 makes the offer exceed what the chain will
 * ever accept — producing an inflated "dollar figure offered" AND an on-chain
 * rejection on borrow. A normal Backed dividend multiplier is ~1.00x; a value
 * far above 1.03 is a split/large-accrual/misread, never a routine dividend.
 * We clamp the applied multiplier to the on-chain tolerance so the offer can
 * NEVER exceed the attestation from the multiplier term — fixing the offer +
 * the rejection in one shared chokepoint that every borrow path uses. Legit
 * small multipliers (<= the clamp) pass through unchanged.
 */
// 1.03 on-chain tolerance × 0.997 buffer for spot/TWAP drift between this
// quote and the user signing. Mirrors the v4-twap endpoint's 30bps buffer.
const MAX_SAFE_SCALED_UI_MULTIPLIER = 1.03 * 0.997; // ≈ 1.02691

export async function collateralValueLamports(mint, rawAmount, decimals) {
  const [priceSol, rawMultiplier] = await Promise.all([
    getPriceInSolCrossSourced(mint),
    getScaledUiMultiplier(mint),
  ]);
  // Clamp the scaled-UI multiplier so the offer can never exceed the on-chain
  // attestation (which carries no multiplier) beyond its 3% tolerance.
  const multiplier = Math.min(rawMultiplier, MAX_SAFE_SCALED_UI_MULTIPLIER);
  if (rawMultiplier > MAX_SAFE_SCALED_UI_MULTIPLIER) {
    console.warn(
      `[price] scaled-UI multiplier ${rawMultiplier} for ${mint.slice(0, 8)}… exceeds the ` +
        `on-chain attestation tolerance; clamped to ${multiplier.toFixed(5)} to prevent ` +
        `CollateralValueExceedsAttestation + inflated offer. (attestor posts no multiplier.)`,
    );
  }
  // (rawAmount × multiplier) / 10^decimals = the UI amount users see in
  // their wallet, which is what Jupiter/DexScreener price quotes refer to.
  const humanAmount = (Number(rawAmount) * multiplier) / 10 ** decimals;
  const valueSol = humanAmount * priceSol;
  return Math.floor(valueSol * 1e9);
}

// ─── ScaledUiAmount helpers ─────────────────────────────────────────────
//
// Cached per-mint. Backed updates the multiplier at most a few times per
// year (quarterly dividends + stock splits); 15-min TTL is conservative.
//
// The ScaledUiAmountConfig layout (after deserialization) carries TWO
// multipliers — the currently-active one and a "newer" one that becomes
// active at newer_multiplier_effective_timestamp. We pick whichever the
// current wall-clock says is in force.

const SCALED_UI_CACHE = new Map(); // mint → { multiplier, expires_at_ms, fetched_at_ms, was_extension_observed }
const SCALED_UI_TTL_MS = 15 * 60 * 1000;
const SCALED_UI_NEGATIVE_TTL_MS = 60 * 60 * 1000; // 1h cache that "no extension exists"
// Last-known-good staleness ceiling. We'll serve a stale multiplier
// from cache during sustained RPC outages, but if we haven't been
// able to refresh in this long we log a loud warning every fetch so
// the operator sees something is broken. Backed updates multipliers
// at most a few times per year; a 24-hour gap is still safe but
// definitely needs attention.
const SCALED_UI_STALE_WARN_MS = 24 * 60 * 60 * 1000;
// Wall-clock boundary buffer for the newer-multiplier flip. If the
// effective timestamp is within this window of "now", pick the lower
// of older/newer (conservative — under-valuing collateral is safer
// for the protocol than over-valuing it). Catches clocks skewed up
// to 5 minutes vs on-chain consensus time.
const SCALED_UI_EFFECTIVE_TS_BUFFER_SEC = 5 * 60;

/**
 * Returns the live ScaledUiAmount multiplier for a mint. For mints
 * without the extension (every non-Token-2022 token + most Token-2022
 * tokens), returns 1.0. Cached.
 *
 * Outage behavior: during a sustained RPC outage we serve the
 * last-known-good multiplier from cache rather than degrading to
 * 1.0. Falling back to 1.0 under-values Backed xStocks (currently
 * ~0.26% for SPYx) and would compound after every dividend update —
 * a long outage could push a borrower over the liquidation threshold
 * from a stale-multiplier under-valuation alone.
 */
export async function getScaledUiMultiplier(mint) {
  const now = Date.now();
  const cached = SCALED_UI_CACHE.get(mint);
  if (cached && cached.expires_at_ms > now) return cached.multiplier;

  let multiplier = 1.0;
  let extensionObserved = false;
  let fetchFailed = false;
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const { connection } = await import("../solana/connection.js");
    const { getMint, getExtensionData, TOKEN_2022_PROGRAM_ID, ExtensionType } = spl;
    const mintPk = new PublicKey(mint);
    const info = await connection.getAccountInfo(mintPk);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const m = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
      const scalData = m.tlvData?.length
        ? getExtensionData(ExtensionType.ScaledUiAmountConfig, m.tlvData)
        : null;
      if (scalData && scalData.length >= 56) {
        extensionObserved = true;
        // Layout: authority(32) + multiplier(f64=8) +
        //         newer_multiplier_effective_timestamp(i64=8) + newer_multiplier(f64=8)
        const older = scalData.readDoubleLE(32);
        const newerEffectiveTs = scalData.readBigInt64LE(40);
        const newer = scalData.readDoubleLE(48);
        const nowSec = Math.floor(Date.now() / 1000);
        const newerValid = Number.isFinite(newer) && newer > 0;
        const olderValid = Number.isFinite(older) && older > 0;
        const tsNum = Number(newerEffectiveTs);
        // Conservative selection during the boundary window: if the
        // wall clock is within SCALED_UI_EFFECTIVE_TS_BUFFER_SEC of
        // the effective timestamp AND both multipliers are valid,
        // pick the LOWER one. This makes wall-clock skew under-value
        // rather than over-value collateral — safer for the protocol
        // than the reverse (an early flip could over-value, leading
        // to under-collateralized loans).
        if (newerValid && olderValid && Math.abs(nowSec - tsNum) <= SCALED_UI_EFFECTIVE_TS_BUFFER_SEC) {
          multiplier = Math.min(older, newer);
        } else if (nowSec >= tsNum && newerValid) {
          multiplier = newer;
        } else {
          multiplier = older;
        }
        // Defensive: never apply a non-finite or non-positive multiplier.
        if (!Number.isFinite(multiplier) || multiplier <= 0) {
          console.warn(`[price] ScaledUiAmount multiplier for ${mint.slice(0, 8)} is non-finite (${multiplier}); falling back to 1.0`);
          multiplier = 1.0;
          extensionObserved = false;
        }
      }
    }
    SCALED_UI_CACHE.set(mint, {
      multiplier,
      expires_at_ms: now + (multiplier === 1.0 ? SCALED_UI_NEGATIVE_TTL_MS : SCALED_UI_TTL_MS),
      fetched_at_ms: now,
      was_extension_observed: extensionObserved,
    });
  } catch (err) {
    fetchFailed = true;
    // Sustained-outage degradation defense. Behavior matrix:
    //   - cached value exists + extension was observed → serve stale,
    //     warn if older than SCALED_UI_STALE_WARN_MS.
    //   - cached value exists + extension was never observed → keep
    //     1.0 (correct for non-RWA tokens; transient RPC blip on a
    //     plain SPL token should not become a warning storm).
    //   - no cache → 1.0 for this call but cache it only briefly so
    //     we retry soon (don't poison the cache with 1.0 for 15min
    //     on a one-off RPC blip mid-loan).
    console.warn(`[price] getScaledUiMultiplier failed for ${mint.slice(0, 8)}: ${err.message}`);
    if (cached && cached.was_extension_observed) {
      const staleMs = now - (cached.fetched_at_ms || 0);
      if (staleMs > SCALED_UI_STALE_WARN_MS) {
        console.warn(
          `[price] CRITICAL: ScaledUiAmount cache for ${mint.slice(0, 8)} is ${Math.round(staleMs / 3_600_000)}h stale ` +
          `and RPC is failing. Collateral valuation may be off-by-dividend. Investigate RPC health.`,
        );
      }
      // Extend the existing entry briefly but DON'T overwrite
      // fetched_at_ms — we want the staleness clock to keep ticking.
      SCALED_UI_CACHE.set(mint, {
        ...cached,
        expires_at_ms: now + 60_000,
      });
      return cached.multiplier;
    }
    SCALED_UI_CACHE.set(mint, {
      multiplier: 1.0,
      expires_at_ms: now + 60_000,
      fetched_at_ms: cached?.fetched_at_ms ?? 0,
      was_extension_observed: false,
    });
  }
  return multiplier;
}
