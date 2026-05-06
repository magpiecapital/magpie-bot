import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { importWallet } from "../services/wallet.js";

const awaiting = new Map();

export async function handleImport(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  // Immediately delete the message in case it contains a private key.
  try { await ctx.deleteMessage(); } catch (_) {}

  // Support legacy inline usage: /import <key>
  const key = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (key) {
    return doImport(ctx, tgUser, key);
  }

  const kb = new InlineKeyboard()
    .text("📋 Paste my private key", "import:ready")
    .row()
    .text("❌ Cancel", "import:cancel");

  await ctx.reply(
    [
      "🔑 *Import your wallet*",
      "",
      "Already holding approved tokens? Connect your existing wallet and borrow instantly — no transfers needed.",
      "",
      "Tap the button below to get started.",
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

async function doImport(ctx, tgUser, key) {
  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    const decoded = bs58.default.decode(key);
    Keypair.fromSecretKey(decoded);
  } catch (_) {
    return ctx.reply("That doesn't look right. Make sure you're pasting your full private key from Phantom or Solflare.");
  }

  const user = await upsertUser(tgUser.id, tgUser.username);

  try {
    const { publicKey } = await importWallet(user.id, key);

    const kb = new InlineKeyboard()
      .text("💰 Borrow now", "start:borrow")
      .text("📋 Check my balances", "start:balances")
      .row()
      .text("📖 Supported tokens", "start:supported")
      .text("🏠 Home", "start:home");

    await ctx.reply(
      [
        "✅ *Wallet imported*",
        "",
        `Address: \`${publicKey}\``,
        "",
        "You're all set. Your tokens are ready to use as collateral — no transfers needed.",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  } catch (err) {
    console.error("Import wallet error:", err);
    await ctx.reply("Failed to import wallet. Please try again.");
  }
}

export function registerImportCallbacks(bot) {
  bot.callbackQuery("import:ready", async (ctx) => {
    await ctx.answerCallbackQuery();
    awaiting.set(ctx.chat.id, true);
    await ctx.reply(
      [
        "🔒 *Paste your private key below*",
        "",
        "Open Phantom or Solflare, go to Settings → Export Private Key, copy it, and paste it here.",
        "",
        "Your message will be deleted immediately for security.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("import:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    awaiting.delete(ctx.chat.id);
    await ctx.reply("Import cancelled. Use /home to go back.");
  });

  // Middleware to catch the pasted private key.
  bot.on("message:text", async (ctx, next) => {
    if (!awaiting.has(ctx.chat.id)) return next();

    awaiting.delete(ctx.chat.id);

    const key = ctx.message.text.trim();

    // Delete the message containing the private key immediately.
    try { await ctx.deleteMessage(); } catch (_) {}

    const tgUser = ctx.from;
    if (!tgUser) return ctx.reply("Could not identify user.");

    await doImport(ctx, tgUser, key);
  });
}
