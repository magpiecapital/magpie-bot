import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getOrCreateCode, attribute } from "../services/referrals.js";
import { getPrefs } from "../services/prefs.js";

export async function handleStart(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  // Ensure prefs row + referral code exist on first /start.
  await getPrefs(user.id);
  await getOrCreateCode(user.id);

  // Dismiss any legacy reply keyboard sitting under the chat bar.
  // Navigation is now via the menu button (set globally via setMyCommands)
  // and inline keyboards attached to specific messages — both live ABOVE
  // the chat input where users expect them.
  try {
    await ctx.api.sendMessage(ctx.chat.id, "👋", {
      reply_markup: { remove_keyboard: true },
    }).then((m) => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}));
  } catch { /* non-critical */ }

  const startArg = typeof ctx.match === "string" ? ctx.match.trim() : "";

  // Deep link from dashboard: t.me/magpie_capital_bot?start=loan
  if (startArg === "loan") {
    const msg = [
      "🏦 *Ready to borrow SOL*",
      "",
      "Your Magpie wallet:",
      `\`${publicKey}\``,
      "",
      "*Step 1* — Copy the address above",
      "*Step 2* — Send your memecoins here from Phantom/Solflare",
      "*Step 3* — Send ~0.01 SOL for transaction fees",
      "*Step 4* — Tap *Borrow now* below once tokens arrive",
      "",
      "_Tokens typically arrive in under 30 seconds._",
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("💰 Borrow now", "start:borrow")
      .row()
      .text("📋 Check my balances", "start:balances")
      .row()
      .text("📖 Supported tokens", "start:supported")
      .row()
      .text("🔑 Import existing wallet", "start:import")
      .row()
      .text("🛟 Get help", "start:support");

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
    return;
  }

  // Referral attribution: t.me/botname?start=REFCODE
  if (startArg) {
    const referrer = await attribute(user.id, startArg);
    if (referrer) {
      await ctx.api
        .sendMessage(
          referrer.telegram_id,
          `🎉 *New referral*\n\n@${tgUser.username ?? "someone"} just joined Magpie using your code.`,
          { parse_mode: "Markdown" },
        )
        .catch(() => {});
    }
  }

  const msg = [
    "🏦 *Welcome to Magpie*",
    "",
    "_Where your memecoin bags unlock SOL._",
    "",
    "Your Magpie wallet:",
    `\`${publicKey}\``,
    "",
    "*How it works*",
    "1\\. Send memecoins to the address above",
    "2\\. Send ~0.01 SOL for gas fees",
    "3\\. Use /borrow to take out a SOL loan",
    "4\\. Repay before the deadline to reclaim your bag",
    "",
    "💡 *Already have a wallet with approved tokens?*",
    "Tap *Import existing wallet* below to use it directly — no transfers needed\\.",
    "",
    "*Get started*",
    "/supported — see accepted collateral",
    "/simulate — preview a loan with live prices",
    "/borrow — take out a SOL loan",
    "/deposit — show your deposit address",
    "/import — use your existing wallet",
    "/me — your wallet, tier, and referral code",
    "/magpie — official $MAGPIE token info",
    "/support — chat with our AI agent or open a ticket",
    "/help — full command list",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("💰 Borrow now", "start:borrow")
    .text("📋 Supported tokens", "start:supported")
    .row()
    .text("🔑 Import existing wallet", "start:import")
    .row()
    .text("🛟 Get help", "start:support");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerStartCallbacks(bot) {
  bot.callbackQuery("start:borrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    // Delegate to the borrow command handler
    await ctx.reply("Loading your eligible tokens...");
    // Trigger /borrow logic by importing and calling it
    const { handleBorrow } = await import("./borrow.js");
    await handleBorrow(ctx);
  });

  bot.callbackQuery("start:balances", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleMe } = await import("./me.js");
    await handleMe(ctx);
  });

  bot.callbackQuery("start:supported", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleSupported } = await import("./supported.js");
    await handleSupported(ctx);
  });

  bot.callbackQuery("start:import", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleImport } = await import("./import-wallet.js");
    await handleImport(ctx);
  });

  bot.callbackQuery("start:support", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleSupport } = await import("./support.js");
    await handleSupport(ctx);
  });

  bot.callbackQuery("start:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.match = "";
    await handleStart(ctx);
  });
}
