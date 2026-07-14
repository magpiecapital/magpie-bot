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

// Verbs users naturally reach for when they want to set an exit on a
// loan. None of these were registered as bot.command() pre-2026-06-16.
// Operator-mandated 2026-06-16 PM: ANY user expression of arm intent
// must be RECOGNIZED, never silently ignored
// (feedback_exit_strategy_must_always_be_recognized.md).
//
// Direction-implied verbs are routed without ambiguity. Neutral verbs
// (sell, exit, target) defer to the parsed strike's impliedDirection
// (multiplier >= 1 → TP, multiplier < 1 → SL; "-N%" → SL; "+N%" → TP).
const ARM_INTENT_VERBS = {
  // neutral — direction inferred from strike
  sell: "neutral",
  exit: "neutral",
  target: "neutral",
  goal: "neutral",
  strike: "neutral",
  trigger: "neutral",
  closeat: "neutral",
  // TP-implying
  buy: "above",
  sellat: "above",
  sellabove: "above",
  tpat: "above",
  selltop: "above",
  protectgains: "above",
  // SL-implying
  stop: "below",
  stopat: "below",
  stopabove: "below",
  stopbelow: "below",
  slat: "below",
  floor: "below",
  protect: "below",
  protectfloor: "below",
  downto: "below",
  // bracket
  tpsl: "bracket",
  protectboth: "bracket",
  bothlegs: "bracket",
};

/**
 * If the unrecognized command is arm-intent-shaped, re-dispatch to the
 * correct registered handler with the same arg shape and return true.
 * Otherwise return false so the caller can render the generic "I
 * don't recognize that command" reply.
 */
