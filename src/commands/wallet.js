import { handleDeposit } from "./deposit.js";

// /wallet is a convenience alias for /deposit — shows the user's Magpie wallet address.
export async function handleWallet(ctx) {
  return handleDeposit(ctx);
}
