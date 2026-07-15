import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getSupportedBalances, getSolBalance } from "../services/deposits.js";
import { collateralValueLamports, warmPriceCache } from "../services/price.js";
import { executeBorrow, recordLoan } from "../services/loans.js";
import { attestPrice, initializePriceFeed, getPriceFeedAgeSeconds } from "../services/price-attestor.js";
import { isBorrowingPaused } from "../services/admin.js";
import { incrementBorrowed } from "../services/reputation.js";
import { checkLoanLimits } from "../services/loan-limits.js";
import { translateTxError, errorActionKeyboard } from "../services/tx-error-translator.js";
import { renderRiskBlock } from "../services/token-risk-preview.js";
import { preBorrowBanCheck } from "../services/bans.js";
import { preBorrowAntiExploitCheck } from "../services/anti-exploit.js";
import { armOrder, armOrderBatch, resolveMultiplierToPrice } from "../services/limit-close-arm-core.js";
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

/**
 * Fetch the collateral value and render the tier picker. Used by the
 * preset-% buttons, the custom-% text path, AND the "Retry quote" inline
 * button. Extracted 2026-06-17 PM (operator-mandated reliability sprint)
 * so a transient price-fetch failure becomes a one-tap retry instead of
 * "Run /borrow to try again" — which lost the user's collateral selection
 * + % choice + balance lookup.
 *
 * Contract: caller has set `state.collateralRaw`, `state.humanAmount`, and
 * `state.selected` on `state`. This function handles `state.collateralValueLamports`,
 * `state.quotedAt`, pending-map persistence, AND the user-facing render
 * (success or retry).
 */
async function quoteAndRenderTiers(ctx, state) {
  let valueLamports;
  try {
    valueLamports = await collateralValueLamports(
      state.selected.mint,
      state.collateralRaw,
      state.selected.decimals,
    );
  } catch (err) {
    console.error(`[borrow] price fetch error for ${state.selected.symbol}:`, err.message);
    // CRITICAL reliability: keep the user's session. They've already
    // picked a token and an amount — making them /borrow over a Jupiter
    // 429 means they lose the wizard state and have to start over. The
    // price.js layer already serves stale-but-recent cached prices when
    // available; if THIS still failed, it's a genuine multi-source
    // outage and the next attempt in a few seconds is likely to succeed.
    pending.set(ctx.chat.id, state);
    const retries = (state.quoteRetries || 0) + 1;
    state.quoteRetries = retries;
    pending.set(ctx.chat.id, state);
    const retryKb = new InlineKeyboard()
      .text("🔁 Retry quote", "borrow:retry_quote")
      .row()
      .text("✕ Cancel", "borrow:cancel");
    const msg = retries < 3
      ? [
          "⚠️ *Couldn't fetch the price right now*",
          "",
          `_Likely a transient rate limit on one of our price sources. Your ${state.selected.symbol} selection and amount are saved — tap to retry, no need to restart._`,
        ].join("\n")
      : [
          "⚠️ *Price sources are slow right now*",
          "",
          `_${retries} retries so far. Both Jupiter and DexScreener may be heavily rate-limited; usually clears within a minute. Tap to keep trying — your selection stays put._`,
        ].join("\n");
    return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: retryKb });
  }
  state.collateralValueLamports = valueLamports;
  state.quotedAt = Date.now();
  state.quoteRetries = 0;
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

  const riskBlock = await renderRiskBlock(state.selected.symbol).catch(() => "");
  await ctx.reply(
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
}

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

