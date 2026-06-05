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

const LTV_TIERS = [
  { option: 0, ltv: 30, days: 2, feeBps: 300, label: "30% LTV · 2d · 3% fee (Express)" },
  { option: 1, ltv: 25, days: 3, feeBps: 200, label: "25% LTV · 3d · 2% fee (Quick)" },
  { option: 2, ltv: 20, days: 7, feeBps: 150, label: "20% LTV · 7d · 1.5% fee (Standard)" },
];

// In-memory pending state per Telegram chat; fine for MVP, move to DB for prod.
const pending = new Map();

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
      .text("✏️ Custom amount", "borrow:custom")
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
        `Type the amount of ${state.selected.symbol} you want to use as collateral:`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // Middleware to catch custom amount input.
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || state.stage !== "await_custom") return next();

    const input = ctx.message.text.trim().replace(/,/g, "");
    const amount = Number(input);

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("Please enter a valid number.");
    }

    if (amount > state.selected.humanAmount) {
      return ctx.reply(
        `That's more than your balance of ${state.selected.humanAmount.toLocaleString()} ${state.selected.symbol}. Try a smaller amount.`,
      );
    }

    const rawBig = BigInt(Math.floor(amount * 10 ** state.selected.decimals));
    state.collateralRaw = rawBig;
    state.humanAmount = amount;
    state.stage = "tier";
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

    const kb = new InlineKeyboard();
    for (const t of LTV_TIERS) {
      const loanSol = ((valueLamports * t.ltv) / 100) / 1e9;
      const fee = loanSol * (t.feeBps / 10_000);
      const receive = loanSol - fee;
      kb.text(
        `${t.label} → ~${receive.toFixed(4)} SOL`,
        `borrow:tier:${t.option}`,
      ).row();
    }
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
        "_(amount shown is what you receive after tier fee)_",
        "",
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
    const valueLamports = await collateralValueLamports(
      state.selected.mint,
      rawBig,
      state.selected.decimals,
    );
    state.collateralValueLamports = valueLamports;
    state.quotedAt = Date.now();
    pending.set(ctx.chat.id, state);

    const kb = new InlineKeyboard();
    for (const t of LTV_TIERS) {
      const loanSol = ((valueLamports * t.ltv) / 100) / 1e9;
      const fee = loanSol * (t.feeBps / 10_000);
      const receive = loanSol - fee;
      kb.text(
        `${t.label} → ~${receive.toFixed(4)} SOL`,
        `borrow:tier:${t.option}`,
      ).row();
    }
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
        "_(amount shown is what you receive after tier fee)_",
        "",
        "⏱ _This quote expires in 60 seconds._",
      ].filter((l) => l != null).join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^borrow:tier:(\d+)$/, async (ctx) => {
    const option = Number(ctx.match[1]);
    const tier = LTV_TIERS.find((t) => t.option === option);
    const state = pending.get(ctx.chat.id);
    if (!state || !tier) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }

    // ── Quote expiry check ──
    if (isQuoteExpired(state)) {
      pending.delete(ctx.chat.id);
      await ctx.answerCallbackQuery("Quote expired");
      await ctx.editMessageText(
        "⏱ *Quote expired* — prices may have changed.\n\nRun /borrow to get a fresh quote.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    // ── Price slippage guard — re-fetch and compare ──
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⏳ Verifying price...");

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
      await ctx.editMessageText(
        "❌ Could not verify current price. Run /borrow to try again.",
      );
      return;
    }

    const quotedValue = state.collateralValueLamports;
    const priceDrift = Math.abs(currentValueLamports - quotedValue) / quotedValue * 100;

    if (priceDrift > MAX_SLIPPAGE_PCT) {
      pending.delete(ctx.chat.id);
      const direction = currentValueLamports < quotedValue ? "dropped" : "increased";
      await ctx.editMessageText(
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
      await ctx.editMessageText(
        `⚠️ *Loan limit reached*\n\n${limitCheck.reason}\n\nTier: *${limitCheck.tier}*\nRun /borrow to try a smaller amount.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.editMessageText("⏳ Submitting on-chain...");

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
            await ctx.editMessageText(
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
            await ctx.editMessageText(
              `⚠️ Solana network is congested right now and our price refresh tx didn't confirm.\n\nGive it a minute and try /borrow again — it usually clears quickly.`,
            );
            return;
          }
        } else {
          pending.delete(ctx.chat.id);
          await ctx.editMessageText(
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
      });
      await incrementBorrowed(state.userId, loanAmountPreFee);

      pending.delete(ctx.chat.id);

      // Build share button — every funded loan is a marketing moment
      let shareKb;
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
        shareKb = new InlineKeyboard()
          .url("𝕏 Share to Twitter", card.twitterUrl)
          .url("📨 Tell a friend", card.telegramShareUrl);
      } catch { /* non-critical */ }

      await ctx.editMessageText(
        [
          "✅ *Loan funded*",
          "",
          `Received: *${fmtSol(loanAmountAfterFee)} SOL*`,
          `Repay by due date: *${fmtSol(loanAmountPreFee)} SOL*`,
          `Term: ${tier.days} days at ${tier.ltv}% LTV`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
          "",
          "/positions to check status · /share to flex on the timeline",
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: shareKb },
      );
    } catch (err) {
      console.error("Borrow failed:", err);
      const friendly = translateTxError(err, { flow: "borrow" });
      await ctx.editMessageText(friendly, {
        parse_mode: "Markdown",
        reply_markup: errorActionKeyboard({ flow: "borrow", errorKind: "tx_error" }),
      });
    }
  });
}
