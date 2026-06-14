import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getSupportedBalances, getSolBalance } from "../services/deposits.js";
import { collateralValueLamports } from "../services/price.js";
import { executeBorrow, recordLoan } from "../services/loans.js";
import { attestPrice, initializePriceFeed, getPriceFeedAgeSeconds } from "../services/price-attestor.js";
import { isBorrowingPaused } from "../services/admin.js";
import { incrementBorrowed } from "../services/reputation.js";
import { checkLoanLimits } from "../services/loan-limits.js";
import { translateTxError, errorActionKeyboard } from "../services/tx-error-translator.js";
import { renderRiskBlock } from "../services/token-risk-preview.js";
import { preBorrowBanCheck } from "../services/bans.js";
import { preBorrowAntiExploitCheck } from "../services/anti-exploit.js";
import { armOrder, resolveMultiplierToPrice } from "../services/limit-close-arm-core.js";
import { parseStrike } from "../lib/strike-price-parser.js";

// Tier schedule is category-aware as of 2026-06-12 migration 040.
// Memecoins use the legacy 30/25/20 LTV ladder; RWA collateral
// (stock/etf/metal) uses the higher-LTV / longer-term / higher-fee
// schedule seeded into rwa_loan_tiers. See ../services/loan-tier-resolver.js.
//
// LTV_TIERS kept here as a synchronous fallback for the rare path that
// can't await (currently none); resolver returns an equivalent set for
// memecoin category, so both paths agree on the memecoin numbers.
import { getEligibleTiers, getTierByOption, MEMECOIN_TIERS as LTV_TIERS } from "../services/loan-tier-resolver.js";

// In-memory pending state per Telegram chat; fine for MVP, move to DB for prod.
const pending = new Map();

// Pre-borrow ladder presets. Slice values in basis points sum to 10000 per preset.
// Multipliers are anchors off the borrow-time spot price; resolveMultiplierToPrice
// converts each to a triggerValueMicro at arm time so legs share a price basis.
const LADDER_PRESETS = {
  tp: {
    conservative: {
      label: "Conservative — 1.5x / 2x / 3x",
      legs: [
        { multiplier: 1.5, sliceBps: 7000 },
        { multiplier: 2.0, sliceBps: 2000 },
        { multiplier: 3.0, sliceBps: 1000 },
      ],
    },
    balanced: {
      label: "Balanced — 1.5x / 2.5x / 4x",
      legs: [
        { multiplier: 1.5, sliceBps: 5000 },
        { multiplier: 2.5, sliceBps: 3000 },
        { multiplier: 4.0, sliceBps: 2000 },
      ],
    },
    aggressive: {
      label: "Aggressive — 2x / 3x / 5x / 10x / 20x",
      legs: [
        { multiplier: 2.0, sliceBps: 3000 },
        { multiplier: 3.0, sliceBps: 3000 },
        { multiplier: 5.0, sliceBps: 2000 },
        { multiplier: 10.0, sliceBps: 1000 },
        { multiplier: 20.0, sliceBps: 1000 },
      ],
    },
  },
  sl: {
    conservative: {
      label: "Conservative — 0.85x / 0.7x / 0.5x",
      legs: [
        { multiplier: 0.85, sliceBps: 3000 },
        { multiplier: 0.70, sliceBps: 4000 },
        { multiplier: 0.50, sliceBps: 3000 },
      ],
    },
    balanced: {
      label: "Balanced — 0.8x / 0.65x / 0.5x",
      legs: [
        { multiplier: 0.80, sliceBps: 5000 },
        { multiplier: 0.65, sliceBps: 3000 },
        { multiplier: 0.50, sliceBps: 2000 },
      ],
    },
    aggressive: {
      label: "Aggressive — 0.9x / 0.75x / 0.6x",
      legs: [
        { multiplier: 0.90, sliceBps: 7000 },
        { multiplier: 0.75, sliceBps: 2000 },
        { multiplier: 0.60, sliceBps: 1000 },
      ],
    },
  },
};

/**
 * Clear any in-progress borrow state for a chat. Used by sibling commands
 * (e.g. /import) to defensively reset a stuck flow before starting their
 * own message:text interception, so the user's paste can't get hijacked
 * by leftover borrow state.
 */
export function clearPending(chatId) {
  pending.delete(chatId);
}

const QUOTE_TTL_MS = 60_000; // 60-second quote expiry
const MAX_SLIPPAGE_PCT = 2; // reject if price moved >2% since quote

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

