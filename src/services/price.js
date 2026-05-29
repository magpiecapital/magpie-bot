import axios from "axios";
import "dotenv/config";

// Jupiter v2 was deprecated in 2025. v3 returns USD only, so SOL-denominated
// prices are derived as token_usd / sol_usd.
const JUPITER_API = process.env.JUPITER_API_URL || "https://lite-api.jup.ag/price/v3";
const SOL_MINT = "So11111111111111111111111111111111111111112";

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
 * Given an amount of collateral tokens (raw, with decimals), return its
 * equivalent value in lamports.
 */
export async function collateralValueLamports(mint, rawAmount, decimals) {
  const priceSol = await getPriceInSol(mint);
  const humanAmount = Number(rawAmount) / 10 ** decimals;
  const valueSol = humanAmount * priceSol;
  return Math.floor(valueSol * 1e9);
}
