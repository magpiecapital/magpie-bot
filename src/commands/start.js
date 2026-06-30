import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet, listWallets } from "../services/wallet.js";
import { getOrCreateCode, attribute } from "../services/referrals.js";
import { getPrefs } from "../services/prefs.js";

// Short pubkey for compact display (e.g. abcdef…1234)
function shortPubkey(pk) {
  if (!pk) return "?";
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

/**
 * Build the wallet section of the home/welcome message.
 * Single wallet: shows just the address (clean, unchanged behaviour).
 * Multiple wallets: surfaces active + count + brief listing so the user
 * never forgets which wallets are loaded into their account.
 */
function renderWalletSection(wallets, activePubkey) {
  if (!wallets || wallets.length <= 1) {
    return [
      "Your Magpie wallet:",
      `\`${activePubkey}\``,
    ];
  }
  const active = wallets.find((w) => w.isActive);
  const inactives = wallets.filter((w) => !w.isActive);
  const inactiveLabels = inactives
    .map((w) => `${w.label} (\`${shortPubkey(w.publicKey)}\`)`)
    .join(", ");
  return [
    `*Your wallets* (${wallets.length} loaded · /wallets to manage)`,
    "",
    `✅ Active: *${active?.label || "Magpie wallet"}*`,
    `\`${active?.publicKey || activePubkey}\``,
    "",
    `_+ ${inactives.length} more: ${inactiveLabels}_`,
  ];
}

export async function handleStart(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  // Pull every wallet so the home page can surface multi-wallet state.
  // Cheap query (one indexed select); safe to do on every /start.
  const wallets = await listWallets(user.id);

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

  const walletSection = renderWalletSection(wallets, publicKey);
  const multiWallet = wallets.length > 1;

  const msg = [
    "🏦 *Welcome to Magpie*",
    "",
    "*Collateral that can still sell itself\\.*",
    "Borrow SOL against your tokens — and set auto\\-sells on the same collateral\\. Liquidity, without giving up the upside\\.",
    "",
    "_I'm Pip — Magpie's AI agent. I'll help you borrow SOL against your memecoin bags, manage loans, and answer questions along the way._",
    "",
    ...walletSection,
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
    "/wallets — view + switch between your wallets",
    "/me — your wallet, tier, and referral code",
    "/magpie — official $MAGPIE token info",
    "/support — chat with our AI agent or open a ticket",
    "/community — join the public Magpie group (@magpietalk)",
    "/help — full command list",
  ].join("\n");

  // When the user has more than one wallet, surface a dedicated
  // "My Wallets" button so they can hop to the switcher in one tap.
  // For single-wallet users we keep the original layout to avoid
  // adding noise.
  const kb = new InlineKeyboard()
    .text("💰 Borrow now", "start:borrow")
    .text("📋 Supported tokens", "start:supported")
    .row();
  if (multiWallet) {
    kb.text(`💼 My wallets (${wallets.length})`, "start:wallets").row();
  }
  kb.text("🔑 Import existing wallet", "start:import")
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

  bot.callbackQuery("start:wallets", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleWallets } = await import("./wallets.js");
    await handleWallets(ctx);
  });
}