async function maybeRedirectArmIntent(ctx, text) {
  // Extract the leading /command token.
  const m = /^\/([a-z_]+)(?:@\w+)?\b/i.exec(text);
  if (!m) return false;
  const verb = m[1].toLowerCase();
  const known = ARM_INTENT_VERBS[verb];
  if (!known) return false;

  // Strip the leading /<verb>; pass the rest as "/<canonical> <rest>"
  // so the registered handler's parser sees the same args the user
  // typed. Preserves loan_id + strike + slip= etc unchanged.
  const rest = text.slice(m[0].length).trim();

  // For unambiguous direction, route directly.
  if (known === "above") {
    return await dispatchAsCommand(ctx, "takeprofit", rest);
  }
  if (known === "below") {
    return await dispatchAsCommand(ctx, "stoploss", rest);
  }
  if (known === "bracket") {
    return await dispatchAsCommand(ctx, "bracket", rest);
  }

  // Neutral verb: infer direction from the strike. Use the parser to
  // see what direction the strike implies. If parser fails, surface a
  // helpful reply asking the user to clarify.
  let parsed;
  try {
    const mod = await import("../lib/strike-price-parser.js");
    // Heuristic: find the strike portion. Common shapes:
    //   <loan_id> at <strike>
    //   <loan_id> <strike>
    //   <loan_id> at 1.3x slip=2%
    // Grab the first non-loan token after "at" (or after loan_id).
    const tokens = rest.split(/\s+/).filter(Boolean);
    // skip first token (loan id) if it's a number
    let idx = 0;
    if (/^\d+$/.test(tokens[0] || "")) idx = 1;
    // skip "at" / "sell" / "buy" filler
    while (
      tokens[idx] &&
      ["at", "sell", "buy", "to", "around", "near"].includes(tokens[idx].toLowerCase())
    )
      idx += 1;
    const strikeText = tokens.slice(idx).join(" ");
    if (strikeText) {
      parsed = mod.parseStrike(strikeText, {});
    }
  } catch (e) {
    console.warn("[fallback-arm-redirect] parseStrike failed:", e.message?.slice(0, 100));
  }

  if (parsed?.ok && parsed.impliedDirection) {
    const canonical = parsed.impliedDirection === "below" ? "stoploss" : "takeprofit";
    return await dispatchAsCommand(ctx, canonical, rest);
  }

  // Strike ambiguous — ask the user explicitly. Inline buttons let them
  // pick without re-typing the strike.
  const safeRest = rest.replace(/[`*_]/g, "");
  await ctx.reply(
    [
      `I recognize you wanted to set an exit, but I need to know which side.`,
      ``,
      `If you want to *sell ABOVE current price* (take-profit):`,
      `  /takeprofit ${safeRest}`,
      ``,
      `If you want to *sell BELOW current price* (stop-loss):`,
      `  /stoploss ${safeRest}`,
      ``,
      `Or send /preview ${safeRest} to dry-run without committing.`,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
  return true;
}

/**
 * Re-dispatch an unrecognized arm-shaped command as if the user had
 * typed the canonical command. Constructs a fresh ctx with
 * ctx.message.text rewritten so the handler's parser sees what it
 * expects, then invokes the handler directly.
 */
async function dispatchAsCommand(ctx, canonicalCmd, restArgs) {
  const newText = `/${canonicalCmd}${restArgs ? " " + restArgs : ""}`;
  // Shallow-clone the context's message so we don't mutate grammy
  // internal state mid-update. The handlers only read ctx.message.text
  // and ctx.from / ctx.chat for behavior, so a property override on
  // the message is sufficient.
  const origMessage = ctx.message;
  const newMessage = { ...origMessage, text: newText };
  Object.defineProperty(ctx, "message", {
    value: newMessage,
    configurable: true,
    writable: true,
  });

  try {
    const lc = await import("./limit-close.js");
    if (canonicalCmd === "takeprofit") return await runAndOk(lc.handleLimitClose, ctx);
    if (canonicalCmd === "stoploss") return await runAndOk(lc.handleStopLoss, ctx);
    if (canonicalCmd === "bracket") return await runAndOk(lc.handleBracket, ctx);
  } catch (e) {
    console.warn(`[fallback-arm-redirect] dispatch ${canonicalCmd} failed: ${e.message?.slice(0, 200)}`);
    return false;
  } finally {
    // Restore original message so any downstream middleware sees the
    // original text. (No middleware runs after handleFallback today,
    // but this keeps the contract clean.)
    Object.defineProperty(ctx, "message", {
      value: origMessage,
      configurable: true,
      writable: true,
    });
  }
  return false;
}

async function runAndOk(handler, ctx) {
  await handler(ctx);
  return true;
}

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

  // Smart redirect for arm-intent-shaped unknown commands
  // (operator-mandated 2026-06-16 PM,
  // feedback_exit_strategy_must_always_be_recognized.md). When the
  // user types an unrecognized command that LOOKS like they're trying
  // to set an exit ("/sell 810 at 1.3x", "/buy 810 at $0.005",
  // "/target 810 at $150m"), parse the strike, infer direction from
  // it, and re-dispatch to the correct registered handler with the
  // bot.command argv shape. NEVER silently ignore an arm-shaped
  // message.
  if (text.startsWith("/")) {
    const armRedirect = await maybeRedirectArmIntent(ctx, text);
    if (armRedirect) return;
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

  // ── Reply capture ──────────────────────────────────────────────
  // A plain conversational message that matched no command is almost always a
  // REAL reply — feedback, a question, a response to an outreach/winback DM.
  // Historically this hit a canned "I'm not sure what you mean" and was LOST.
  // Now: forward it to the operator(s) so a human actually sees it and can
  // respond, and acknowledge the user warmly instead of robotically.
  try {
    const ops = (process.env.OPERATOR_TG_IDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (ops.length) {
      const u = ctx.from || {};
      const who = u.username ? "@" + u.username : (u.first_name || "user");
      const back = u.username ? "@" + u.username : `tg://user?id=${u.id}`;
      const note = `💬 User reply — ${who} (id ${u.id})\n\n"${text}"\n\n↳ reply to them: ${back}`;
      for (const op of ops) {
        try { await ctx.api.sendMessage(op, note); } catch { /* best-effort per operator */ }
      }
    }
    console.log(`[reply-capture] from ${ctx.from?.id} (@${ctx.from?.username || "?"}): ${text.slice(0, 200)}`);
  } catch { /* capture must never break the user's reply */ }

  const kb = new InlineKeyboard()
    .text("💰 Borrow", "start:borrow")
    .text("📋 Wallet", "fallback:deposit")
    .text("📖 Help", "fallback:help");

  await ctx.reply(
    "Got it — thanks for the message. A human on the Magpie team sees this and will follow up. In the meantime, here's what I can help with right now:",
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
