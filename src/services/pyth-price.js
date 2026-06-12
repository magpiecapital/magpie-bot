/**
 * Pyth Network price feeds via Hermes HTTP API — third source for the
 * cross-sourced price gate (audit F-2 follow-up).
 *
 * The audit's F-2 left a follow-up: when Jupiter and DexScreener
 * disagree or one is down, current behavior is fail-closed reject.
 * Pyth as an institutional-grade third source gives us a tiebreaker.
 *
 * For mints WITH Pyth coverage (top ~12 by mcap), use median-of-3 with
 * a 2-of-3 agreement check in price.js. For mints WITHOUT Pyth coverage
 * (most memecoins), the existing strict 2-source check stays in place.
 *
 * Hermes is Pyth's official off-chain HTTP API. No SDK, no on-chain
 * read — just `axios`. Endpoint:
 *
 *   GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<feed>
 *
 * Response shape (per feed in `parsed[]`):
 *   {
 *     price: { price: "6653391666", expo: -8, conf: "3608332", publish_time: ... },
 *     metadata: { ... }
 *   }
 *
 * Real price = price * 10^expo. Confidence interval = conf * 10^expo.
 * We reject if confidence_pct > MAX_PYTH_CONFIDENCE_PCT — Pyth's own
 * way of saying "I'm not sure, don't trust me right now."
 */
import axios from "axios";

const HERMES_BASE = process.env.PYTH_HERMES_URL || "https://hermes.pyth.network";
const HERMES_TIMEOUT_MS = 5_000;

// Stale-after threshold. Pyth feeds publish every ~400ms; anything over
// 60s old means something is broken upstream and we shouldn't trust the
// value. The on-chain Pyth account has its own staleness check; this is
// the off-chain equivalent.
const MAX_STALENESS_MS = 60_000;

// Confidence-to-price ratio rejection. Pyth publishes a confidence
// interval representing how sure they are. If conf/price > this pct,
// the feed is saying "wide spread on this asset right now" — could be
// halted trading, illiquid window, etc. Reject rather than guess.
const MAX_PYTH_CONFIDENCE_PCT = 0.05; // 5%

// Local result cache. Hermes is fast but we don't need sub-second
// updates — borrow flows happen on second timescales, and caching
// matches the existing price.js caching philosophy.
const CACHE_TTL_MS = 5_000;
const cache = new Map(); // key: feedId → { value: { priceUsd, ts }, fetchedAt }

/**
 * Pyth feed ID map (Solana mainnet). Source:
 *   https://www.pyth.network/developers/price-feed-ids#solana-mainnet
 *
 * Only top tokens by mcap that we ALSO support as collateral. Extend
 * here when a new feed becomes available + we onboard the token.
 *
 * IMPORTANT: a mint NOT in this map means "Pyth doesn't cover it" — the
 * cross-sourced gate falls back to 2-source (Jup + Dex) for those mints.
 * That's safe; memecoin pricing relies on DEX liquidity anyway.
 */