// Quote expiry. Was 60s — too tight for users who want to take a moment
// to set up a custom auto-sell ladder during the exits step. The slippage
// guard at execution time independently catches real price drift (>2%),
// so a generous TTL doesn't sacrifice safety — it just lets people think
// before committing. Operator-tuned 2026-06-15 after the timeout
// complaint mid-ladder-build.
const QUOTE_TTL_MS = 300_000; // 5-minute quote expiry
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

  // Build the full leg set + display labels up front, then arm ALL legs in
  // ONE atomic armOrderBatch call (inserts N rows in a single DB
  // transaction — all-or-none). This brings the TG custodial flow to
  // parity with the site's batch path + the operator mandate
  // (feedback_one_signature_for_n_legs_always): a mid-leg failure can no
  // longer leave a partial ladder / half-bracket. Multiplier legs forward
  // kind:"multiplier" + multiplier so arm-core resolves them against the
  // cross-source oracle at batch time (the same single source of truth the
  // site uses); parsedStrike legs forward the literal kind + valueMicro.
  // collateralMint is unused here now — arm-core loads the loan's mint for
  // multiplier resolution — but kept in the signature for the caller.
  void collateralMint;
  const legs = [];
  const labels = [];
  const addMultiplier = (label, direction, multiplier, sliceBps) => {
    legs.push({
      direction,
      kind: "multiplier",
      multiplier,
      valueMicro: String(multiplier),
      sliceBps: sliceBps && sliceBps < 10000 ? sliceBps : 10000,
      slippageBps: direction === "below" ? 300 : 200,
    });
    labels.push(label);
  };
  const addStrike = (label, direction, parsedStrike, sliceBps) => {
    legs.push({
      direction,
      kind: parsedStrike.kind,
      valueMicro: parsedStrike.valueMicro.toString(),
      sliceBps: sliceBps && sliceBps < 10000 ? sliceBps : 10000,
      slippageBps: direction === "below" ? 300 : 200,
    });
    labels.push(label);
  };

  switch (exits.type) {
    case "tp_default":
      addMultiplier("TP @ 2x", "above", 2);
      break;
    case "sl_default":
      addMultiplier("SL @ 0.7x", "below", 0.7);
      break;
    case "bracket":
      // Atomic: TP + SL arm together or not at all — no half-bracket.
      addMultiplier("TP @ 2x", "above", 2);
      addMultiplier("SL @ 0.7x", "below", 0.7);
      break;
    case "custom_tp":
      addStrike(`TP @ ${exits.parsedStrike.normalizedDisplay}`, "above", exits.parsedStrike);
      break;
    case "custom_sl":
      addStrike(`SL @ ${exits.parsedStrike.normalizedDisplay}`, "below", exits.parsedStrike);
      break;
    case "tp_ladder":
    case "sl_ladder": {
      const direction = exits.type === "tp_ladder" ? "above" : "below";
      const sidePrefix = direction === "above" ? "TP" : "SL";
      for (const leg of exits.preset.legs) {
        addMultiplier(
          `${sidePrefix} ${leg.multiplier}x (${(leg.sliceBps / 100).toFixed(0)}%)`,
          direction,
          leg.multiplier,
          leg.sliceBps,
        );
      }
      break;
    }
    case "custom_ladder": {
      // User-built ladder. exits.legs = [{ parsedStrike, sliceBps, direction }].
      // Direction is uniform across legs (validated at submit time —
      // mixed-direction ladders are rejected before this point). sidePrefix
      // tracks the first leg's direction for label rendering.
      const sidePrefix = (exits.legs[0]?.direction || "above") === "above" ? "Profit" : "Stop";
      for (let i = 0; i < exits.legs.length; i++) {
        const leg = exits.legs[i];
        addStrike(
          `${sidePrefix} step ${i + 1} @ ${leg.parsedStrike.normalizedDisplay} (${(leg.sliceBps / 100).toFixed(0)}%)`,
          leg.direction,
          leg.parsedStrike,
          leg.sliceBps,
        );
      }
      break;
    }
    default:
      return [];
  }

  if (legs.length === 0) return [];

  // Atomic arm with a small transient-retry, mirroring the old per-leg
  // TRANSIENT_CODES loop but now at the batch level. arm-core already
  // polls up to 30s for the loan row (loan_not_found_for_user race), but
  // oracle / DB blips (resolve_failed / insert_failed / internal_error /
  // exception) can still transiently fail — retry a couple of times before
  // giving up. Permanent codes (ladder_sum_exceeds_100,
  // trigger_would_fire_immediately, user_concurrency_cap_reached, etc.)
  // break out on the first try.
  const TRANSIENT_CODES = new Set([
    "insert_failed",
    "resolve_failed",
    "loan_not_found",
    "loan_not_found_for_user",
    "internal_error",
    "exception",
  ]);
  let result;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await armOrderBatch({
      userId,
      source: "tg",
      loanIdChain,
      legs,
    });
    if (result.ok) break;
    if (!TRANSIENT_CODES.has(result.error)) break;
    if (attempt < MAX_ATTEMPTS) {
      // Brief backoff before retry — gives the DB / oracle a beat to settle.
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      console.warn(`[borrow] armOrderBatch transient failure (attempt ${attempt}/${MAX_ATTEMPTS}): ${result.error}, retrying`);
    }
  }

  // Map the atomic outcome back to the per-leg array the funded-loan card
  // consumes (drives allLegsArmed / the manual-retry buttons). All-or-none:
  // ok => every leg armed; fail => every leg failed. orderIds align to the
  // legs order we supplied (arm-core inserts in that order).
  if (result.ok) {
    const orderIds = Array.isArray(result.orderIds) ? result.orderIds : [];
    return labels.map((label, i) => ({ ok: true, label, orderId: orderIds[i] }));
  }
  const legNote = result.failedLegIndex != null ? ` (leg ${result.failedLegIndex + 1})` : "";
  console.warn(`[borrow] armConfiguredExits batch failed: ${result.error}${legNote}`);
  return labels.map((label) => ({ ok: false, label, error: result.error }));
}

