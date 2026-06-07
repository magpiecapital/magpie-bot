/**
 * Fallback handler — responds to plain text messages that aren't commands.
 * Maps common phrases to the right command, or shows a helpful nudge.
 */
import { InlineKeyboard } from "grammy";

// Keyword → { handler, label } mapping
// Order matters — first match wins
const PATTERNS = [
  { match: /\b(borrow|loan|get sol|need sol|take.*loan)\b/i, cmd: "borrow", label: "Start borrowing" },
  { match: /\b(wallet|address|deposit|send.*token|add.*wallet|connect.*wallet|link.*wallet)\b/i, cmd: "deposit", label: "Show your wallet" },
  { match: /\b(repay|pay.*back|return|payoff)\b/i, cmd: "repay", label: "Repay a loan" },
  { match: /\b(position|active.*loan|my.*loan|status)\b/i, cmd: "positions", label: "View active loans" },
  { match: /\b(balance|how much|sol.*balance|my.*balance)\b/i, cmd: "me", label: "Check your balance" },
  { match: /\b(support|accept|which.*token|what.*token|collateral|eligible)\b/i, cmd: "supported", label: "Supported tokens" },
  { match: /\b(simulat|preview|estimate|how much.*get|calculator)\b/i, cmd: "simulate", label: "Simulate a loan" },
  { match: /\b(price|worth|value)\b/i, cmd: "price", label: "Check a price" },
  { match: /\b(credit|score)\b/i, cmd: "credit", label: "View credit score" },
  { match: /\b(history|past.*loan|previous)\b/i, cmd: "history", label: "Loan history" },
  { match: /\b(withdraw|send.*sol|transfer.*out|cash.*out)\b/i, cmd: "withdraw", label: "Withdraw funds" },
  { match: /\b(help|commands|what.*can|how.*work|how.*do)\b/i, cmd: "help", label: "Show help" },
  { match: /\b(import|private.*key|secret.*key)\b/i, cmd: "import", label: "Import wallet (advanced)" },
  { match: /\b(refer|invite|share)\b/i, cmd: "me", label: "Get your referral link" },
  { match: /\b(extend|more.*time|deadline)\b/i, cmd: "extend", label: "Extend a loan" },
  { match: /\b(risk|safe|dangerous)\b/i, cmd: "risk", label: "Token risk assessment" },
  { match: /\b(stats|protocol|tvl|volume)\b/i, cmd: "stats", label: "Protocol stats" },
  { match: /\b(notify|alert|notification)\b/i, cmd: "notify", label: "Notification settings" },
  { match: /\b(home|menu|main|start|back)\b/i, cmd: "home", label: "Go home" },
  { match: /\b(hi|hello|hey|yo|sup|gm|good morning|what'?s up)\b/i, cmd: "_greeting", label: null },
];

// Command handlers loaded lazily
const HANDLER_MAP = {
  borrow: () => import("./borrow.js").then((m) => m.handleBorrow),
  deposit: () => import("./deposit.js").then((m) => m.handleDeposit),
  repay: () => import("./repay.js").then((m) => m.handleRepay),
  positions: () => import("./positions.js").then((m) => m.handlePositions),
  me: () => import("./me.js").then((m) => m.handleMe),
  supported: () => import("./supported.js").then((m) => m.handleSupported),
  simulate: () => import("./simulate.js").then((m) => m.handleSimulate),
  price: () => import("./price.js").then((m) => m.handlePrice),
  credit: () => import("./credit.js").then((m) => m.handleCredit),
  history: () => import("./history.js").then((m) => m.handleHistory),
  withdraw: () => import("./withdraw.js").then((m) => m.handleWithdraw),
  help: () => import("./help.js").then((m) => m.handleHelp),
  import: () => import("./import-wallet.js").then((m) => m.handleImport),
  extend: () => import("./extend.js").then((m) => m.handleExtend),
  risk: () => import("./risk.js").then((m) => m.handleRisk),
  stats: () => import("./stats.js").then((m) => m.handleStats),
  notify: () => import("./notify.js").then((m) => m.handleNotify),
  home: () => import("./home.js").then((m) => m.handleHome),
};

// Solana base58 address pattern (32-44 chars of base58 alphabet)
const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function handleFallback(ctx) {
  // Skip non-DM chats entirely — fallback is meant for 1:1 conversation
  // with the bot. In groups, the bot replying to every text message
  // would be obnoxious (and the community-moderation handler in
  // src/handlers/community-handlers.js is the right surface for group
  // behavior).
  if (ctx.chat?.type !== "private") return;
  const text = ctx.message?.text?.trim();
  if (!text) return;

  // ── Operator @MagpieLoans tweet auto-cross-post ─────────────
  // When the operator DMs the bot a tweet URL from @MagpieLoans, auto
  // cross-post it to all enabled community chats — no need to type
  // /crosspost first. Replaces the X-API-poller path for operators
  // who don't have a paid X bearer token.
  //
  // Gated on isAdmin (operator-only) so a random user pasting a
  // tweet URL doesn't trigger this.
  if (await maybeAutoCrosspostTweet(ctx, text)) return;

  // Ignore messages that start with / (those are unrecognized commands)
  if (text.startsWith("/")) {
    await ctx.reply(
      `I don't recognize that command. Try /help to see what I can do.`,
    );
    return;
  }

  // Detect if user pasted a Solana wallet address
  if (SOLANA_ADDR.test(text)) {
    const kb = new InlineKeyboard()
      .text("📋 Show my deposit wallet", "fallback:deposit")
      .row()
      .text("💰 Borrow now", "start:borrow");

    await ctx.reply(
      [
        "That looks like a Solana address\\!",
        "",
        "If you want to deposit tokens, send them to your *Magpie wallet* \\(tap below to see it\\)\\.",
        "",
        "If you\\'re trying to import an existing wallet, use:",
        "`/import <base58 private key>`",
      ].join("\n"),
      { parse_mode: "MarkdownV2", reply_markup: kb },
    );
    return;
  }

  // Check for pattern matches
  for (const pat of PATTERNS) {
    if (pat.match.test(text)) {
      // Greeting
      if (pat.cmd === "_greeting") {
        const kb = new InlineKeyboard()
          .text("💰 Borrow SOL", "start:borrow")
          .text("📋 My wallet", "fallback:deposit")
          .row()
          .text("📖 Help", "fallback:help");

        await ctx.reply(
          [
            "Hey\\! 👋 Welcome to Magpie\\.",
            "",
            "I help you borrow SOL against your memecoins\\.",
            "What would you like to do?",
          ].join("\n"),
          { parse_mode: "MarkdownV2", reply_markup: kb },
        );
        return;
      }

      // Matched a real command — run it
      if (HANDLER_MAP[pat.cmd]) {
        const handler = await HANDLER_MAP[pat.cmd]();
        await handler(ctx);
        return;
      }
    }
  }

  // No match — show helpful suggestions
  const kb = new InlineKeyboard()
    .text("💰 Borrow", "start:borrow")
    .text("📋 Wallet", "fallback:deposit")
    .text("📖 Help", "fallback:help");

  await ctx.reply(
    "I'm not sure what you mean. Here are some things I can help with:",
    { reply_markup: kb },
  );
}

export function registerFallbackCallbacks(bot) {
  bot.callbackQuery("fallback:deposit", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleDeposit } = await import("./deposit.js");
    await handleDeposit(ctx);
  });

  bot.callbackQuery("fallback:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleHelp } = await import("./help.js");
    await handleHelp(ctx);
  });
}

