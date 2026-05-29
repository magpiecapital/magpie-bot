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
 * Given an amount of collateral tokens (raw, with decimals), return its
 * equivalent value in lamports.
 */
export async function collateralValueLamports(mint, rawAmount, decimals) {
  const priceSol = await getPriceInSol(mint);
  const humanAmount = Number(rawAmount) / 10 ** decimals;
  const valueSol = humanAmount * priceSol;
  return Math.floor(valueSol * 1e9);
}
