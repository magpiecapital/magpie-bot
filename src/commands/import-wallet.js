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
  // Only treat ctx.match as a key if it actually looks like base58 — otherwise
  // we'd misinterpret callback data like "start:import" as a (broken) key.
  const raw = typeof ctx.match === "string" ? ctx.match.trim() : "";
  const looksLikeKey = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(raw);
  if (looksLikeKey) {
    return doImport(ctx, tgUser, raw);
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
  // Phantom exports base58 (88 chars). Solflare exports a JSON byte array
  // ([12,34,56,...]). Support both.
  let normalizedKey = key;
  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    let secretKey;
    if (key.startsWith("[")) {
      // Solflare JSON array format
      const arr = JSON.parse(key);
      secretKey = Uint8Array.from(arr);
      // Re-encode to base58 so wallet service sees consistent format downstream
      normalizedKey = bs58.default.encode(secretKey);
    } else {
      secretKey = bs58.default.decode(key);
    }
    Keypair.fromSecretKey(secretKey);
  } catch (err) {
    console.error("[import] parse failed:", err?.message);
    return ctx.reply(
      [
        "That doesn't look right. Make sure you're pasting your full private key:",
        "",
        "• *Phantom*: Settings → Show Secret Recovery Phrase isn't it — you need *Export Private Key* (a long string of letters and numbers)",
        "• *Solflare*: Settings → Export Private Key (long string or array of numbers)",
        "",
        "Try again — tap *Import existing wallet* once more.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  const user = await upsertUser(tgUser.id, tgUser.username);

  try {
    const { publicKey } = await importWallet(user.id, normalizedKey);

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
