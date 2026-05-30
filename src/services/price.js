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
 */
export async function getPriceInSol(mint) {
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
 */
const MAX_DIVERGENCE = 0.10; // 10%

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

export async function getPriceInSolCrossSourced(mint) {
  const [jupRes, dexRes] = await Promise.allSettled([
    getPriceInSol(mint),
    dexscreenerPriceInSol(mint),
  ]);

  const jup = jupRes.status === "fulfilled" ? jupRes.value : null;
  const dex = dexRes.status === "fulfilled" ? dexRes.value : null;

  // If only one source returns, accept it but flag — better than refusing
  // to value a real loan because of a third-party outage.
  if (jup && !dex) {
    console.warn(`[price] ${mint.slice(0, 8)} single-source (Jupiter only): ${jup}`);
    return jup;
  }
  if (!jup && dex) {
    console.warn(`[price] ${mint.slice(0, 8)} single-source (DexScreener only): ${dex}`);
    return dex;
  }
  if (!jup && !dex) {
    throw new Error(`No price data for ${mint} from any source`);
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
 * Given an amount of collateral tokens (raw, with decimals), return its
 * equivalent value in lamports. Cross-sourced (Jupiter + DexScreener)
 * to defend against single-source price manipulation.
 */
export async function collateralValueLamports(mint, rawAmount, decimals) {
  const priceSol = await getPriceInSolCrossSourced(mint);
  const humanAmount = Number(rawAmount) / 10 ** decimals;
  const valueSol = humanAmount * priceSol;
  return Math.floor(valueSol * 1e9);
}