/**
 * Detect a @MagpieLoans tweet URL DM'd by the operator and auto
 * cross-post it to all enabled community chats. Returns true if we
 * handled it (caller should short-circuit normal fallback flow).
 *
 * Match shape: any standalone x.com/MagpieLoans/status/<id> or
 * twitter.com/MagpieLoans/status/<id> URL in the message. URL can be
 * the whole message or embedded; we extract the first match.
 *
 * Gated on isAdmin so only operators trigger this — a regular user
 * pasting a tweet URL gets normal fallback behavior.
 */
const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/MagpieLoans\/status\/\d+(?:\?[^\s]*)?/i;

async function maybeAutoCrosspostTweet(ctx, text) {
  if (!text) return false;
  const url = (text.match(TWEET_URL_RE) || [])[0];
  if (!url) return false;
  // Operator-only — don't auto-trigger for regular users
  const { isAdmin } = await import("../services/admin.js");
  if (!isAdmin(ctx.from?.id)) return false;
  try {
    const { crosspostTweet } = await import("../services/community-x-crosspost.js");
    const result = await crosspostTweet(ctx.api, url, "manual-dm");
    if (result.skipped) {
      await ctx.reply(`ℹ️ Already cross-posted this tweet (reason: ${result.reason}).`);
    } else {
      await ctx.reply(`✅ Cross-posted to ${result.chats} community chat(s).`);
    }
    return true;
  } catch (err) {
    await ctx.reply(`❌ Cross-post failed: ${err.message?.slice(0, 200)}`);
    return true; // we still handled it (with an error reply)
  }
}
