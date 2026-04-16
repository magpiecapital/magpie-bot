export async function handleHelp(ctx) {
  const msg = [
    "🏦 *BagBank Help*",
    "",
    "/start — onboard, get your deposit address",
    "/deposit — show your deposit address",
    "/positions — view your active loans",
    "/borrow — take out a SOL loan against memecoin collateral",
    "/repay — repay an active loan and reclaim collateral",
    "/price <symbol> — check a token's oracle price",
    "/withdraw — send SOL or tokens out of your BagBank wallet",
    "/export — export your private key (⚠️ custodial)",
    "",
    "*How it works*",
    "1. Deposit memecoins to your BagBank address",
    "2. Choose a loan tier:",
    "   • 30% LTV — 2 days",
    "   • 25% LTV — 3 days",
    "   • 20% LTV — 7 days",
    "3. Get SOL instantly, 1.5% origination fee",
    "4. Repay before due date to reclaim your bag",
    "5. Miss the deadline → collateral is liquidated",
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "Markdown" });
}
