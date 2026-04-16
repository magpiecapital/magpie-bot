import axios from "axios";
import "dotenv/config";

const JUPITER_API = process.env.JUPITER_API_URL || "https://api.jup.ag/price/v2";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Fetch price of `mint` denominated in SOL.
 * Returns the price as a float (tokens per 1 SOL → value-per-token).
 */
export async function getPriceInSol(mint) {
  const resp = await axios.get(JUPITER_API, {
    params: { ids: mint, vsToken: SOL_MINT },
    timeout: 10_000,
  });
  const data = resp.data?.data?.[mint];
  if (!data?.price) throw new Error(`No price data for mint ${mint}`);
  return Number(data.price);
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
