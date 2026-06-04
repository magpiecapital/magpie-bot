import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { importWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";
import { clearPending as clearBorrowPending } from "./borrow.js";
import { clearPending as clearWithdrawPending } from "./withdraw.js";

const awaiting = new Map();

// Check whether this user has active loans on the CURRENT wallet. Importing
// a different wallet while loans exist will lock them out of repaying —
// the on-chain loan record has the original borrower's pubkey as a
// has_one constraint, so signing from a different wallet fails with
// ConstraintHasOne. We warn before they shoot themselves in the foot.
async function hasActiveLoans(userId) {
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS n FROM loans WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return (r?.n || 0) > 0;
}

export async function handleImport(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  // Immediately delete the message in case it contains a private key.
  try { await ctx.deleteMessage(); } catch (_) {}

  const user = await upsertUser(tgUser.id, tgUser.username);

  // SAFETY GATE: if they have active loans, importing a different wallet
  // makes those loans un-repayable from this account. Show a hard warning
  // with confirmation before proceeding.
  if (await hasActiveLoans(user.id)) {
    const kb = new InlineKeyboard()
      .text("✕ Cancel — keep current wallet", "import:cancel")
      .row()
      .text("⚠️ I understand — import anyway", "import:active_loans_warn");
    return ctx.reply(
      [
        "🚨 *You have active loans on your current wallet*",
        "",
        "If you import a different wallet, you *will not be able to repay those loans*. Magpie loans are bound to the wallet that opened them — switching wallets locks you out.",
        "",
        "*Before importing:*",
        "1. /positions — see your active loans",
        "2. /repay or /partialrepay them from your CURRENT wallet first",
        "3. THEN /import the new wallet",
        "",
        "*If you import anyway:*",
        "Your active loans will go past-due, get liquidated, and you'll lose the collateral. The borrowed SOL is yours to keep, but the bag stays gone.",
        "",
        "_Are you sure?_",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  }

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
    // Defensively clear leftover state from sibling flows (borrow, withdraw)
    // that also intercept text messages. Without this, an abandoned /withdraw
    // session can hijack the pasted private key and surface as "Invalid
    // Solana address" — a confusing failure that looks like /import broken.
    clearBorrowPending(ctx.chat.id);
    clearWithdrawPending(ctx.chat.id);
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

  // User confirmed the active-loans warning — proceed to normal import flow.
  bot.callbackQuery("import:active_loans_warn", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("📋 Paste my private key", "import:ready")
      .row()
      .text("❌ Cancel", "import:cancel");
    await ctx.editMessageText(
      [
        "🔑 *Import — confirmed override*",
        "",
        "You acknowledged the active-loan risk. Tap below to paste your key.",
        "",
        "_Your current active loans will become un-repayable from this account._",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
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
