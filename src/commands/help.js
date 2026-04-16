import { isAdmin } from "../services/admin.js";

export async function handleHelp(ctx) {
  const lines = [
    "🏦 *BagBank Help*",
    "",
    "/start — onboard, get your deposit address",
    "/deposit — show your deposit address",
    "/positions — view your active loans (with health)",
    "/history — last 10 loans (any status)",
    "/borrow — take out a SOL loan against memecoin collateral",
    "/repay — repay an active loan and reclaim collateral",
    "/price <symbol> — check a token's oracle price",
    "/withdraw — send SOL or tokens out of your BagBank wallet",
    "/export — export your private key (⚠️ custodial)",
    "/stats — global pool stats",
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
  ];

  if (isAdmin(ctx.from?.id)) {
    lines.push(
      "",
      "*Admin*",
      "/pause, /resume — toggle new borrows",
      "/adminstatus — system overview",
      "/enablemint <mint> <symbol> <decimals> [name]",
      "/disablemint <symbol|mint>",
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