// Arms the user's pre-selected exits immediately after a successful loan
// record. Always returns an array of leg-level outcomes so the funded-loan
// card can show exactly which legs landed and which need a manual retry.
// Errors on individual legs are non-fatal — they surface as failed legs
// rather than aborting the whole flow.
async function armConfiguredExits({ userId, loanIdChain, collateralMint, exits }) {
  if (!exits || exits.type === "skip") return [];

  const armSingle = async ({ label, direction, multiplier, parsedStrike, sliceBps }) => {
    let triggerKind, triggerValueMicro;
    if (parsedStrike) {
      triggerKind = parsedStrike.kind;
      triggerValueMicro = parsedStrike.valueMicro.toString();
    } else {
      const resolved = await resolveMultiplierToPrice(
        collateralMint,
        multiplier,
        { allowBelowOne: direction === "below" },
      );
      if (!resolved.ok) return { ok: false, label, error: resolved.error || "resolve_failed" };
      triggerKind = "price_usd";
      triggerValueMicro = resolved.triggerValueMicro.toString();
    }
    const slippageBps = direction === "below" ? 300 : 200;
    const armed = await armOrder({
      userId,
      source: "tg",
      loanIdChain,
      triggerKind,
      triggerValueMicro,
      triggerDirection: direction,
      slippageBps,
      sellDestination: "sol",
      slicePct: sliceBps && sliceBps < 10000 ? sliceBps : undefined,
    });
    return armed.ok
      ? { ok: true, label, orderId: armed.orderId }
      : { ok: false, label, error: armed.error };
  };

  switch (exits.type) {
    case "tp_default":
      return [await armSingle({ label: "TP @ 2x", direction: "above", multiplier: 2 })];
    case "sl_default":
      return [await armSingle({ label: "SL @ 0.7x", direction: "below", multiplier: 0.7 })];
    case "bracket": {
      const tp = await armSingle({ label: "TP @ 2x", direction: "above", multiplier: 2 });
      // Only attempt SL if TP succeeded — otherwise user gets confusing
      // half-bracket. The TP-only case still leaves the post-borrow SL
      // button tappable.
      if (!tp.ok) return [tp];
      const sl = await armSingle({ label: "SL @ 0.7x", direction: "below", multiplier: 0.7 });
      return [tp, sl];
    }
    case "custom_tp":
      return [await armSingle({
        label: `TP @ ${exits.parsedStrike.normalizedDisplay}`,
        direction: "above",
        parsedStrike: exits.parsedStrike,
      })];
    case "custom_sl":
      return [await armSingle({
        label: `SL @ ${exits.parsedStrike.normalizedDisplay}`,
        direction: "below",
        parsedStrike: exits.parsedStrike,
      })];
    case "tp_ladder":
    case "sl_ladder": {
      const direction = exits.type === "tp_ladder" ? "above" : "below";
      const sidePrefix = direction === "above" ? "TP" : "SL";
      const results = [];
      for (const leg of exits.preset.legs) {
        const r = await armSingle({
          label: `${sidePrefix} ${leg.multiplier}x (${(leg.sliceBps / 100).toFixed(0)}%)`,
          direction,
          multiplier: leg.multiplier,
          sliceBps: leg.sliceBps,
        });
        results.push(r);
        // Stop the cascade on a hard failure to avoid partial-ladder
        // confusion; user can retry the remaining legs manually.
        if (!r.ok) break;
      }
      return results;
    }
    default:
      return [];
  }
}

function renderExitsSummary(armResults) {
  if (!armResults || armResults.length === 0) return null;
  const lines = armResults.map((r) =>
    r.ok
      ? `• ${r.label} — armed #${r.orderId}`
      : `• ${r.label} — failed (${r.error || "unknown"})`,
  );
  return ["*Exits:*", ...lines].join("\n");
}

function isQuoteExpired(state) {
  if (!state?.quotedAt) return true;
  return Date.now() - state.quotedAt > QUOTE_TTL_MS;
}

// Clean up stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [chatId, state] of pending) {
    if (state.quotedAt && now - state.quotedAt > QUOTE_TTL_MS * 5) {
      pending.delete(chatId);
    }
  }
}, 5 * 60_000);

