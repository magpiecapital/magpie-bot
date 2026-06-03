import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { exportSecret } from "../services/wallet.js";

export async function handleExport(ctx) {
  const kb = new InlineKeyboard()
    .text("⚠️ Yes, show my private key", "export:confirm")
    .row()
    .text("Cancel", "export:cancel");

  await ctx.reply(
    [
      "⚠️ *Export private key*",
      "",
      "This reveals the full secret key for your Magpie wallet.",
      "Anyone with this key has full control of your funds.",
      "",
      "• Save it to a password manager",
      "• Never share it or paste it into any website",
      "• The message will auto-delete in 60s",
      "",
      "Continue?",
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

export function registerExportCallbacks(bot) {
  bot.callbackQuery(/^export:cancel$/, async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Export cancelled.");
  });

  bot.callbackQuery(/^export:confirm$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    try {
      const secret = await exportSecret(user.id);
      const msg = await ctx.reply(
        `Your private key (base58):\n\n\`${secret}\`\n\n_This message will auto-delete in 60s._`,
        { parse_mode: "Markdown" },
      );
      await ctx.editMessageText("🔑 Key sent in a follow-up message (self-destructs in 60s).");
      setTimeout(() => {
        ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      }, 60_000);
    } catch (err) {
      console.error("Export failed:", err);
      await ctx.editMessageText(
        [
          "⚠️ *Export failed*",
          "",
          "Couldn't decrypt your wallet key right now. This is rare — usually a transient DB hiccup.",
          "",
          "Try /export again in a moment. If it keeps failing, /support → Chat with agent.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }
  });
}
