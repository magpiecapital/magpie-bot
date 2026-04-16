import { isAdmin } from "../services/admin.js";

export async function handleHelp(ctx) {
  const lines = [
    "🏦 *BagBank Help*",
    "",
    "*Account*",
    "/start — onboard (accepts referral: `/start CODE`)",
    "/me — wallet, tier, stats, referral code",
    "/deposit — show your deposit address",
    "/notify — manage notifications + auto-repay",
    "",
    "*Loans*",
    "/supported — accepted collateral with live prices",
    "/simulate <symbol> <amount> [tier] — preview a loan",
    "/borrow — take out a SOL loan",
    "/positions — active loans + live health",
    "/repay — repay and reclaim collateral",
    "/history — last 10 loans",
    "/price <symbol|mint> — oracle price + max loan per tier",
    "",
    "*Wallet*",
    "/withdraw — send SOL or tokens out",
    "/export — export your private key (⚠️ custodial)",
    "",
    "*Stats*",
    "/stats — protocol-wide stats",
    "",
    "*How it works*",
    "1. Deposit memecoins to your BagBank wallet",
    "2. Pick a tier:  30%/2d · 25%/3d · 20%/7d",
    "3. Receive SOL instantly (1.5% origination fee)",
    "4. Repay before due to reclaim your bag",
    "5. Miss the deadline or drop below 1.1x → liquidation",
  ];

  if (isAdmin(ctx.from?.id)) {
    lines.push(
      "",
      "*Admin*",
      "/pause, /resume — toggle new borrows",
      "/adminstatus — system overview",
      "/enablemint <mint> <symbol> <decimals> [name]",
      "/disablemint <symbol|mint>",
      "/broadcast <message> — DM everyone",
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
