import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { executeRepay, markLoanRepaid } from "../services/loans.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleRepay(ctx) {
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
    return ctx.reply("📭 No active loans to repay.");
  }

  const kb = new InlineKeyboard();
  for (const loan of rows) {
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · ${fmtSol(loan.original_loan_amount_lamports)} SOL`,
      `repay:loan:${loan.id}`,
    ).row();
  }
  kb.text("✕ Cancel", "repay:cancel");

  await ctx.reply("*Pick a loan to repay:*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

export function registerRepayCallbacks(bot) {
  bot.callbackQuery(/^repay:cancel$/, async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Repay cancelled.");
  });

  bot.callbackQuery(/^repay:loan:(\d+)$/, async (ctx) => {
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);

    const { rows } = await query(
      `SELECT l.*, sm.symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.id = $1 AND l.user_id = $2 AND l.status = 'active'`,
      [loanDbId, user.id],
    );
    const loan = rows[0];
    if (!loan) {
      await ctx.answerCallbackQuery("Loan not found or already closed");
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⏳ Submitting repayment on-chain...");

    try {
      const result = await executeRepay({ userId: user.id, loanDbRow: loan });
      await markLoanRepaid(loan.id, result.signature);

      await ctx.editMessageText(
        [
          "✅ *Loan repaid*",
          "",
          `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
          `Repaid: ${fmtSol(loan.original_loan_amount_lamports)} SOL`,
          "Collateral returned to your wallet.",
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Repay failed:", err);
      await ctx.editMessageText(
        `❌ Repay failed: ${err.message || "unknown error"}\n\nTry /repay again.`,
      );
    }
  });
}
