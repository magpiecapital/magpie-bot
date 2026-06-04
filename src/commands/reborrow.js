/**
 * /reborrow — Quick re-borrow using the same token and tier as the user's
 * most recent completed loan. One confirmation tap instead of the full flow.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getSupportedBalances } from "../services/deposits.js";
import { collateralValueLamports } from "../services/price.js";
import { executeBorrow, recordLoan } from "../services/loans.js";
import { checkLoanLimits } from "../services/loan-limits.js";
import { isBorrowingPaused } from "../services/admin.js";
import { incrementBorrowed } from "../services/reputation.js";
import { query } from "../db/pool.js";
import { translateTxError, errorActionKeyboard } from "../services/tx-error-translator.js";

const LTV_TIERS = [
  { option: 0, ltv: 30, days: 2, feeBps: 300, label: "Express" },
  { option: 1, ltv: 25, days: 3, feeBps: 200, label: "Quick" },
  { option: 2, ltv: 20, days: 7, feeBps: 150, label: "Standard" },
];

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleReborrow(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  if (isBorrowingPaused()) {
    return ctx.reply("⏸ Borrowing is temporarily paused. Try again shortly.");
  }

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  // Find last completed loan
  const { rows: [lastLoan] } = await query(
    `SELECT collateral_mint, ltv_percentage, collateral_amount
     FROM loans
     WHERE user_id = $1 AND status IN ('repaid', 'active')
     ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );

  if (!lastLoan) {
    return ctx.reply("No previous loans found. Use /borrow for your first loan.");
  }

  // Check if they have a balance of the same token
  const balances = await getSupportedBalances(publicKey);
  const match = balances.find((b) => b.mint === lastLoan.collateral_mint);

  if (!match || match.rawAmount <= 0n) {
    return ctx.reply(
      `You don't have any ${lastLoan.collateral_mint.slice(0, 8)}... in your wallet.\n\nDeposit tokens and try again, or use /borrow to pick a different token.`,
    );
  }

  // Use same tier as last loan
  const tier = LTV_TIERS.find((t) => t.ltv === lastLoan.ltv_percentage) || LTV_TIERS[2];

  // Use same amount or full balance (whichever is smaller)
  const lastRaw = BigInt(lastLoan.collateral_amount);
  const useRaw = match.rawAmount < lastRaw ? match.rawAmount : lastRaw;
  const humanAmount = Number(useRaw) / 10 ** match.decimals;

  let valueLamports;
  try {
    valueLamports = await collateralValueLamports(match.mint, useRaw, match.decimals);
  } catch {
    return ctx.reply("⚠️ Couldn't fetch price right now. Try /borrow instead.");
  }

  const loanAmountPreFee = Math.floor((valueLamports * tier.ltv) / 100);
  const fee = Math.floor((loanAmountPreFee * tier.feeBps) / 10_000);
  const receive = loanAmountPreFee - fee;

  const kb = new InlineKeyboard()
    .text("✅ Confirm", `reborrow:confirm:${match.mint}:${useRaw}:${tier.option}:${valueLamports}`)
    .text("✕ Cancel", "reborrow:cancel");

  await ctx.reply(
    [
      "🔄 *Quick Re-borrow*",
      "",
      `Token: *${match.symbol}*`,
      `Collateral: ${humanAmount.toLocaleString()} ${match.symbol}`,
      `Tier: *${tier.label}* (${tier.ltv}% LTV · ${tier.days}d)`,
      `Receive: *${fmtSol(receive)} SOL*`,
      `Repay: *${fmtSol(loanAmountPreFee)} SOL*`,
      "",
      "_Same setup as your last loan. Confirm or cancel._",
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

export function registerReborrowCallbacks(bot) {
  bot.callbackQuery("reborrow:cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Re-borrow cancelled.");
  });

  bot.callbackQuery(/^reborrow:confirm:(.+):(\d+):(\d+):(\d+)$/, async (ctx) => {
    const [, mint, rawStr, optionStr, valueStr] = ctx.match;
    const collateralRaw = BigInt(rawStr);
    const option = Number(optionStr);
    const quotedValue = Number(valueStr);
    const tier = LTV_TIERS.find((t) => t.option === option) || LTV_TIERS[2];

    const user = await upsertUser(ctx.from.id, ctx.from.username);

    await ctx.answerCallbackQuery();

    // Re-verify price
    await ctx.editMessageText("⏳ Verifying price...");

    const balances = await getSupportedBalances(
      (await ensureWallet(user.id)).publicKey,
    );
    const tokenInfo = balances.find((b) => b.mint === mint);
    if (!tokenInfo) {
      return ctx.editMessageText("❌ Token no longer in wallet. Use /borrow instead.");
    }

    let currentValue;
    try {
      currentValue = await collateralValueLamports(mint, collateralRaw, tokenInfo.decimals);
    } catch {
      return ctx.editMessageText("❌ Price unavailable. Try /borrow instead.");
    }

    const drift = Math.abs(currentValue - quotedValue) / quotedValue * 100;
    if (drift > 2) {
      return ctx.editMessageText(
        `⚠️ Price moved ${drift.toFixed(1)}% since quote. Run /reborrow for a fresh quote.`,
      );
    }

    // Loan limit check
    const loanAmount = Math.floor((currentValue * tier.ltv) / 100);
    const limitCheck = await checkLoanLimits(user.id, loanAmount);
    if (!limitCheck.allowed) {
      return ctx.editMessageText(
        `⚠️ *Loan limit reached*\n\n${limitCheck.reason}`,
        { parse_mode: "Markdown" },
      );
    }

    await ctx.editMessageText("⏳ Submitting on-chain...");

    try {
      const result = await executeBorrow({
        userId: user.id,
        collateralMint: mint,
        collateralAmountRaw: collateralRaw,
        collateralValueLamports: currentValue,
        loanOption: option,
      });

      const fee = Math.floor((loanAmount * tier.feeBps) / 10_000);
      const loanAfterFee = loanAmount - fee;

      await recordLoan({
        userId: user.id,
        loanId: result.loanId,
        loanPda: result.loanPda,
        collateralMint: mint,
        collateralAmount: collateralRaw.toString(),
        loanAmountLamports: loanAfterFee.toString(),
        originalLoanAmountLamports: loanAmount.toString(),
        ltvPercentage: tier.ltv,
        durationDays: tier.days,
        txSignature: result.signature,
      });
      await incrementBorrowed(user.id, loanAmount);

      await ctx.editMessageText(
        [
          "✅ *Re-borrow funded*",
          "",
          `Received: *${fmtSol(loanAfterFee)} SOL*`,
          `Repay: *${fmtSol(loanAmount)} SOL*`,
          `Term: ${tier.days} days (${tier.label})`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
          "",
          "Use /positions to check status.",
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Reborrow failed:", err);
      const friendly = translateTxError(err, { flow: "reborrow" });
      await ctx.editMessageText(friendly, {
        parse_mode: "Markdown",
        reply_markup: errorActionKeyboard({ flow: "reborrow", errorKind: "tx_error" }),
      });
    }
  });
}
