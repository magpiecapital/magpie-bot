import { handleStart } from "./start.js";

// /home is an alias for /start (without deep link or referral handling)
export async function handleHome(ctx) {
  // Clear any deep link / referral match so it shows the main menu
  ctx.match = "";
  return handleStart(ctx);
}