export const PYTH_FEED_IDS = new Map([
  // Stables — useful for sanity check of USDC conversion
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a"], // USDC
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"], // USDT
  // SOL — denominator for token/SOL prices
  ["So11111111111111111111111111111111111111112",  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"], // SOL
  // Top Solana tokens with Pyth coverage
  ["jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",  "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2"], // JTO
  ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996"], // JUP
  ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419"], // BONK
  ["EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc"], // WIF
  ["HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff"], // PYTH
  ["27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", "c811abc82b4bad1f9bd711a2773ccaa935b03ecef974236942cec5e0eb845a3a"], // JLP
  ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4"], // mSOL
]);

export function hasPythCoverage(mint) {
  return PYTH_FEED_IDS.has(String(mint));
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Fetch one or more Pyth feeds in a single Hermes call. Internal —
 * callers use pythPriceInUsd / pythPriceInSol below.
 */
async function fetchHermesFeeds(feedIds) {
  if (feedIds.length === 0) return new Map();

  // Check cache for everything first.
  const out = new Map();
  const stillNeeded = [];
  const now = Date.now();
  for (const id of feedIds) {
    const c = cache.get(id);
    if (c && now - c.fetchedAt < CACHE_TTL_MS) {
      out.set(id, c.value);
    } else {
      stillNeeded.push(id);
    }
  }
  if (stillNeeded.length === 0) return out;

  // Hermes wants ids[]=<hex> repeated. axios's default array serializer
  // collapses a single-element array to ?ids=<v> (no brackets), which
  // Hermes rejects with "expected a sequence". Use an explicit custom
  // serializer to guarantee the bracket form for any array size.
  const idsParam = stillNeeded.map((id) => `ids%5B%5D=0x${id}`).join("&");
  const resp = await axios.get(`${HERMES_BASE}/v2/updates/price/latest?${idsParam}`, {
    timeout: HERMES_TIMEOUT_MS,
  });

  const parsed = Array.isArray(resp.data?.parsed) ? resp.data.parsed : [];
  for (const item of parsed) {
    const id = String(item?.id || "").replace(/^0x/, "");
    const p = item?.price;
    if (!id || !p) continue;
    const rawPrice = Number(p.price);
    const expo = Number(p.expo);
    const conf = Number(p.conf);
    const pubMs = Number(p.publish_time) * 1000;
    if (!Number.isFinite(rawPrice) || !Number.isFinite(expo) || !Number.isFinite(pubMs)) continue;
    const value = rawPrice * Math.pow(10, expo);
    const confidence = conf * Math.pow(10, expo);
    const confidencePct = value > 0 ? confidence / value : 1;
    const ageMs = Date.now() - pubMs;
    const entry = { priceUsd: value, confidence, confidencePct, ageMs, publishedAt: pubMs };
    cache.set(id, { value: entry, fetchedAt: Date.now() });
    out.set(id, entry);
  }
  return out;
}

/**
 * Pyth USD price for `mint`. Throws "no_pyth_feed" if the mint isn't in
 * the coverage map; throws "stale" / "low_confidence" if the feed is
 * present but unhealthy. Returns Number USD per token.
 *
 * Callers should treat "no_pyth_feed" as expected (memecoins) and the
 * other errors as a real degradation signal worth logging.
 */
export async function pythPriceInUsd(mint) {
  const feedId = PYTH_FEED_IDS.get(String(mint));
  if (!feedId) throw new Error("no_pyth_feed");
  const got = await fetchHermesFeeds([feedId]);
  const entry = got.get(feedId);
  if (!entry) throw new Error("no_response");
  if (entry.ageMs > MAX_STALENESS_MS) {
    throw new Error(`stale (${Math.round(entry.ageMs / 1000)}s old)`);
  }
  if (entry.confidencePct > MAX_PYTH_CONFIDENCE_PCT) {
    throw new Error(`low_confidence (${(entry.confidencePct * 100).toFixed(1)}% spread)`);
  }
  return entry.priceUsd;
}

/**
 * Pyth-derived SOL price for `mint`. Computed as token_usd / sol_usd.
 * Both feeds are fetched in one Hermes call so latency is the same as
 * a single-feed lookup.
 */
export async function pythPriceInSol(mint) {
  const tokenFeedId = PYTH_FEED_IDS.get(String(mint));
  if (!tokenFeedId) throw new Error("no_pyth_feed");
  const solFeedId = PYTH_FEED_IDS.get(SOL_MINT);
  if (!solFeedId) throw new Error("sol_feed_missing"); // shouldn't happen — guard for typo
  const got = await fetchHermesFeeds([tokenFeedId, solFeedId]);
  const tok = got.get(tokenFeedId);
  const sol = got.get(solFeedId);
  if (!tok || !sol) throw new Error("no_response");
  if (tok.ageMs > MAX_STALENESS_MS || sol.ageMs > MAX_STALENESS_MS) {
    throw new Error(`stale`);
  }
  if (tok.confidencePct > MAX_PYTH_CONFIDENCE_PCT || sol.confidencePct > MAX_PYTH_CONFIDENCE_PCT) {
    throw new Error(`low_confidence`);
  }
  if (sol.priceUsd <= 0) throw new Error(`sol_price_invalid`);
  return tok.priceUsd / sol.priceUsd;
}
