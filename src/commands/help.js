import { InlineKeyboard } from "grammy";
import { isAdmin } from "../services/admin.js";

export async function handleHelp(ctx) {
  const lines = [
    "🏦 *Magpie Help*",
    "",
    "*Navigation*",
    "/home — main menu",
    "/help — this page",
    "",
    "*Account*",
    "/me — wallet, tier, stats, referral code",
    "/deposit — show your deposit address",
    "/notify — manage notifications + auto-repay",
    "",
    "*Loans*",
    "/supported — accepted collateral with live prices",
    "/simulate <symbol> <amount> [tier] — preview a loan",
    "/borrow — take out a SOL loan",
    "/reborrow — quick re-borrow (same token + tier as last loan)",
    "/positions — active loans + live health",
    "/repay — repay and reclaim collateral",
    "/partialrepay — pay down part of a loan",
    "/topup — add collateral (improves health, no fee)",
    "/extend — extend a loan (tier fee: 3%/2%/1.5%)",
    "/history — last 10 loans",
    "/price <symbol|mint> — oracle price + max loan per tier",
    "",
    "*Wallet*",
    "/wallet — show your deposit address",
    "/deposit — same as /wallet",
    "/import — import an existing Solana wallet (advanced)",
    "/withdraw — send SOL or tokens out",
    "/export — export your private key (⚠️ custodial)",
    "",
    "*Credit & Risk*",
    "/credit — view your 300-850 credit score",
    "/risk <symbol> — AI risk assessment for a token",
    "",
    "*Earn*",
    "/refer — earn 5% of friends' loan fees (lifetime, paid in SOL)",
    "/holders — $MAGPIE holders earn 10% of all fees pro-rata (weekly distribution)",
    "",
    "*Marketplace*",
    "/lend — lending marketplace (create pools, deposit, browse)",
    "",
    "*Tokens*",
    "/submit <mint|symbol> — submit a token for collateral approval",
    "",
    "*Stats*",
    "/stats — protocol-wide stats",
    "",
    "*Support*",
    "/support — diagnose a loan, check a tx, or message the team",
    "",
    "*How it works*",
    "1. Deposit memecoins to your Magpie wallet",
    "2. Pick a tier:  30%/2d · 25%/3d · 20%/7d",
    "3. Receive SOL instantly (Express 3%, Quick 2%, Standard 1.5% fee)",
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
      "/reviewtokens — review auto-screened tokens",
    );
  }

  const kb = new InlineKeyboard()
    .text("🏠 Home", "start:home")
    .text("💰 Borrow", "start:borrow")
    .text("📋 Wallet", "fallback:deposit");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb });
}
