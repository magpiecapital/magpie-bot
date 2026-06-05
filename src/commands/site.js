/**
 * /site — point the user at magpie.capital with a copy of the link
 * they actually want for the action at hand.
 *
 * Site parity has been live for borrow / repay / extend / topup /
 * withdraw / support / wallets / Auto-Protect — this command makes
 * the URLs easy to grab from a phone without typing.
 */
import { InlineKeyboard } from "grammy";

const SITE_URL = "https://magpie.capital";

export async function handleSite(ctx) {
  const kb = new InlineKeyboard()
    .url("📊 Dashboard", `${SITE_URL}/dashboard`).row()
    .url("💰 Earn (LP)", `${SITE_URL}/earn`)
    .url("🏆 Leaderboard", `${SITE_URL}/leaderboard`).row()
    .url("📨 Submit a token", `${SITE_URL}/submit`)
    .url("👥 Refer", `${SITE_URL}/refer`).row()
    .url("📜 Docs", `${SITE_URL}/docs`);

  await ctx.reply(
    [
      "*magpie.capital* — the site does almost everything this bot does, plus a few extras.",
      "",
      "Connect your wallet, then run `/link` here with the code the site generates to pair your account. After that:",
      "",
      "• Borrow / repay / extend / topup / withdraw — all via Phantom",
      "• See loans, credit score, earnings, and activity at a glance",
      "• Auto-Protect + notification prefs",
      "• Chat with the AI agent without opening a ticket",
      "",
      "TG remains fully supported — use whichever surface you prefer.",
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true },
  );
}
