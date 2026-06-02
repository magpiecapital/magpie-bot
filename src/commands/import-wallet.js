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
  // Phantom exports base58 (87-88 chars). Solflare exports a JSON byte
  // array ([12,34,56,...]). Some wallets export 32-byte SEEDS instead of
  // 64-byte secret keys — we detect and reject those with a clear message.
  let normalizedKey = key;
  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    let secretKey;
    if (key.startsWith("[")) {
      // Solflare JSON array format
      const arr = JSON.parse(key);
      secretKey = Uint8Array.from(arr);
      if (secretKey.length === 32) {
        return ctx.reply(
          [
            "That looks like a 32-byte SEED, not a full 64-byte secret key.",
            "",
            "Magpie needs the full secret key (the 64-byte version) to sign transactions.",
            "",
            "In Solflare: Settings → *Show Private Key* (not 'Show Seed Phrase').",
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      }
      // Re-encode to base58 so wallet service sees consistent format downstream
      normalizedKey = bs58.default.encode(secretKey);
    } else {
      secretKey = bs58.default.decode(key);
      if (secretKey.length === 32) {
        return ctx.reply(
          [
            "That looks like a 32-byte SEED, not a full 64-byte secret key.",
            "",
            "Magpie needs the full secret key to sign transactions.",
            "",
            "In Phantom: Settings → *Export Private Key* (long string starting with no brackets, ~88 characters).",
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      }
    }
    Keypair.fromSecretKey(secretKey);
    console.log(`[import] parse OK · format=${key.startsWith("[") ? "json" : "base58"} · bytes=${secretKey.length}`);
  } catch (err) {
    console.error(`[import] parse failed · len=${key.length} · prefix=${key.slice(0, 3)} · err=${err?.message}`);
    return ctx.reply(
      [
        "That doesn't look right. Make sure you're pasting your full *private key*, not your seed phrase:",
        "",
        "• *Phantom*: Settings → Security & Privacy → *Export Private Key* (a long string of letters/numbers, ~88 chars)",
        "• *Solflare*: Settings → *Show Private Key* (long string OR array of numbers)",
        "",
        "Don't paste your 12/24-word seed phrase — that's a different thing.",
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
    // Surface the actual reason instead of a generic message so we can debug
    // and so users get something more useful than "Please try again."
    console.error("[import] DB/encrypt error:", err?.message, err?.stack?.split("\n")[1]);
    const hint = /WALLET_ENCRYPTION_KEY/i.test(err?.message || "")
      ? "(server config issue — admin notified)"
      : /duplicate|unique/i.test(err?.message || "")
      ? "(this key is already linked to another account)"
      : /connection|ECONNRESET|ETIMEDOUT/i.test(err?.message || "")
      ? "(database connection blip — please retry)"
      : `(${err?.message?.slice(0, 80) || "unknown"})`;
    await ctx.reply(`Failed to import wallet. ${hint}\n\nTry again with /import.`);
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
