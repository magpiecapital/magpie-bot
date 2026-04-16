import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";
import { getSolBalance } from "../services/deposits.js";
import { executePartialRepay, recordPartialRepay } from "../services/loans.js";

const pending = new Map();

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handlePartialRepay(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT l.*, sm.symbol
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply("📭 No active loans.");
  }

  const kb = new InlineKeyboard();
  for (const loan of rows) {
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · owe ${fmtSol(loan.original_loan_amount_lamports)} SOL`,
      `prepay:loan:${loan.id}`,
    ).row();
  }
  kb.text("✕ Cancel", "prepay:cancel");

  await ctx.reply(
    "*Partial repay* (collateral stays locked until full payoff)\n\nPick a loan:",
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

export function registerPartialRepayCallbacks(bot) {
  bot.callbackQuery(/^prepay:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Partial repay cancelled.");
  });

  bot.callbackQuery(/^prepay:loan:(\d+)$/, async (ctx) => {
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { publicKey } = await ensureWallet(user.id);

    const { rows } = await query(
      `SELECT l.*, sm.symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.id = $1 AND l.user_id = $2 AND l.status = 'active'`,
      [loanDbId, user.id],
    );
    const loan = rows[0];
    if (!loan) {
      await ctx.answerCallbackQuery("Loan not found");
      return;
    }

    const sol = await getSolBalance(publicKey);
    // Reserve ~0.003 SOL for fees + rent.
    const available = Math.max(0, sol - 3_000_000);
    const owed = BigInt(loan.original_loan_amount_lamports);

    if (available <= 0) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `📭 Not enough SOL in wallet.\n\nDeposit SOL to:\n\`${publicKey}\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    pending.set(ctx.chat.id, { userId: user.id, loan, available, owed });

    const kb = new InlineKeyboard()
      .text("25%", "prepay:pct:25").text("50%", "prepay:pct:50")
      .text("75%", "prepay:pct:75")
      .row().text("✕ Cancel", "prepay:cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
        `Owed: ${fmtSol(owed)} SOL`,
        `Wallet: ${fmtSol(sol)} SOL (usable ~${fmtSol(available)})`,
        "",
        "*How much of the loan to pay down?*",
        "_(partial — must be less than total owed; use /repay for full)_",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^prepay:pct:(\d+)$/, async (ctx) => {
    const pct = Number(ctx.match[1]);
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }

    // Pay down `pct`% of what's owed — capped at (owed - 1 lamport) and available.
    let repayLamports = (state.owed * BigInt(pct)) / 100n;
    const cap = state.owed - 1n; // program requires amount < original_loan_amount
    if (repayLamports > cap) repayLamports = cap;
    if (repayLamports > BigInt(state.available)) repayLamports = BigInt(state.available);

    if (repayLamports <= 0n) {
      await ctx.answerCallbackQuery("Amount too small");
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⏳ Submitting partial repay on-chain...");

    try {
      const result = await executePartialRepay({
        userId: state.userId,
        loanDbRow: state.loan,
        repayLamports,
      });
      await recordPartialRepay(state.loan.id, repayLamports);

      pending.delete(ctx.chat.id);

      const remaining = state.owed - repayLamports;
      await ctx.editMessageText(
        [
          "✅ *Partial repay submitted*",
          "",
          `Paid: ${fmtSol(repayLamports)} SOL`,
          `Remaining: ${fmtSol(remaining)} SOL`,
          "Collateral remains locked until full payoff.",
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Partial repay failed:", err);
      await ctx.editMessageText(
        `❌ Partial repay failed: ${err.message || "unknown error"}`,
      );
    }
  });
}
