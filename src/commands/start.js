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

  const startArg = typeof ctx.match === "string" ? ctx.match.trim() : "";

  // Referral attribution: t.me/botname?start=REFCODE
  if (startArg && startArg !== "loan") {
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
    "🪶 *Magpie — Solana Token Intelligence*",
    "",
    "_Auto-discovers, vets, and tracks tokens across the Solana ecosystem 24/7._",
    "",
    "Your Magpie wallet:",
    `\`${publicKey}\``,
    "",
    "*What I do for you*",
    "🔍 Surface emerging tokens before they trend",
    "🛡️ Filter scams, rug-pulls, and dead liquidity",
    "📊 Live risk profiles + market data",
    "🧠 Your on-chain credit score",
    "",
    "*Start here*",
    "/supported — browse the approved token list",
    "/risk `<symbol>` — risk profile + market snapshot",
    "/price `<symbol>` — live token price",
    "/credit — your credit score",
    "/me — your account",
    "/help — full command list",
    "",
    "_Lending is paused while we redesign the protocol._",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("📋 Supported tokens", "start:supported")
    .text("🧠 My credit", "start:credit")
    .row()
    .text("🪪 My account", "start:balances")
    .text("🔑 Import wallet", "start:import");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerStartCallbacks(bot) {
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

  bot.callbackQuery("start:credit", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleCredit } = await import("./credit.js");
    await handleCredit(ctx);
  });

  bot.callbackQuery("start:import", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleImport } = await import("./import-wallet.js");
    await handleImport(ctx);
  });

  bot.callbackQuery("start:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.match = "";
    await handleStart(ctx);
  });

  // Legacy borrow callback — route to the disabled-lending message so old
  // links / cached buttons don't error.
  bot.callbackQuery("start:borrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleDisabledLending } = await import("./_disabled.js");
    await handleDisabledLending(ctx);
  });
}
