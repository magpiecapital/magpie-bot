/**
 * /privacy — plain-English data summary.
 *
 * Explains what Magpie stores, where it lives, and how the user can
 * get a copy or have their data deleted. Mirrors GDPR-style "right
 * to know / right of access / right of erasure" obligations even
 * though we're not legally bound by them — building trust is its
 * own reason.
 */
import { InlineKeyboard } from "grammy";

const SITE = "https://magpie.capital";

export async function handlePrivacy(ctx) {
  const kb = new InlineKeyboard()
    .url("📥 Download my data", `${SITE}/dashboard`)
    .row()
    .url("📜 Full privacy notes", `${SITE}/docs`);

  await ctx.reply(
    [
      "🔐 *Magpie & your data*",
      "",
      "*What we store:*",
      "• Wallet pubkeys + (for bot-managed wallets) an encrypted secret",
      "• Loan history — already public on Solana, mirrored for fast lookups",
      "• Support tickets you've opened + the team's replies",
      "• Notification + Auto-Protect prefs",
      "• Telegram user id + username",
      "",
      "*What we don't store:*",
      "• Plaintext private keys (custodial keys are AES-encrypted at rest, decryption key in env)",
      "• Externally-held wallet keys (Phantom-style) — those never reach our server",
      "• Anything outside the bot or your account on magpie.capital",
      "",
      "*Your controls:*",
      "• `/lock 24` — emergency freeze on site signed actions (24h, 7d, etc.)",
      "• `/me` — full account summary",
      "• `/wallets` — list, switch, or remove wallets",
      "• `/mytickets` — see your support history",
      "• `/exportdata` — DMs you a JSON file with everything (same content the dashboard download produces)",
      "• On the dashboard: tap *Download my data* to get a JSON export of everything",
      "• On the dashboard: closed tickets can be permanently deleted",
      "",
      "*If you suspect compromise:* run `/lock 24` immediately, then move funds to a fresh wallet.",
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true },
  );
}