// Escape Markdown V1 special chars that would otherwise be treated as
// formatting delimiters by Telegram. We do this on dynamic inputs
// (error codes from armOrder like "loan_already_has_active_order_in_direction"
// have many underscores; custom-strike labels may contain * or `) before
// embedding into the funded-loan card, since an unmatched delimiter
// makes Telegram refuse to render the whole message ("can't find end
// of the entity"). Caller wraps the LABELS in this; static text stays
// authored with intentional bold/italic in source.
function escapeMd(s) {
  return String(s)
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[");
}

// Translate engine error codes into plain-language phrasing for the
// funded-loan card. Users were seeing things like "failed
// (insert_failed)" which means nothing to a human. Maps known codes
// to friendly sentences; unknown codes get a generic message.
function humanizeArmError(code) {
  switch (code) {
    case "insert_failed":
      return "couldn't save it — try the retry button below";
    case "loan_already_has_active_order_in_direction":
      return "you already have an auto-sell going the same direction on this loan";
    case "ladder_sum_exceeds_100":
      return "this would push the total sell % above 100% (an existing leg is in the way)";
    case "trigger_would_fire_immediately":
      return "your target is already past the current price — set a further one";
    case "user_concurrency_cap_reached":
      return "you've hit the limit for armed auto-sells across all loans — cancel one first";
    case "resolve_failed":
      return "couldn't fetch a live price to convert your target — try the retry button";
    case "internal_error":
      return "something went wrong on our end — try the retry button below";
    case "loan_not_found":
      return "loan not recognized yet — try the retry button after a moment";
    default:
      return "couldn't set this one up — try the retry button below";
  }
}

function renderExitsSummary(armResults) {
  if (!armResults || armResults.length === 0) return null;
  const lines = armResults.map((r) =>
    r.ok
      ? `• ${escapeMd(r.label)} — armed #${r.orderId}`
      : `• ${escapeMd(r.label)} — ${escapeMd(humanizeArmError(r.error))}`,
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

    // Reliability: warm the cross-source price cache for this mint NOW
    // so the next callback (% pick) hits a populated cache even if
    // Jupiter goes 429 in the next minute. Best-effort fire-and-forget;
    // any error is swallowed by warmPriceCache and the % path still
    // does a live fetch — the warm just makes that fetch's fallback
    // path solid. Operator-mandated reliability rule 2026-06-17 PM.
    warmPriceCache(mint);

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
    // Delegate to the shared helper. On price fetch failure the helper
    // KEEPS state + shows a Retry button — no more "Run /borrow to try
    // again" that loses the user's entire wizard. Operator-mandated
    // reliability rule 2026-06-17 PM.
    await quoteAndRenderTiers(ctx, state);
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
    await ctx.answerCallbackQuery();
    // Delegate to the shared helper. On price fetch failure the helper
    // KEEPS state + shows a Retry button — no more "Run /borrow to try
    // again" that loses the user's collateral + % choice.
    await quoteAndRenderTiers(ctx, state);
  });

  // One-tap "Retry quote" — re-runs the price fetch + tier render using
  // the SAME state the user already built up. State is preserved across
  // any number of retries; each tap just re-tries the fetch.
  bot.callbackQuery("borrow:retry_quote", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.collateralRaw) {
      await ctx.answerCallbackQuery("Session expired — run /borrow again");
      return;
    }
    await ctx.answerCallbackQuery("Retrying…");
    await quoteAndRenderTiers(ctx, state);
  });

  // One-tap "Retry borrow" — re-runs executeBorrowWithExits using the
  // SAME state (selected token, % choice, tier, exit selection, etc.).
  // Used when attestPrice fails during submit due to transient infra
  // (Jupiter 429, Solana congestion, RPC blip). State is preserved so
  // the user doesn't have to walk back through 4 wizard steps.
  bot.callbackQuery("borrow:retry_submit", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired — run /borrow again");
      return;
    }
    await ctx.answerCallbackQuery("Retrying…");
    await executeBorrowWithExits(ctx, state);
  });

  // Renders the exits picker AFTER a tier is selected. User can pre-arm
  // TP / SL / Bracket / Custom strike / Ladder before the loan executes —
  // exits land in the same transaction window as the borrow so the user
  // walks out with both the loan and the strategy in one wizard.
  async function showExitsMenu(ctx, state) {
    state.stage = "await_exits";
    pending.set(ctx.chat.id, state);
    // Escape Markdown V1 specials in the symbol so a token whose ticker
    // contains an underscore (e.g. some Solana memecoins) doesn't break
    // the message render. Static decorators (bold/italic) in the body
    // stay intentional.
    const symbol = escapeMd(state.selected.symbol);
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
      .text("Build my own ladder", "borrow:exits:custom_ladder").row()
      .text("Skip — set later", "borrow:exits:skip").row()
      .text("← Change tier", "borrow:exits:retier").text("✕ Cancel", "borrow:cancel");
    await ctx.editMessageText(
      [
        `*Set your auto-sell plan for ${symbol}*`,
        "",
        "Pick a plan now and we'll auto-sell your collateral the moment your target hits — no need to babysit the chart or come back later.",
        "",
        "• *Sell at 2x* — auto-sell if price *doubles* (locks in gains). Also called \"take profit\" (TP).",
        "• *Sell at 0.7x* — auto-sell if price drops *30%* (limits losses). Also called \"stop loss\" (SL).",
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
    //
    // V4-aware (2026-06-15): exit-armed borrows land on V4 (regardless
    // of category), so attest V4's PriceHistory PDA when the wizard
    // selected any exit. Otherwise attest the category default (V1/V3).
    // Without this, V4 borrows surface as "Account state mismatch"
    // because V4's price_feed PDA was never initialized.
    const hasExitArmingForAttest = !!(state.exits && state.exits.type && state.exits.type !== "skip");
    let attestProgramId = null;
    if (hasExitArmingForAttest) {
      const { PROGRAM_ID_V4 } = await import("../solana/program.js");
      if (PROGRAM_ID_V4) attestProgramId = PROGRAM_ID_V4;
    }
    const FRESH_THRESHOLD_SEC = 60;
    const feedAge = await getPriceFeedAgeSeconds(state.selected.mint, attestProgramId);
    const needsAttest = feedAge === null || feedAge > FRESH_THRESHOLD_SEC;

    // TWAP warming gate. V3 + V4 both use the price_v3 PriceHistory
    // layout with a >=8-samples-in-300s rule. A single attest below
    // doesn't get us there from a cold start — loop until the PDA has
    // the count it needs, or surface a clean "feed warming" prompt
    // with state preserved. Operator-mandated 2026-06-18 PM after the
    // SPCX V3 TwapInsufficientHistory recurrence; the original V4-only
    // implementation left V3 RWA borrows exposed. See
    // [[feedback_twap_insufficient_history_never_again]].
    {
      const { PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../solana/program.js");
      const usesTwapGate = !!(
        attestProgramId &&
        ((PROGRAM_ID_V4 && attestProgramId.equals(PROGRAM_ID_V4)) ||
          (PROGRAM_ID_V3 && attestProgramId.equals(PROGRAM_ID_V3)))
      );
      if (usesTwapGate) {
        const { ensureV4TwapReady } = await import("../services/price-attestor.js");
        const warm = await ensureV4TwapReady(state.selected.mint, state.selected.decimals, {
          programIdOverride: attestProgramId,
        });
        if (!warm.ok) {
          // Preserve state so the user just taps Retry — no need to
          // re-pick collateral/tier/exits.
          pending.set(ctx.chat.id, state);
          const kb = new InlineKeyboard()
            .text("Retry borrow", "borrow:retry_submit").row()
            .text("Cancel", "borrow:cancel");
          await say(
            `*Price oracle is warming up for ${state.selected.symbol}.*\n\n` +
            `We need ${warm.inWindow}/8 samples within the rolling 5-min window. ` +
            `It usually finishes in 30–45 seconds. Your collateral + tier + exits are saved — tap to retry.`,
            { parse_mode: "Markdown", reply_markup: kb },
          );
          return;
        }
        // The TWAP-warm path also writes a fresh sample as side effect,
        // so the freshness check below would no-op. Fall through anyway
        // — the single-shot attest path stays cheap when feed is fresh.
      }
    }

    if (needsAttest) {
      try {
        await attestPrice(state.selected.mint, state.selected.decimals, undefined, attestProgramId);
      } catch (attestErr) {
        if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(attestErr.message)) {
          try {
            await initializePriceFeed(state.selected.mint, attestProgramId);
            await attestPrice(state.selected.mint, state.selected.decimals, undefined, attestProgramId);
          } catch (initErr) {
            // KEEP state — show retry button. The borrow hasn't started.
            pending.set(ctx.chat.id, state);
            const kb = new InlineKeyboard()
              .text("🔁 Retry borrow", "borrow:retry_submit").row()
              .text("✕ Cancel", "borrow:cancel");
            await say(
              `⚠️ *Couldn't initialize on-chain price feed for ${state.selected.symbol}*\n\n_${initErr.message?.slice(0, 200) || "(unknown error)"}_\n\nYour collateral + tier selection are saved — tap to retry.`,
              { parse_mode: "Markdown", reply_markup: kb },
            );
            return;
          }
        } else if (/not confirmed in \d+|timed out|TransactionExpired/i.test(attestErr.message)) {
          // Solana congestion ate the attestation tx. Re-check the feed
          // age — if a previous attest got close enough to land, we may
          // already be within the contract's 120s window.
          const recheckAge = await getPriceFeedAgeSeconds(state.selected.mint, attestProgramId);
          if (recheckAge !== null && recheckAge < 110) {
            // Close enough — proceed with the borrow anyway.
          } else {
            // KEEP state — show retry button so user can re-trigger when
            // Solana congestion eases. No need to walk back through
            // token + % + tier + exit selections.
            pending.set(ctx.chat.id, state);
            const kb = new InlineKeyboard()
              .text("🔁 Retry borrow", "borrow:retry_submit").row()
              .text("✕ Cancel", "borrow:cancel");
            await say(
              `⚠️ *Solana network congested*\n\nOur price refresh tx didn't confirm. Usually clears within a minute. Your collateral + tier are saved — tap to retry.`,
              { parse_mode: "Markdown", reply_markup: kb },
            );
            return;
          }
        } else {
          // KEEP state — show retry button. attestPrice failures are
          // usually transient (Jupiter 429, RPC blip, brief outage).
          pending.set(ctx.chat.id, state);
          const kb = new InlineKeyboard()
            .text("🔁 Retry borrow", "borrow:retry_submit").row()
            .text("✕ Cancel", "borrow:cancel");
          await say(
            `⚠️ *Couldn't refresh on-chain price for ${state.selected.symbol}*\n\n_${attestErr.message?.slice(0, 200) || "(unknown error)"}_\n\nYour collateral + tier are saved — tap to retry.`,
            { parse_mode: "Markdown", reply_markup: kb },
          );
          return;
        }
      }
    }

    // ── Phase 1: submit borrow tx ──────────────────────────────────
    // This block CAN legitimately fail and surface as "Borrow failed."
    // Below this point, the loan exists on-chain and we MUST never
    // tell the user it failed — even if the post-tx rendering breaks.
    let result;
    try {
      // V4-exclusive routing (2026-06-15): if the user selected ANY
      // exit type in the wizard (not 'skip'), this borrow lands on V4
      // because V4 is the only pool whose engine fire path keeps the
      // loan ACTIVE and accumulates SOL in the per-loan vault. Plain
      // borrows (state.exits.type === 'skip' or no exits) take the
      // legacy V1/V2/V3 category routing.
      const hasExitArming = !!(state.exits && state.exits.type && state.exits.type !== "skip");
      result = await executeBorrow({
        userId: state.userId,
        collateralMint: state.selected.mint,
        collateralAmountRaw: state.collateralRaw,
        collateralValueLamports: currentValueLamports,
        loanOption: option,
        hasExitArming,
      });
    } catch (err) {
      console.error("Borrow failed (pre-tx or tx submission):", err);
      const friendly = translateTxError(err, { flow: "borrow" });
      await say(friendly, {
        parse_mode: "Markdown",
        reply_markup: errorActionKeyboard({ flow: "borrow", errorKind: "tx_error" }),
      });
      return;
    }

    // ✓ LOAN EXISTS ON-CHAIN from here down. The user MUST receive a
    // confirmation that includes the tx signature. Any post-tx error
    // (DB write, exit arming, card render) is surfaced as a NOTE on
    // top of a success confirmation — never as a generic "Borrow
    // failed" message. The 2026-06-14 incident: Markdown render failed
    // → catch block translated it to "Borrow failed" → user thought
    // their loan didn't exist when it actually did. Operator: "this
    // can NEVER happen again."

    const loanAmountPreFee = Math.floor((currentValueLamports * tier.ltv) / 100);
    const fee = Math.floor((loanAmountPreFee * tier.feeBps) / 10_000);
    const loanAmountAfterFee = loanAmountPreFee - fee;

    let recordLoanFailed = false;
    try {
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
    } catch (err) {
      recordLoanFailed = true;
      console.error("[borrow] recordLoan failed AFTER on-chain success — sync-loan will rescue:", err.message);
      // sync-loan watcher recovers DB-side state from the on-chain loan_pda
      // independently, so this is a soft failure for the user but worth
      // logging at error level for the operator.
    }

    // Auto-arm pre-selected exits. Failures are per-leg and don't abort.
    const exitArmResults = await armConfiguredExits({
      userId: state.userId,
      loanIdChain: result.loanId,
      collateralMint: state.selected.mint,
      exits: state.exits,
    }).catch((err) => {
      console.warn("[borrow] armConfiguredExits threw:", err.message);
      return [{ ok: false, label: "Auto-arm", error: "internal_error" }];
    });
    // exitsSummary used to be embedded in the borrow card — removed
    // 2026-06-15 per operator's "bad look" feedback. The per-leg
    // outcomes now ride on the limit_close_armed / limit_close_arm_failed
    // DM pipeline (migration 068) instead.
    const allLegsArmed = exitArmResults.length > 0 && exitArmResults.every((r) => r.ok);
    const anyExitFailed = exitArmResults.some((r) => !r.ok);

    pending.delete(ctx.chat.id);

    // V4-exclusive guard: when V4_EXIT_EXCLUSIVE_ENFORCE is on, only loans
    // that landed on V4 can be armed with exits. Showing protect buttons
    // or "/takeprofit ..." hints on a V1/V3 loan would just route the user
    // into an exits_require_v4_loan refusal (see limit-close-arm-core.js).
    // So gate post-borrow exit prompts on the actual program the loan
    // landed on, not on whether arming was requested.
    const v4ProgramId = process.env.PROGRAM_ID_V4 || null;
    const v4Enforced = process.env.V4_EXIT_EXCLUSIVE_ENFORCE === "true";
    const isV4Loan = !!v4ProgramId && result.programId === v4ProgramId;
    const canArmExits = isV4Loan || !v4Enforced;

    // Build inline keyboard. Show protect buttons only when (a) some leg
    // didn't arm AND (b) the loan is actually arm-eligible.
    let kb = new InlineKeyboard();
    if (!allLegsArmed && canArmExits) {
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

    // ── Phase 2: render the funded-loan card ──────────────────────
    // Try Markdown first; if Telegram rejects the formatting for ANY
    // reason, fall back to a plain-text confirmation. If even plain
    // text fails (Telegram down, etc.), fall back to a minimal
    // sendMessage. The user must ALWAYS see "loan funded" — never a
    // "borrow failed" miscommunication for a borrow that actually
    // succeeded.

    // V4 in-vault explainer (operator-mandated rule
    // feedback_v4_in_vault_thesis_non_negotiable.md). When the loan is
    // on V4 AND any auto-sell is involved (either armed-in-flow or
    // pickable via the retry buttons), the borrow card MUST tell the
    // user how V4 fires actually behave — proceeds accumulate in the
    // per-loan vault, loan stays Active, /repay releases SOL. Without
    // this, V4 borrowers who see a fire DM later might expect SOL in
    // their wallet and panic.
    const showV4Note = isV4Loan && (allLegsArmed || (canArmExits && !allLegsArmed));
    const v4InVaultLine = showV4Note
      ? "_V4 in-vault auto-sell: when a target hits, the engine sells that slice on-chain — SOL accumulates inside your loan's vault, loan stays Active. Run /repay anytime to release the SOL._"
      : null;

    const markdownLines = [
      "✅ *Loan funded*",
      "",
      `Received: *${fmtSol(loanAmountAfterFee)} SOL*`,
      `Repay by due date: *${fmtSol(loanAmountPreFee)} SOL*`,
      `Term: ${tier.days} days at ${tier.ltv}% LTV`,
      "",
      `[View tx](https://solscan.io/tx/${result.signature})`,
      // Per-leg arm results intentionally NOT shown on the borrow card —
      // operator's 2026-06-15 directive: "I thought we GOT RID of that
      // Profit Leg disclaimer at the bottom. It's a bad look." Failed
      // legs are surfaced in their own `limit_close_arm_failed` DM via
      // the audit pipeline (migration 068), and successful ones in the
      // existing `limit_close_armed` DM — both arrive within seconds.
      // The borrow card stays clean. Retry buttons below still appear
      // when an exit didn't land, so users have a single-tap recovery.
      "",
      allLegsArmed
        ? "/positions to check status · /limitorders to manage auto-sells"
        : canArmExits
          ? "*Want to set an auto-sell?* Tap a button above, or type:"
          : "/positions to check status · /share to flex on the timeline",
      allLegsArmed || !canArmExits
        ? null
        : `\`/takeprofit ${result.loanId} at 2x\` (sell when up 2x)`,
      allLegsArmed || !canArmExits
        ? null
        : `\`/stoploss ${result.loanId} at 0.7x\` (sell if down 30%)`,
      allLegsArmed || !canArmExits ? null : "",
      allLegsArmed || !canArmExits ? null : "/positions to check status · /share to flex on the timeline",
      v4InVaultLine,
    ].filter((l) => l != null);

    const plainTextLines = [
      "Loan funded successfully",
      "",
      `Received: ${fmtSol(loanAmountAfterFee)} SOL`,
      `Repay by due date: ${fmtSol(loanAmountPreFee)} SOL`,
      `Term: ${tier.days} days at ${tier.ltv}% LTV`,
      `Loan #${result.loanId}`,
      "",
      `Tx: https://solscan.io/tx/${result.signature}`,
      // Same omission as the Markdown card — leg results go via DM.
      "",
      allLegsArmed
        ? "Run /positions to check status, /limitorders to manage auto-sells."
        : canArmExits
          ? "Tap a button below to set up auto-sells, or use /takeprofit and /stoploss."
          : "Run /positions to check status.",
    ].filter((l) => l != null);

    let renderedOk = false;
    try {
      await say(markdownLines.join("\n"), {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: kb,
      });
      renderedOk = true;
    } catch (mdErr) {
      console.error(
        `[borrow] Markdown card render failed for loan ${result.loanId}, falling back to plain text:`,
        mdErr.message,
      );
    }

    if (!renderedOk) {
      try {
        await say(plainTextLines.join("\n"), {
          disable_web_page_preview: true,
          reply_markup: kb,
        });
        renderedOk = true;
      } catch (plainErr) {
        console.error(
          `[borrow] Plain-text card ALSO failed for loan ${result.loanId}:`,
          plainErr.message,
        );
      }
    }

    if (!renderedOk) {
      // Last resort: a fresh sendMessage (not an edit) with no
      // formatting and no keyboard. Even if the original message id
      // has gone stale, this lands as a new chat message and the user
      // sees the confirmation.
      try {
        await ctx.api.sendMessage(
          ctx.chat.id,
          `Loan #${result.loanId} funded successfully. You received ${fmtSol(loanAmountAfterFee)} SOL. Tx: https://solscan.io/tx/${result.signature}. Run /positions to manage it.`,
        );
      } catch (finalErr) {
        console.error(
          `[borrow] Even fresh sendMessage failed for loan ${result.loanId}:`,
          finalErr.message,
        );
        // We've exhausted retries. The loan exists, the DB row exists,
        // /positions will show it. Operator will see the error logs.
      }
    }

    // Notify operator if anything went sideways after on-chain success.
    // Include per-leg error codes so the operator gets full diagnostic
    // info instead of just "exit arm failed". This is how we'll pinpoint
    // root causes like the operator's 2026-06-15 insert_failed leg
    // without having to dig through Railway logs.
    if (!renderedOk || recordLoanFailed || anyExitFailed) {
      try {
        const { notifyAdmin, getNotifyBot } = await import("../services/admin-notify.js");
        const failedLegs = exitArmResults
          .filter((r) => !r.ok)
          .map((r) => `${r.label}: ${r.error || "unknown"}`)
          .join(" | ");
        const issues = [
          recordLoanFailed ? "recordLoan failed" : null,
          !renderedOk ? "card render failed" : null,
          anyExitFailed ? `exit arm failed [${failedLegs}]` : null,
        ].filter(Boolean).join(", ");
        const adminBot = getNotifyBot();
        if (adminBot) {
          await notifyAdmin(
            adminBot,
            `/borrow post-tx issue on loan ${result.loanId} (user ${state.userId}): ${issues}. Tx: ${result.signature}`,
          );
        }
      } catch { /* admin alert is best-effort */ }
    }
  }

  // ── New tier callback — stores selection, then asks whether the
  //     user wants to set up an auto-sell BEFORE the loan executes
  //     (operator-tuned 2026-06-15). The full multi-option exits menu
  //     was hounding users who just wanted to borrow and walk away,
  //     so we now ask a single Yes/No first. "Just borrow" is the
  //     primary action; users who want to pre-arm tap the secondary
  //     button to reach the existing exits menu. Skip-path users
  //     still get one-tap TP / SL / Bracket buttons on the funded-
  //     loan card.
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
    await showAutoSellGate(ctx, state);
  });

  // Shows the Yes/No gate after tier selection. "Just borrow" runs the
  // borrow immediately with no pre-arms (user can still tap the
  // protect buttons on the funded card). "Set auto-sells first"
  // opens the multi-option exits menu.
  async function showAutoSellGate(ctx, state) {
    state.stage = "await_autosell_gate";
    pending.set(ctx.chat.id, state);
    const symbol = escapeMd(state.selected.symbol);
    const tier = state.tier;
    const receiveSol = ((Number(state.collateralValueLamports) * tier.ltv) / 100 / 1e9) * (1 - tier.feeBps / 10_000);
    await ctx.editMessageText(
      [
        `*Ready to borrow ${receiveSol.toFixed(4)} SOL against ${symbol}*`,
        "",
        `Tier: ${tier.days} days at ${tier.ltv}% LTV`,
        "",
        "Want to set up an auto-sell now? Loans with auto-sells route to a different pool — they can't be added after the fact. (You can always /borrow again later to open a fresh loan with one.)",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("Just borrow", "borrow:gate:skip").row()
          .text("Set auto-sells first", "borrow:gate:setup").row()
          .text("← Change tier", "borrow:exits:retier")
          .text("✕ Cancel", "borrow:cancel"),
      },
    );
  }

  // "Just borrow" — skip the exits menu entirely, run the borrow now.
  bot.callbackQuery("borrow:gate:skip", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    state.exits = { type: "skip" };
    await ctx.answerCallbackQuery();
    await executeBorrowWithExits(ctx, state);
  });

  // "Set auto-sells first" — show the existing multi-option exits menu.
  bot.callbackQuery("borrow:gate:setup", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
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
    const safeSymbol = escapeMd(state.selected.symbol);
    const headline = kind === "custom_tp"
      ? `*Auto-sell when price goes UP — ${safeSymbol}*`
      : `*Auto-sell when price drops DOWN — ${safeSymbol}*`;
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
        `*${side === "tp" ? "Profit ladder (sell on the way UP)" : "Loss-defense ladder (sell on the way DOWN)"} — ${escapeMd(state.selected.symbol)}*`,
        "",
        side === "tp"
          ? "Sell your collateral in stages as the price climbs, instead of all at one target. You'll lock in some gains early and let some ride higher."
          : "Sell your collateral in stages as the price drops, instead of all at one stop. You'll protect some capital early while leaving room for a recovery.",
        "",
        "Heads up: each step is a separate sell + re-borrow, so 3 steps cost ~3× the loan fee of a single exit.",
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

  // ── Custom ladder builder (TG version) ───────────────────────────
  // Operator wants users to type their own multi-step ladder rather
  // than picking from presets. Flow:
  //   1. User taps "Build my own ladder" in the exits menu.
  //   2. Bot prompts for a multi-line message: "<target> <slice%>"
  //      per line, e.g.  17M 70  /  20M 20  /  25M 10
  //   3. User sends one message. Bot parses, validates, shows a
  //      confirmation card with the parsed ladder and Confirm /
  //      Cancel buttons.
  //   4. On Confirm we set state.exits.custom_ladder and proceed to
  //      executeBorrowWithExits.
  // Validation rejects: empty lines, unparseable strikes, slices not
  // in (0,100], sum > 100, mixed direction (legs disagree on
  // above/below).
  bot.callbackQuery("borrow:exits:custom_ladder", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    state.stage = "await_custom_ladder_input";
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `*Build your own ladder for ${escapeMd(state.selected.symbol)}*`,
        "",
        "Type your ladder as one line per step. Each line is two parts: the price/MC target, then the % of your collateral to sell at that step.",
        "",
        "*Example for selling on the way up:*",
        "```",
        "17M 70",
        "20M 20",
        "25M 10",
        "```",
        "",
        "*Example for selling on the way down:*",
        "```",
        "0.85x 30",
        "0.7x 40",
        "0.5x 30",
        "```",
        "",
        "Up to 6 steps. Total sell % must be 100 or less. All steps must go the same direction (all up, or all down).",
        "",
        "Send your ladder in one message, or tap *Back* to pick a different option.",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("← Back", "borrow:exits:back"),
      },
    );
  });

  // Parses a multi-line ladder message. Returns { ok: true, legs }
  // or { ok: false, error }.
  function parseCustomLadderMessage(raw) {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) {
      return { ok: false, error: "no steps — type at least one line." };
    }
    if (lines.length > 6) {
      return { ok: false, error: `up to 6 steps allowed (got ${lines.length}).` };
    }
    const legs = [];
    let firstDirection = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Split into tokens; the LAST token is the slice%, everything
      // before is the strike. Lets users write "17M MC 70%" or
      // "17 million 70".
      const tokens = line.split(/\s+/);
      if (tokens.length < 2) {
        return { ok: false, error: `step ${i + 1}: need both target and sell % (e.g. \`17M 70\`).` };
      }
      const sliceToken = tokens.pop().replace(/%$/, "");
      const sliceNum = Number(sliceToken);
      if (!Number.isFinite(sliceNum) || sliceNum <= 0 || sliceNum > 100) {
        return { ok: false, error: `step ${i + 1}: sell % must be 1–100 (got "${sliceToken}").` };
      }
      const strikeText = tokens.join(" ");
      const parsed = parseStrike(strikeText, {});
      if (!parsed.ok) {
        return { ok: false, error: `step ${i + 1}: couldn't read target "${strikeText}" — ${parsed.error || "try again"}.` };
      }
      const dir = parsed.impliedDirection || "above";
      if (firstDirection === null) firstDirection = dir;
      else if (dir !== firstDirection) {
        return { ok: false, error: `step ${i + 1}: direction mismatch — all steps must go the same way (got "${dir}" after "${firstDirection}").` };
      }
      legs.push({
        strikeText,
        parsedStrike: parsed,
        sliceBps: Math.round(sliceNum * 100),
        direction: dir,
      });
    }
    const totalSliceBps = legs.reduce((s, l) => s + l.sliceBps, 0);
    if (totalSliceBps > 10000) {
      return { ok: false, error: `total sell % is ${(totalSliceBps / 100).toFixed(0)}% — must be 100% or less.` };
    }
    return { ok: true, legs };
  }

  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || state.stage !== "await_custom_ladder_input") return next();
    const parsed = parseCustomLadderMessage(ctx.message.text);
    if (!parsed.ok) {
      return ctx.reply(
        `Couldn't read that ladder: ${parsed.error}\n\nSend it again, or use /borrow to start over.`,
        { parse_mode: "Markdown" },
      );
    }
    // Stash the parsed ladder into pending state for the confirm
    // callback. parsedStrike has BigInt fields which are fine for
    // in-memory but won't survive process restart — that matches the
    // rest of pending state's lifecycle (in-memory per chat).
    state.pendingCustomLadder = parsed.legs;
    state.stage = "await_custom_ladder_confirm";
    pending.set(ctx.chat.id, state);
    const sidePrefix = parsed.legs[0].direction === "above" ? "Profit" : "Stop";
    const lines = parsed.legs.map((leg, i) =>
      `Step ${i + 1}: ${escapeMd(leg.parsedStrike.normalizedDisplay)} → sell *${(leg.sliceBps / 100).toFixed(0)}%*`,
    );
    const totalPct = parsed.legs.reduce((s, l) => s + l.sliceBps, 0) / 100;
    await ctx.reply(
      [
        `*${sidePrefix} ladder for ${escapeMd(state.selected.symbol)}*`,
        "",
        ...lines,
        "",
        `Total: *${totalPct.toFixed(0)}%* of your collateral.`,
        "",
        "Each step pays the protocol fee on its own re-borrow, so a 3-step ladder costs roughly 3× the fee of a single exit. Confirm to proceed.",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✓ Use this ladder", "borrow:exits:custom_ladder:confirm")
          .text("Edit", "borrow:exits:custom_ladder:redo")
          .row()
          .text("✕ Cancel", "borrow:cancel"),
      },
    );
  });

  bot.callbackQuery("borrow:exits:custom_ladder:confirm", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier || !state.pendingCustomLadder) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    state.exits = { type: "custom_ladder", legs: state.pendingCustomLadder };
    delete state.pendingCustomLadder;
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    await executeBorrowWithExits(ctx, state);
  });

  bot.callbackQuery("borrow:exits:custom_ladder:redo", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state || !state.tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }
    delete state.pendingCustomLadder;
    state.stage = "await_custom_ladder_input";
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Send your ladder again — one line per step, format `<target> <sell%>`.",
      { parse_mode: "Markdown" },
    );
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
