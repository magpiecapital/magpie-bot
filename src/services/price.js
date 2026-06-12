import axios from "axios";
import "dotenv/config";

// Jupiter v2 was deprecated in 2025. v3 returns USD only, so SOL-denominated
// prices are derived as token_usd / sol_usd.
const JUPITER_API = process.env.JUPITER_API_URL || "https://lite-api.jup.ag/price/v3";
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
  const resp = await axios.get(JUPITER_API, {
    params: { ids: `${mint},${SOL_MINT}` },
    timeout: 10_000,
  });
  const tokenUsd = resp.data?.[mint]?.usdPrice;
  const solUsd = resp.data?.[SOL_MINT]?.usdPrice;
  if (!tokenUsd || !solUsd) {
    throw new Error(`No price data for mint ${mint}`);
  }
  return tokenUsd / solUsd;
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
  // Attempt 1: Jupiter
  try {
    return await jupiterPriceInSol(mint);
  } catch (err1) {
    if (!isTransientPriceError(err1)) {
      // Non-transient (e.g. mint not on Jupiter). Skip retry, try DexScreener.
      try {
        const dex = await dexscreenerPriceInSol(mint);
        console.warn(`[price] ${mint.slice(0, 8)} fallback to DexScreener (Jupiter: ${err1.message})`);
        return dex;
      } catch (err2) {
        throw new Error(`No price data for ${mint} (Jupiter: ${err1.message}; DexScreener: ${err2.message})`);
      }
    }

    // Transient — wait 200-700ms with jitter, retry Jupiter once.
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 500));
    try {
      return await jupiterPriceInSol(mint);
    } catch (err2) {
      // Retry failed too. Fall back to DexScreener.
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
    const ids = chunk.concat(solUsd ? [] : [SOL_MINT]).join(",");
    const resp = await axios.get(JUPITER_API, {
      params: { ids },
      timeout: 15_000,
    });
    if (!solUsd) {
      solUsd = resp.data?.[SOL_MINT]?.usdPrice;
      if (!solUsd) throw new Error("No SOL price from Jupiter");
    }
    for (const mint of chunk) {
      const usd = resp.data?.[mint]?.usdPrice;
      if (usd) result.set(mint, usd / solUsd);
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
  const [jupRes, dexRes] = await Promise.allSettled([
    getPriceInSol(mint),
    dexscreenerPriceInSol(mint),
  ]);

  const jup = jupRes.status === "fulfilled" ? jupRes.value : null;
  const dex = dexRes.status === "fulfilled" ? dexRes.value : null;
  const jupErr = jupRes.status === "rejected" ? jupRes.reason?.message?.slice(0, 80) : null;
  const dexErr = dexRes.status === "rejected" ? dexRes.reason?.message?.slice(0, 80) : null;

  if (!jup && !dex) {
    throw new Error(`No price data for ${mint} from any source (jup=${jupErr ?? "n/a"}; dex=${dexErr ?? "n/a"})`);
  }

  // Single-source case — fail closed unless the env-var escape hatch is on.
  if (!jup || !dex) {
    const survivor = jup ? "Jupiter" : "DexScreener";
    const downSrc = jup ? "DexScreener" : "Jupiter";
    const downErr = jup ? dexErr : jupErr;
    if (process.env.ALLOW_SINGLE_SOURCE_PRICING === "true") {
      console.warn(`[price] SINGLE-SOURCE FALLBACK ALLOWED for ${mint.slice(0, 8)} via ${survivor} (${downSrc} down: ${downErr}). Escape hatch is ON — security posture is degraded.`);
      return jup ?? dex;
    }
    console.warn(`[price] REFUSED ${mint.slice(0, 8)} — only ${survivor} responded (${downSrc} down: ${downErr}). Set ALLOW_SINGLE_SOURCE_PRICING=true to override.`);
    throw new Error(`Price data temporarily unavailable for ${mint.slice(0, 8)} — only ${survivor} responded (${downSrc} is down). Try again in a moment.`);
  }

  // Both returned — verify agreement.
  const divergence = Math.abs(jup - dex) / Math.min(jup, dex);
  if (divergence > MAX_DIVERGENCE) {
    throw new Error(
      `Price sources disagree for ${mint.slice(0, 8)}: Jupiter=${jup.toFixed(9)} SOL vs DexScreener=${dex.toFixed(9)} SOL (${(divergence * 100).toFixed(1)}% gap). Likely manipulation — refusing to value.`,
    );
  }
  return jup;
}

/**
 * USD price helpers — used by conditional-borrow trigger evaluation.
 * Same cross-source resiliency model: prefer Jupiter, fall back to
 * DexScreener, agree-or-throw when both respond. Returns USD per token.
 */
async function jupiterPriceInUsd(mint) {
  const resp = await axios.get(JUPITER_API, {
    params: { ids: mint },
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
  const [jupRes, dexRes] = await Promise.allSettled([
    jupiterPriceInUsd(mint),
    dexscreenerPriceInUsd(mint),
  ]);
  const jup = jupRes.status === "fulfilled" ? jupRes.value : null;
  const dex = dexRes.status === "fulfilled" ? dexRes.value : null;
  const jupErr = jupRes.status === "rejected" ? jupRes.reason?.message?.slice(0, 80) : null;
  const dexErr = dexRes.status === "rejected" ? dexRes.reason?.message?.slice(0, 80) : null;

  if (!jup && !dex) throw new Error(`No USD price data for ${mint} (jup=${jupErr ?? "n/a"}; dex=${dexErr ?? "n/a"})`);

  if (!jup || !dex) {
    const survivor = jup ? "Jupiter" : "DexScreener";
    const downSrc = jup ? "DexScreener" : "Jupiter";
    const downErr = jup ? dexErr : jupErr;
    if (process.env.ALLOW_SINGLE_SOURCE_PRICING === "true") {
      console.warn(`[price-usd] SINGLE-SOURCE FALLBACK ALLOWED for ${mint.slice(0, 8)} via ${survivor} (${downSrc} down: ${downErr}). Escape hatch is ON.`);
      return jup ?? dex;
    }
    console.warn(`[price-usd] REFUSED ${mint.slice(0, 8)} — only ${survivor} responded (${downSrc} down: ${downErr}).`);
    throw new Error(`USD price temporarily unavailable for ${mint.slice(0, 8)} — only ${survivor} responded. Try again in a moment.`);
  }

  const divergence = Math.abs(jup - dex) / Math.min(jup, dex);
  if (divergence > MAX_DIVERGENCE) {
    throw new Error(
      `USD price sources disagree for ${mint.slice(0, 8)}: Jupiter=$${jup.toFixed(6)} vs DexScreener=$${dex.toFixed(6)}`,
    );
  }
  // Take the more conservative (lower) value — caller may use this
  // for trigger evaluation, where "go conservative" is the right bias.
  return Math.min(jup, dex);
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
 */
export async function collateralValueLamports(mint, rawAmount, decimals) {
  const [priceSol, multiplier] = await Promise.all([
    getPriceInSolCrossSourced(mint),
    getScaledUiMultiplier(mint),
  ]);
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
