import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";
import { getSolBalance } from "../services/deposits.js";
import { executeExtendLoan, recordExtendLoan } from "../services/loans.js";

const pending = new Map();

// Map LTV percentage to tier fee in basis points
function feeBpsForLtv(ltv) {
  if (ltv >= 30) return 300n;  // Express
  if (ltv >= 25) return 200n;  // Quick
  return 150n;                 // Standard
}

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleExtend(ctx) {
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
    const bps = feeBpsForLtv(loan.ltv_percentage);
    const fee = (BigInt(loan.original_loan_amount_lamports) * bps) / 10_000n;
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · fee ${fmtSol(fee)} SOL`,
      `extend:loan:${loan.id}`,
    ).row();
  }
  kb.text("✕ Cancel", "extend:cancel");

  await ctx.reply(
    "*Extend loan* — adds the original duration for the tier fee.\n\nPick a loan:",
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

export function registerExtendCallbacks(bot) {
  bot.callbackQuery(/^extend:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Extend cancelled.");
  });

  bot.callbackQuery(/^extend:loan:(\d+)$/, async (ctx) => {
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

    const bps = feeBpsForLtv(loan.ltv_percentage);
    const fee = (BigInt(loan.original_loan_amount_lamports) * bps) / 10_000n;
    const sol = await getSolBalance(publicKey);

    // Need enough SOL to cover fee + ~0.003 SOL buffer for tx + rent.
    if (BigInt(sol) < fee + 3_000_000n) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        [
          `❌ Insufficient SOL for extension fee.`,
          ``,
          `Needed: ~${fmtSol(fee + 3_000_000n)} SOL`,
          `Wallet: ${fmtSol(sol)} SOL`,
          ``,
          `Deposit SOL to:`,
          `\`${publicKey}\``,
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
      return;
    }

    pending.set(ctx.chat.id, { userId: user.id, loan, fee });

    const wasDue = new Date(loan.due_timestamp) < new Date();
    const newDue = wasDue
      ? new Date(Date.now() + loan.duration_days * 86400_000)
      : new Date(new Date(loan.due_timestamp).getTime() + loan.duration_days * 86400_000);

    const kb = new InlineKeyboard()
      .text("✅ Confirm extension", `extend:confirm:${loan.id}`)
      .row().text("✕ Cancel", "extend:cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `*Extend loan #${loan.loan_id}*`,
        `Symbol: ${loan.symbol ?? "?"}`,
        `Extension fee: *${fmtSol(fee)} SOL* (${Number(bps) / 100}%)`,
        `New due: ${newDue.toUTCString()}`,
        wasDue ? "_(loan was past due — clock resets from now)_" : "",
        "",
        "Confirm to pay the fee and extend.",
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^extend:confirm:(\d+)$/, async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⏳ Extending loan on-chain...");

    try {
      const result = await executeExtendLoan({
        userId: state.userId,
        loanDbRow: state.loan,
      });
      await recordExtendLoan(state.loan.id);

      pending.delete(ctx.chat.id);

      await ctx.editMessageText(
        [
          "✅ *Loan extended*",
          "",
          `Fee paid: ${fmtSol(result.feeLamports)} SOL`,
          `Loan #${state.loan.loan_id} extended by ${state.loan.duration_days} days.`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
          "",
          "Use /positions for updated status.",
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Extend failed:", err);
      await ctx.editMessageText(
        `❌ Extend failed: ${err.message || "unknown error"}`,
      );
    }
  });
}
