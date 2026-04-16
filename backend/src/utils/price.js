/**
 * SOL-denominated price fetching for the liquidation monitor.
 *
 * Returns prices in SOL (not USD), matching how the program stores
 * `collateral_value_at_start` and `original_loan_amount` in lamports.
 */
import axios from "axios";

const JUPITER_API = process.env.JUPITER_API_URL || "https://api.jup.ag/price/v2";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Price of 1 full token of `mint`, denominated in SOL.
 */
export async function getPriceInSol(mint) {
  const resp = await axios.get(JUPITER_API, {
    params: { ids: mint, vsToken: SOL_MINT },
    timeout: 10_000,
  });
  const data = resp.data?.data?.[mint];
  if (!data?.price) return null;
  return Number(data.price);
}

/**
 * Convert a raw collateral amount (with decimals) to its current value in
 * lamports, given the token's on-chain decimals.
 */
export function lamportsFromCollateral(rawAmountBn, priceSol, decimals) {
  const human = Number(rawAmountBn.toString()) / 10 ** decimals;
  return Math.floor(human * priceSol * 1e9);
}