export async function handleBorrow(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  if (isBorrowingPaused()) {
    return ctx.reply("⏸ Borrowing is temporarily paused. Try again shortly.");
  }

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  let balances, sol;
  try {
    [balances, sol] = await Promise.all([
      getSupportedBalances(publicKey),
      getSolBalance(publicKey),
    ]);
  } catch (err) {
    console.error("[borrow] RPC error:", err.message);
    return ctx.reply("⚠️ Couldn't fetch your balances right now. Please try again in a moment.");
  }

  if (sol < 5_000_000) {
    await ctx.reply(
      `⚠️ You need at least ~0.005 SOL in your Magpie wallet to cover transaction fees.\n\nDeposit SOL to:\n\`${publicKey}\``,
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (balances.length === 0) {
    await ctx.reply(
      `📭 No supported collateral detected.\n\nDeposit a supported memecoin to:\n\`${publicKey}\``,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Cache balances so token selection doesn't need another RPC call.
  pending.set(ctx.chat.id, { userId: user.id, balances });

  const kb = new InlineKeyboard();
  for (const b of balances) {
    kb.text(`${b.symbol} (${b.humanAmount.toLocaleString()})`, `borrow:mint:${b.mint}`).row();
  }
  kb.text("✕ Cancel", "borrow:cancel");

  await ctx.reply("*Select collateral:*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

export function registerBorrowCallbacks(bot) {
  bot.callbackQuery(/^borrow:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Borrow cancelled.");
  });

  bot.callbackQuery(/^borrow:mint:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    const user = await upsertUser(ctx.from.id, ctx.from.username);

    // Use cached balances from /borrow if available, otherwise re-fetch.
    const cached = pending.get(ctx.chat.id);
    let selected;
    if (cached?.balances) {
      selected = cached.balances.find((b) => b.mint === mint);
    }
    if (!selected) {
      const { publicKey } = await ensureWallet(user.id);
      const balances = await getSupportedBalances(publicKey);
      selected = balances.find((b) => b.mint === mint);
    }

    if (!selected) {
      await ctx.answerCallbackQuery("Balance no longer available");
      return;
    }

    pending.set(ctx.chat.id, { userId: user.id, selected, stage: "amount" });

    const kb = new InlineKeyboard()
      .text("25%", "borrow:pct:25").text("50%", "borrow:pct:50")
      .text("75%", "borrow:pct:75").text("100%", "borrow:pct:100")
      .row()
      .text("✏️ Custom %", "borrow:custom")
      .row().text("✕ Cancel", "borrow:cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Selected: *${selected.symbol}*\nBalance: ${selected.humanAmount.toLocaleString()}\n\n*How much to use as collateral?*\nPick a preset or enter a custom amount.`,
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery("borrow:custom", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired, run /borrow again");
      return;
    }
    state.stage = "await_custom";
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Selected: *${state.selected.symbol}*`,
        `Balance: ${state.selected.humanAmount.toLocaleString()}`,
        "",
        `Type the *%* of your ${state.selected.symbol} balance to use as collateral.`,
        `e.g. \`42\` for 42% or \`82.5\` for 82.5%`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // Middleware to catch custom strike input for the pre-borrow exits step.
  // Parses the free-text trigger via the shared strike parser and proceeds
  // directly to executeBorrowWithExits with the parsed result stamped into
  // state.exits.
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state) return next();
    if (state.stage !== "await_custom_tp_input" && state.stage !== "await_custom_sl_input") {
      return next();
    }
    const isTp = state.stage === "await_custom_tp_input";
    // If the user typed a bare number with no kind, treat it as a
    // multiplier — that's the most common borrow-time intent ("5" → 5x).
    // The parser only handles multipliers explicitly (e.g. "2x"), so we
    // append "x" client-side when the raw input is just digits.
    const raw = ctx.message.text.trim();
    const normalized = /^[\d]+(\.\d+)?$/.test(raw) ? `${raw}x` : raw;
    const parsed = parseStrike(normalized, {
      directionHint: isTp ? "above" : "below",
    });
    if (!parsed.ok) {
      return ctx.reply(
        `Couldn't read that strike: ${parsed.error || "unknown"}. Try \`5x\`, \`$0.02\`, or \`30m mc\`.`,
        { parse_mode: "Markdown" },
      );
    }
    // Sanity: TP must be above 1x territory, SL must be below.
    if (parsed.impliedDirection && parsed.impliedDirection !== (isTp ? "above" : "below")) {
      return ctx.reply(
        isTp
          ? "That looks like a stop-loss target. For TP, use a multiplier above 1× (e.g. `2x`) or a price above current."
          : "That looks like a take-profit target. For SL, use a multiplier below 1× (e.g. `0.7x`) or a price below current.",
        { parse_mode: "Markdown" },
      );
    }
    state.exits = { type: isTp ? "custom_tp" : "custom_sl", parsedStrike: parsed };
    state.stage = "executing";
    pending.set(ctx.chat.id, state);
    await executeBorrowWithExits(ctx, state);
  });

  // Middleware to catch custom percentage input.
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || state.stage !== "await_custom") return next();

    // Accept "42", "42%", "42.5", "42.5%" — strip any % sign + commas.
    const input = ctx.message.text.trim().replace(/,/g, "").replace(/%$/, "").trim();
    const pct = Number(input);

    if (!Number.isFinite(pct) || pct <= 0) {
      return ctx.reply("Please enter a positive percentage (e.g. `42`).", { parse_mode: "Markdown" });
    }
    if (pct > 100) {
      return ctx.reply(
        "Can't pledge more than 100% of your balance. Try a smaller %.",
      );
    }

    // BigInt-safe math: matches the quick-button math when pct is a
    // whole number (rawAmount * pct / 100) but supports fractional %s.
    const bps = BigInt(Math.round(pct * 100));
    const rawBig = (BigInt(state.selected.rawAmount) * bps) / 10_000n;
    if (rawBig === 0n) {
      return ctx.reply("That % rounds to zero at the token's decimals — try a larger %.");
    }
    // Human form for display + downstream math (preserves prior shape).
    const decimals = state.selected.decimals;
    const amount = Number(rawBig) / Math.pow(10, decimals);
    state.collateralRaw = rawBig;
    state.humanAmount = amount;
    delete state.stage;
    pending.set(ctx.chat.id, state);

    // Fetch value and show tier selection.
    let valueLamports;
    try {
      valueLamports = await collateralValueLamports(
        state.selected.mint,
        rawBig,
        state.selected.decimals,
      );
    } catch (err) {
      console.error("[borrow] price fetch error:", err.message);
      pending.delete(ctx.chat.id);
      return ctx.reply("⚠️ Couldn't fetch price right now. Run /borrow to try again.");
    }

    state.collateralValueLamports = valueLamports;
    state.quotedAt = Date.now();
    pending.set(ctx.chat.id, state);

    // Resolve tier schedule based on the selected mint's category.
    // RWA collateral (stock/etf/metal) lands the higher-LTV ladder
    // out of rwa_loan_tiers; memecoin (and uncategorized) get MEMECOIN_TIERS.
    const tiers = await getEligibleTiers({ category: state.selected.category });
    // Telegram inline-button labels visually truncate around 30-40 chars
    // on mobile — RWA tiers' full label "50% LTV · 7d · 2.5% fee
    // (RWA Express) → ~1.2345 SOL" cut off the receive amount to
    // "→ ~..." in the UI (operator screenshot 2026-06-13). Render the
    // full breakdown in the message body (Markdown, no length limit)
    // and keep buttons short.
    const kb = new InlineKeyboard();
    const tierLines = tiers.map((t) => {
      const loanSol = ((valueLamports * t.ltv) / 100) / 1e9;
      const fee = loanSol * (t.feeBps / 10_000);
      const receive = loanSol - fee;
      const shortMatch = t.label.match(/\(([^)]+)\)\s*$/);
      const shortName = shortMatch ? shortMatch[1] : t.label;
      kb.text(
        `${shortName} — ${receive.toFixed(4)} SOL`,
        `borrow:tier:${t.option}`,
      ).row();
      return `• *${shortName}* — ${t.ltv}% LTV · ${t.days}d · ${(t.feeBps / 100).toFixed(1)}% fee → *${receive.toFixed(4)} SOL*`;
    });
    kb.text("✕ Cancel", "borrow:cancel");

    const riskBlock = await renderRiskBlock(state.selected.symbol).catch(() => "");
    await ctx.reply(
      [
        `*Collateral:* ${amount.toLocaleString()} ${state.selected.symbol}`,
        `*Value:* ${fmtSol(valueLamports)} SOL`,
        riskBlock ? "" : null,
        riskBlock || null,
        "",
        "*Choose a loan tier:*",
        ...tierLines,
        "",
        "_Amount shown is what you receive after the tier fee._",
        "⏱ _This quote expires in 60 seconds._",
      ].filter((l) => l != null).join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^borrow:pct:(\d+)$/, async (ctx) => {
    const pct = Number(ctx.match[1]);
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired, run /borrow again");
      return;
    }

    const rawBig = (BigInt(state.selected.rawAmount) * BigInt(pct)) / 100n;
    state.collateralRaw = rawBig;
    state.humanAmount = state.selected.humanAmount * (pct / 100);
    pending.set(ctx.chat.id, state);

    // Fetch value in lamports for each LTV tier and timestamp the quote.
    let valueLamports;
    try {
      valueLamports = await collateralValueLamports(
        state.selected.mint,
        rawBig,
        state.selected.decimals,
      );
    } catch (err) {
      console.error("[borrow] price fetch error (pct):", err.message);
      pending.delete(ctx.chat.id);
      return ctx.reply("⚠️ Couldn't fetch price right now. Run /borrow to try again.");
    }
    state.collateralValueLamports = valueLamports;
    state.quotedAt = Date.now();
    pending.set(ctx.chat.id, state);

    // Same category-aware tier resolution as the prior flow.
    // See note above on tier-label truncation on mobile — render the
    // breakdown in the message body and keep button labels short.
    const tiers = await getEligibleTiers({ category: state.selected.category });
    const kb = new InlineKeyboard();
    const tierLines = tiers.map((t) => {
      const loanSol = ((valueLamports * t.ltv) / 100) / 1e9;
      const fee = loanSol * (t.feeBps / 10_000);
      const receive = loanSol - fee;
      const shortMatch = t.label.match(/\(([^)]+)\)\s*$/);
      const shortName = shortMatch ? shortMatch[1] : t.label;
      kb.text(
        `${shortName} — ${receive.toFixed(4)} SOL`,
        `borrow:tier:${t.option}`,
      ).row();
      return `• *${shortName}* — ${t.ltv}% LTV · ${t.days}d · ${(t.feeBps / 100).toFixed(1)}% fee → *${receive.toFixed(4)} SOL*`;
    });
    kb.text("✕ Cancel", "borrow:cancel");

    const riskBlock = await renderRiskBlock(state.selected.symbol).catch(() => "");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `*Collateral:* ${state.humanAmount.toLocaleString()} ${state.selected.symbol}`,
        `*Value:* ${fmtSol(valueLamports)} SOL`,
        riskBlock ? "" : null,
        riskBlock || null,
        "",
        "*Choose a loan tier:*",
        ...tierLines,
        "",
        "_Amount shown is what you receive after the tier fee._",
        "⏱ _This quote expires in 60 seconds._",
      ].filter((l) => l != null).join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  // Renders the exits picker AFTER a tier is selected. User can pre-arm
  // TP / SL / Bracket / Custom strike / Ladder before the loan executes —
  // exits land in the same transaction window as the borrow so the user
  // walks out with both the loan and the strategy in one wizard.
  async function showExitsMenu(ctx, state) {
    state.stage = "await_exits";
    pending.set(ctx.chat.id, state);
    const symbol = state.selected.symbol;
    // Plain-language button labels. We keep the TP / SL acronyms inside
    // the parentheses so power users still see the familiar shorthand,
    // but the lead verb makes the action obvious to a first-time user.
    const kb = new InlineKeyboard()
      .text("Sell at 2x (take profit)", "borrow:exits:tp").row()
      .text("Sell at 0.7x (stop loss)", "borrow:exits:sl").row()
      .text("Both — protect up & down", "borrow:exits:bracket").row()
      .text("Custom profit target", "borrow:exits:custom_tp")
      .text("Custom loss limit", "borrow:exits:custom_sl").row()
      .text("Profit ladder (stages up)", "borrow:exits:ladder_tp").row()
      .text("Loss ladder (stages down)", "borrow:exits:ladder_sl").row()
      .text("Skip — set later", "borrow:exits:skip").row()
      .text("← Change tier", "borrow:exits:retier").text("✕ Cancel", "borrow:cancel");
    await ctx.editMessageText(
      [
        `*Set your auto-sell plan for ${symbol}*`,
        "",
        "Pick a plan now and we'll auto-sell your collateral the moment your target hits — no need to babysit the chart or come back later.",
        "",
        "• *Sell at 2x* — auto-sell if price *doubles* (locks in gains). Also called \"take profit\" or _TP_.",
        "• *Sell at 0.7x* — auto-sell if price drops *30%* (limits losses). Also called \"stop loss\" or _SL_.",
        "• *Both* — set both an upside and a downside trigger. Whichever hits first wins.",
        "• *Custom* — type your own target (e.g. `5x`, `$0.02`, `30m mc`, `-30%`).",
        "• *Ladder* — sell in stages at multiple targets instead of all at once.",
        "• *Skip* — borrow only; you can set sells later with /takeprofit or /stoploss.",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  }

  // Shared execution helper: runs all the safety checks (quote expiry,
  // slippage, limits, ban, anti-exploit, price-feed attest), submits the
  // borrow on-chain, records it, and auto-arms whatever exits the user
  // pre-selected before rendering the funded-loan card.
  async function executeBorrowWithExits(ctx, state) {
    const tier = state.tier;
    const option = state.tierOption;

    // Status renderer that handles both callback contexts (edit the
    // existing message) and text-handler contexts (no callback message
    // to edit — reply once, then edit that reply by id thereafter).
    const isCallbackCtx = !!ctx.callbackQuery;
    let statusMsgId = null;
    const say = async (text, opts = {}) => {
      if (isCallbackCtx) {
        return ctx.editMessageText(text, opts);
      }
      if (statusMsgId) {
        return ctx.api.editMessageText(ctx.chat.id, statusMsgId, text, opts);
      }
      const sent = await ctx.reply(text, opts);
      statusMsgId = sent.message_id;
      return sent;
    };

    // ── Quote expiry check ──
    if (isQuoteExpired(state)) {
      pending.delete(ctx.chat.id);
      await say(
        "⏱ *Quote expired* — prices may have changed.\n\nRun /borrow to get a fresh quote.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    // ── Price slippage guard — re-fetch and compare ──
    await say("⏳ Verifying price...");

    let currentValueLamports;
    try {
      currentValueLamports = await collateralValueLamports(
        state.selected.mint,
        state.collateralRaw,
        state.selected.decimals,
      );
    } catch (err) {
      console.error("Price re-fetch failed:", err);
      pending.delete(ctx.chat.id);
      await say(
        "❌ Could not verify current price. Run /borrow to try again.",
      );
      return;
    }

    const quotedValue = state.collateralValueLamports;
    const priceDrift = Math.abs(currentValueLamports - quotedValue) / quotedValue * 100;

    if (priceDrift > MAX_SLIPPAGE_PCT) {
      pending.delete(ctx.chat.id);
      const direction = currentValueLamports < quotedValue ? "dropped" : "increased";
      await say(
        [
          `⚠️ *Price moved ${priceDrift.toFixed(1)}%* since your quote (${direction}).`,
          "",
          `Quoted value: ${fmtSol(quotedValue)} SOL`,
          `Current value: ${fmtSol(currentValueLamports)} SOL`,
          "",
          "Run /borrow to get a fresh quote at the current price.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
      return;
    }

    // Use the freshest price for the actual loan execution
    state.collateralValueLamports = currentValueLamports;

    // ── Loan limit check ──
    const loanAmountCheck = Math.floor((currentValueLamports * tier.ltv) / 100);
    const limitCheck = await checkLoanLimits(state.userId, loanAmountCheck);
    if (!limitCheck.allowed) {
      pending.delete(ctx.chat.id);
      await say(
        `⚠️ *Loan limit reached*\n\n${limitCheck.reason}\n\nTier: *${limitCheck.tier}*\nRun /borrow to try a smaller amount.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // ── Ban registry check ──
    // Operator-controlled deny-list. Applied AFTER loan-limits so the
    // generic "limit reached" message is shown for normal cases, but
    // we still refuse the actual loan open for known-bad actors.
    const banResult = await preBorrowBanCheck({
      userId: state.userId,
      telegramId: ctx.from?.id,
    });
    if (banResult?.blocked) {
      pending.delete(ctx.chat.id);
      await say(
        "⚠️ This account is restricted from opening new loans.\n\nIf you believe this is a mistake, contact support.",
      );
      return;
    }

    // ── Anti-exploit parametric defenses ──
    // Live liquidity floor + rapid-fire cap + new-account cap + pool-pct cap.
    // Built in direct response to the $FATHER oracle-manipulation attack
    // (2026-06-07). All thresholds env-tunable; check fails open on errors.
    const { publicKey: borrowerWallet } = await ensureWallet(state.userId);
    const exploitCheck = await preBorrowAntiExploitCheck({
      userId: state.userId,
      collateralMint: state.selected.mint,
      proposedLoanLamports: loanAmountCheck,
      walletPubkey: borrowerWallet,
    });
    if (exploitCheck?.blocked) {
      pending.delete(ctx.chat.id);
      await say(`⚠️ *Borrow refused*\n\n${exploitCheck.message}`, {
        parse_mode: "Markdown",
      });
      return;
    }

    await say("⏳ Submitting on-chain...");

    // Just-in-time price feed refresh — but only if the on-chain feed is
    // actually stale. Contract requires <120s; we use a 60s threshold to
    // leave headroom for the borrow tx to land before the contract clock
    // rejects it. Most repeat-borrows skip the attestation entirely.
    const FRESH_THRESHOLD_SEC = 60;
    const feedAge = await getPriceFeedAgeSeconds(state.selected.mint);
    const needsAttest = feedAge === null || feedAge > FRESH_THRESHOLD_SEC;

    if (needsAttest) {
      try {
        await attestPrice(state.selected.mint, state.selected.decimals);
      } catch (attestErr) {
        if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(attestErr.message)) {
          try {
            await initializePriceFeed(state.selected.mint);
            await attestPrice(state.selected.mint, state.selected.decimals);
          } catch (initErr) {
            pending.delete(ctx.chat.id);
            await say(
              `⚠️ Couldn't refresh on-chain price for ${state.selected.symbol}: ${initErr.message}\n\nTry /borrow again in a minute.`,
            );
            return;
          }
        } else if (/not confirmed in \d+|timed out|TransactionExpired/i.test(attestErr.message)) {
          // Solana congestion ate the attestation tx. Re-check the feed
          // age — if a previous attest got close enough to land, we may
          // already be within the contract's 120s window.
          const recheckAge = await getPriceFeedAgeSeconds(state.selected.mint);
          if (recheckAge !== null && recheckAge < 110) {
            // Close enough — proceed with the borrow anyway.
          } else {
            pending.delete(ctx.chat.id);
            await say(
              `⚠️ Solana network is congested right now and our price refresh tx didn't confirm.\n\nGive it a minute and try /borrow again — it usually clears quickly.`,
            );
            return;
          }
        } else {
          pending.delete(ctx.chat.id);
          await say(
            `⚠️ Couldn't refresh on-chain price for ${state.selected.symbol}: ${attestErr.message}\n\nTry /borrow again in a minute.`,
          );
          return;
        }
      }
    }

    try {
      const result = await executeBorrow({
        userId: state.userId,
        collateralMint: state.selected.mint,
        collateralAmountRaw: state.collateralRaw,
        collateralValueLamports: currentValueLamports,
        loanOption: option,
      });

      const loanAmountPreFee = Math.floor((currentValueLamports * tier.ltv) / 100);
      const fee = Math.floor((loanAmountPreFee * tier.feeBps) / 10_000);
      const loanAmountAfterFee = loanAmountPreFee - fee;

      await recordLoan({
        userId: state.userId,
        loanId: result.loanId,
        loanPda: result.loanPda,
        collateralMint: state.selected.mint,
        collateralAmount: state.collateralRaw.toString(),
        loanAmountLamports: loanAmountAfterFee.toString(),
        originalLoanAmountLamports: loanAmountPreFee.toString(),
        ltvPercentage: tier.ltv,
        durationDays: tier.days,
        txSignature: result.signature,
        programId: result.programId,
        borrowerWallet,
      });
      await incrementBorrowed(state.userId, loanAmountPreFee);

      // Auto-arm pre-selected exits BEFORE rendering the card so the
      // user sees confirmation in the same message. Failures are
      // surfaced per-leg without aborting the borrow.
      const exitArmResults = await armConfiguredExits({
        userId: state.userId,
        loanIdChain: result.loanId,
        collateralMint: state.selected.mint,
        exits: state.exits,
      }).catch((err) => {
        console.warn("[borrow] armConfiguredExits threw:", err.message);
        return [{ ok: false, label: "Auto-arm", error: "internal_error" }];
      });
      const exitsSummary = renderExitsSummary(exitArmResults);
      const allLegsArmed = exitArmResults.length > 0 && exitArmResults.every((r) => r.ok);

      pending.delete(ctx.chat.id);

      // Build inline keyboard. Hide the one-tap TP/SL/Bracket row if
      // every pre-selected exit already armed — otherwise leave it so
      // the user can add or retry protection.
      let kb = new InlineKeyboard();
      if (!allLegsArmed) {
        kb = kb
          .text("Sell at 2x (lock profit)", `borrow:protect:tp:${result.loanId}`).row()
          .text("Sell at 0.7x (cap loss)", `borrow:protect:sl:${result.loanId}`).row()
          .text("Both — protect both sides", `borrow:protect:bracket:${result.loanId}`)
          .row();
      }
      try {
        const { getOrCreateCode } = await import("../services/referrals.js");
        const { shareBorrow } = await import("../services/share-moments.js");
        const code = await getOrCreateCode(state.userId);
        const card = shareBorrow({
          symbol: state.selected.symbol,
          receiveLamports: loanAmountAfterFee,
          ltvPct: tier.ltv,
          durationDays: tier.days,
          referralCode: code,
        });
        kb = kb
          .url("𝕏 Share to Twitter", card.twitterUrl)
          .url("📨 Tell a friend", card.telegramShareUrl);
      } catch { /* share row non-critical */ }

      await say(
        [
          "✅ *Loan funded*",
          "",
          `Received: *${fmtSol(loanAmountAfterFee)} SOL*`,
          `Repay by due date: *${fmtSol(loanAmountPreFee)} SOL*`,
          `Term: ${tier.days} days at ${tier.ltv}% LTV`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
          exitsSummary ? "" : null,
          exitsSummary,
          "",
          // If exits already armed, skip the "protect this loan?" pitch.
          allLegsArmed
            ? "/positions to check status · /limitorders to manage auto-sells"
            : "*Want to set an auto-sell?* Tap a button above, or type:",
          allLegsArmed
            ? null
            : `\`/takeprofit ${result.loanId} at 2x\` (sell when up 2x)`,
          allLegsArmed
            ? null
            : `\`/stoploss ${result.loanId} at 0.7x\` (sell if down 30%)`,
          allLegsArmed ? null : "",
          allLegsArmed ? null : "/positions to check status · /share to flex on the timeline",
        ].filter((l) => l != null).join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: kb },
      );
    } catch (err) {
      console.error("Borrow failed:", err);
      const friendly = translateTxError(err, { flow: "borrow" });
      await say(friendly, {
        parse_mode: "Markdown",
        reply_markup: errorActionKeyboard({ flow: "borrow", errorKind: "tx_error" }),
      });
    }
  }

  // ── New tier callback — stores selection, opens the exits picker ──
  bot.callbackQuery(/^borrow:tier:(\d+)$/, async (ctx) => {
    const option = Number(ctx.match[1]);
    const state = pending.get(ctx.chat.id);
    const tier = await getTierByOption({ category: state?.selected?.category, option });
    if (!state || !tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    if (isQuoteExpired(state)) {
      pending.delete(ctx.chat.id);
      await ctx.answerCallbackQuery("Quote expired");
      await ctx.editMessageText(
        "⏱ *Quote expired* — prices may have changed.\n\nRun /borrow to get a fresh quote.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    state.tier = tier;
    state.tierOption = option;
    await ctx.answerCallbackQuery();
    await showExitsMenu(ctx, state);
  });

  // ── Exits picker callbacks ─────────────────────────────────────
  // One-tap presets and skip route straight to execution. Custom
  // strike and ladder routes the user through a sub-step first.
  const oneTapExits = {
    tp: { type: "tp_default" },
    sl: { type: "sl_default" },
    bracket: { type: "bracket" },
    skip: { type: "skip" },
  };
  bot.callbackQuery(/^borrow:exits:(tp|sl|bracket|skip)$/, async (ctx) => {
    const choice = ctx.match[1];
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    state.exits = oneTapExits[choice];
    await ctx.answerCallbackQuery();
    await executeBorrowWithExits(ctx, state);
  });

  bot.callbackQuery(/^borrow:exits:(custom_tp|custom_sl)$/, async (ctx) => {
    const kind = ctx.match[1];
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    state.stage = kind === "custom_tp" ? "await_custom_tp_input" : "await_custom_sl_input";
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    const headline = kind === "custom_tp"
      ? `*Auto-sell when price goes UP — ${state.selected.symbol}*`
      : `*Auto-sell when price drops DOWN — ${state.selected.symbol}*`;
    await ctx.editMessageText(
      [
        headline,
        "",
        "Type the price you want us to sell at. We accept these formats:",
        "• `5x` — when price is 5× current",
        "• `$0.02` — exact dollar price",
        "• `30m mc` — when token's market cap hits 30 million",
        "• `0.0025 sol` — exact SOL price",
        kind === "custom_sl"
          ? "• `0.7x` or `-30%` — when price drops to 70% (i.e. 30% off)"
          : "• `+50%` — when price is up 50%",
        "",
        "Or tap *Back* to pick a different option.",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("← Back", "borrow:exits:back"),
      },
    );
  });

  bot.callbackQuery(/^borrow:exits:(ladder_tp|ladder_sl)$/, async (ctx) => {
    const kind = ctx.match[1]; // ladder_tp | ladder_sl
    const side = kind === "ladder_tp" ? "tp" : "sl";
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    const presets = LADDER_PRESETS[side];
    const kb = new InlineKeyboard()
      .text(presets.conservative.label, `borrow:exits:${kind}:conservative`).row()
      .text(presets.balanced.label, `borrow:exits:${kind}:balanced`).row()
      .text(presets.aggressive.label, `borrow:exits:${kind}:aggressive`).row()
      .text("← Back", "borrow:exits:back");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `*${side === "tp" ? "Profit ladder (sell on the way UP)" : "Loss-defense ladder (sell on the way DOWN)"} — ${state.selected.symbol}*`,
        "",
        side === "tp"
          ? "Sell your collateral in stages as the price climbs, instead of all at one target. You'll lock in some gains early and let some ride higher."
          : "Sell your collateral in stages as the price drops, instead of all at one stop. You'll protect some capital early while leaving room for a recovery.",
        "",
        "_Heads up: each step is a separate sell + re-borrow, so 3 steps cost ~3× the loan fee of a single exit._",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^borrow:exits:(ladder_tp|ladder_sl):(conservative|balanced|aggressive)$/, async (ctx) => {
    const kind = ctx.match[1];
    const presetName = ctx.match[2];
    const side = kind === "ladder_tp" ? "tp" : "sl";
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    state.exits = {
      type: side === "tp" ? "tp_ladder" : "sl_ladder",
      preset: LADDER_PRESETS[side][presetName],
    };
    await ctx.answerCallbackQuery();
    await executeBorrowWithExits(ctx, state);
  });

  bot.callbackQuery("borrow:exits:back", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    await ctx.answerCallbackQuery();
    await showExitsMenu(ctx, state);
  });

  // Lets user back up from the exits menu to re-pick the tier. We re-
  // run the tier-selection screen by re-quoting current collateral
  // value (the cached quote may already be stale at this point — the
  // user has been sitting in the exits menu for some seconds).
  bot.callbackQuery("borrow:exits:retier", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    // Clear tier + exits so the user gets a fresh tier picker.
    delete state.tier;
    delete state.tierOption;
    delete state.exits;
    delete state.stage;
    pending.set(ctx.chat.id, state);
    let valueLamports;
    try {
      valueLamports = await collateralValueLamports(
        state.selected.mint,
        state.collateralRaw,
        state.selected.decimals,
      );
    } catch (err) {
      console.warn("[borrow:exits:retier] price re-fetch failed:", err.message);
      await ctx.answerCallbackQuery("Couldn't refresh price. Run /borrow again.");
      return;
    }
    state.collateralValueLamports = valueLamports;
    state.quotedAt = Date.now();
    pending.set(ctx.chat.id, state);
    const tiers = await getEligibleTiers({ category: state.selected.category });
    const kb = new InlineKeyboard();
    const tierLines = tiers.map((t) => {
      const loanSol = ((valueLamports * t.ltv) / 100) / 1e9;
      const fee = loanSol * (t.feeBps / 10_000);
      const receive = loanSol - fee;
      const shortMatch = t.label.match(/\(([^)]+)\)\s*$/);
      const shortName = shortMatch ? shortMatch[1] : t.label;
      kb.text(
        `${shortName} — ${receive.toFixed(4)} SOL`,
        `borrow:tier:${t.option}`,
      ).row();
      return `• *${shortName}* — ${t.ltv}% LTV · ${t.days}d · ${(t.feeBps / 100).toFixed(1)}% fee → *${receive.toFixed(4)} SOL*`;
    });
    kb.text("✕ Cancel", "borrow:cancel");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `*Collateral:* ${state.humanAmount.toLocaleString()} ${state.selected.symbol}`,
        `*Value:* ${fmtSol(valueLamports)} SOL`,
        "",
        "*Choose a loan tier:*",
        ...tierLines,
        "",
        "_Amount shown is what you receive after the tier fee._",
        "⏱ _This quote expires in 60 seconds._",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  // ── Post-borrow protection callbacks ───────────────────────────
  // One-tap arm from the funded-loan keyboard. Defaults: TP 2×,
  // SL 0.7×. Custom triggers via /takeprofit /stoploss. The
  // 'bracket' slot arms BOTH and rolls back leg-1 if leg-2 fails.
  bot.callbackQuery(/^borrow:protect:(tp|sl|bracket):(\d+)$/, async (ctx) => {
    const slot = ctx.match[1];
    const loanIdChain = ctx.match[2];
    // Bracket-specific path: arm TP then SL, roll back if needed.
    if (slot === "bracket") {
      let user;
      try { user = await upsertUser(ctx.from); }
      catch (err) {
        console.error("[borrow:protect:bracket] upsertUser failed:", err.message);
        await ctx.answerCallbackQuery("Couldn't verify your account. Try again.");
        return;
      }
      const { query } = await import("../db/pool.js");
      const { rows: [loanLite] } = await query(
        `SELECT collateral_mint FROM loans
          WHERE user_id = $1 AND loan_id = $2 AND status = 'active'
          LIMIT 1`,
        [user.id, loanIdChain],
      );
      if (!loanLite?.collateral_mint) {
        await ctx.answerCallbackQuery(`Loan #${loanIdChain} isn't active anymore.`);
        return;
      }
      let tpResolved, slResolved;
      try {
        tpResolved = await resolveMultiplierToPrice(loanLite.collateral_mint, 2);
        slResolved = await resolveMultiplierToPrice(loanLite.collateral_mint, 0.7, { allowBelowOne: true });
      } catch (err) {
        console.warn("[borrow:protect:bracket] resolve threw:", err.message);
        await ctx.answerCallbackQuery("Price lookup failed. Try /bracket manually.");
        return;
      }
      if (!tpResolved.ok) {
        await ctx.answerCallbackQuery({ text: tpResolved.error || "TP resolve failed.", show_alert: true });
        return;
      }
      if (!slResolved.ok) {
        await ctx.answerCallbackQuery({ text: slResolved.error || "SL resolve failed.", show_alert: true });
        return;
      }
      const tpArm = await armOrder({
        userId: user.id, source: "tg", loanIdChain,
        triggerKind: "price_usd", triggerValueMicro: tpResolved.triggerValueMicro.toString(),
        triggerDirection: "above", slippageBps: 200, sellDestination: "sol",
      });
      if (!tpArm.ok) {
        await ctx.answerCallbackQuery({
          text: tpArm.error === "loan_already_has_active_order_in_direction"
            ? "TP already armed — bracket needs both legs free."
            : `Couldn't arm TP (${tpArm.error}).`,
          show_alert: true,
        });
        return;
      }
      const slArm = await armOrder({
        userId: user.id, source: "tg", loanIdChain,
        triggerKind: "price_usd", triggerValueMicro: slResolved.triggerValueMicro.toString(),
        triggerDirection: "below", slippageBps: 300, sellDestination: "sol",
      });
      if (!slArm.ok) {
        // Roll back TP so the user isn't half-bracketed.
        const { cancelOrder } = await import("../services/limit-close-arm-core.js");
        try {
          await cancelOrder({ orderId: tpArm.orderId, userId: user.id, reason: "bracket_partial_rollback" });
        } catch (err) {
          console.warn(`[borrow:protect:bracket] rollback of TP ${tpArm.orderId} failed:`, err.message?.slice(0, 100));
        }
        await ctx.answerCallbackQuery({
          text: slArm.error === "loan_already_has_active_order_in_direction"
            ? "SL already armed — TP arm rolled back."
            : `SL leg failed (${slArm.error}). TP rolled back.`,
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({
        text: `Bracket armed: TP @ 2× #${tpArm.orderId} + SL @ 0.7× #${slArm.orderId}. /limitorders to view.`,
        show_alert: false,
      });
      return;
    }
    const direction = slot === "sl" ? "below" : "above";
    const multiplier = slot === "sl" ? 0.7 : 2;
    const slipBps = slot === "sl" ? 300 : 200;

    let user;
    try {
      user = await upsertUser(ctx.from);
    } catch (err) {
      console.error("[borrow:protect] upsertUser failed:", err.message);
      await ctx.answerCallbackQuery("Couldn't verify your account. Try again.");
      return;
    }

    // Resolve the loan's collateral mint so we can multiplier→price.
    const { query } = await import("../db/pool.js");
    const { rows: [loanLite] } = await query(
      `SELECT collateral_mint FROM loans
        WHERE user_id = $1 AND loan_id = $2 AND status = 'active'
        LIMIT 1`,
      [user.id, loanIdChain],
    );
    if (!loanLite?.collateral_mint) {
      await ctx.answerCallbackQuery(`Loan #${loanIdChain} isn't active anymore.`);
      return;
    }

    let resolved;
    try {
      resolved = await resolveMultiplierToPrice(
        loanLite.collateral_mint,
        multiplier,
        { allowBelowOne: direction === "below" },
      );
    } catch (err) {
      console.warn("[borrow:protect] multiplier resolve threw:", err.message);
      await ctx.answerCallbackQuery("Price lookup failed. Try /takeprofit or /stoploss manually.");
      return;
    }
    if (!resolved.ok) {
      await ctx.answerCallbackQuery(resolved.error || "Couldn't resolve target price.");
      return;
    }

    const armed = await armOrder({
      userId: user.id,
      source: "tg",
      loanIdChain,
      triggerKind: "price_usd",
      triggerValueMicro: resolved.triggerValueMicro.toString(),
      triggerDirection: direction,
      slippageBps: slipBps,
      sellDestination: "sol",
    });
    if (!armed.ok) {
      // Most likely cause: the OTHER slot was already armed via prior
      // tap — schema (mig 047) allows one TP + one SL, not duplicates.
      const friendly = (() => {
        switch (armed.error) {
          case "loan_already_has_active_order_in_direction":
            return `Already armed — use /modifyorder ${loanIdChain} to change it.`;
          case "trigger_would_fire_immediately":
            return `${direction === "below" ? "SL" : "TP"} would fire right now at this price. Skipped.`;
          case "user_concurrency_cap_reached":
            return `You're at the limit-order cap. Cancel one first.`;
          default:
            return `Couldn't arm (${armed.error || "unknown"}). Try /takeprofit or /stoploss manually.`;
        }
      })();
      await ctx.answerCallbackQuery({ text: friendly, show_alert: true });
      return;
    }

    // Confirm via callback toast — don't edit the borrow message so
    // the share buttons + the other protect button stay tappable.
    const sideLabel = direction === "below" ? "Stop-loss" : "Take-profit";
    await ctx.answerCallbackQuery({
      text: `${sideLabel} armed at ${multiplier}× — /limitorders to view.`,
      show_alert: false,
    });
  });
}
