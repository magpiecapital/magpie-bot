/**
 * /whatsnew — what's new in Magpie lately.
 *
 * Hand-curated short list of recent additions. Lower-effort than
 * a full changelog page and surfaces features users may have missed.
 * Update this list when shipping anything user-facing worth flagging.
 */
import { InlineKeyboard } from "grammy";

export async function handleWhatsNew(ctx) {
  const kb = new InlineKeyboard()
    .url("📊 Open dashboard", "https://magpie.capital/dashboard")
    .row()
    .text("🔐 My security", "me:security");

  await ctx.reply(
    [
      "✨ *What's new on Magpie*",
      "",
      "*Site (magpie.capital/dashboard) now does everything this bot does:*",
      "• Borrow / repay / extend / topup — all via Phantom",
      "• Withdraw from your custodial wallet (signed message)",
      "• Wallets view, Auto-Protect + notification toggles",
      "• Full support: open tickets, chat with the AI, follow up",
      "• Activity feed + earnings summary",
      "• Floating AI chat for quick questions",
      "",
      "*Security:*",
      "• `/lock 24` — emergency pause on every site signed action",
      "• Per-action TG security DMs with one-tap lock buttons",
      "• `/security` — single-screen safety view",
      "• `/privacy` — what we store + how to control it",
      "• `/exportdata` — JSON dump of your account",
      "",
      "*Useful utilities:*",
      "• `/tx <signature>` — quick lookup of any Solana tx",
      "• `/walletlookup <pubkey>` — Magpie footprint of any wallet",
      "• `/signedhistory` — last 10 signed site actions",
      "",
      "Site:",
      "• magpie.capital/leaderboard — top credit scores",
      "• magpie.capital/status — live protocol health",
      "• magpie.capital/privacy — data + controls",
    ].join("\n"),
    {
      parse_mode: "Markdown",
      reply_markup: kb,
      disable_web_page_preview: true,
    },
  );
}
