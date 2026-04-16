import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";
import { getTokenBalance } from "../services/deposits.js";
import { executeAddCollateral, recordAddCollateral } from "../services/loans.js";

const pending = new Map();

function fmtAmount(raw, decimals) {
  return Number(BigInt(raw)) / Math.pow(10, decimals);
}

export async function handleTopup(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT l.*, sm.symbol, sm.decimals
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply("📭 No active loans. Use /borrow to open one.");
  }

  const kb = new InlineKeyboard();
  for (const loan of rows) {
    const human = fmtAmount(loan.collateral_amount, loan.decimals ?? 9);
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · ${human.toLocaleString()}`,
      `topup:loan:${loan.id}`,
    ).row();
  }
  kb.text("✕ Cancel", "topup:cancel");

  await ctx.reply(
    "*Add collateral* (improves health ratio, no fee)\n\nPick a loan:",
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

export function registerTopupCallbacks(bot) {
  bot.callbackQuery(/^topup:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Top-up cancelled.");
  });

  bot.callbackQuery(/^topup:loan:(\d+)$/, async (ctx) => {
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { publicKey } = await ensureWallet(user.id);

    const { rows } = await query(
      `SELECT l.*, sm.symbol, sm.decimals
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

    const balance = await getTokenBalance(publicKey, loan.collateral_mint);
    if (!balance || BigInt(balance.rawAmount) === 0n) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `📭 No ${loan.symbol ?? "tokens"} in your wallet to add as collateral.\n\nDeposit to:\n\`${publicKey}\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    pending.set(ctx.chat.id, { userId: user.id, loan, balance });

    const kb = new InlineKeyboard()
      .text("25%", "topup:pct:25").text("50%", "topup:pct:50")
      .text("75%", "topup:pct:75").text("100%", "topup:pct:100")
      .row().text("✕ Cancel", "topup:cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
        `Current collateral: ${fmtAmount(loan.collateral_amount, loan.decimals ?? 9).toLocaleString()}`,
        `Wallet balance: ${balance.humanAmount.toLocaleString()} ${loan.symbol ?? ""}`,
        "",
        "*How much to add?*",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^topup:pct:(\d+)$/, async (ctx) => {
    const pct = Number(ctx.match[1]);
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired, run /topup again");
      return;
    }

    const rawBig = (BigInt(state.balance.rawAmount) * BigInt(pct)) / 100n;
    if (rawBig === 0n) {
      await ctx.answerCallbackQuery("Amount too small");
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⏳ Adding collateral on-chain...");

    try {
      const result = await executeAddCollateral({
        userId: state.userId,
        loanDbRow: state.loan,
        extraRawAmount: rawBig,
      });
      await recordAddCollateral(state.loan.id, rawBig);

      pending.delete(ctx.chat.id);

      const addedHuman = Number(rawBig) / Math.pow(10, state.loan.decimals ?? 9);
      await ctx.editMessageText(
        [
          "✅ *Collateral added*",
          "",
          `Added: ${addedHuman.toLocaleString()} ${state.loan.symbol ?? ""}`,
          `Loan #${state.loan.loan_id} health improved.`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
          "",
          "Use /positions to check status.",
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("Top-up failed:", err);
      await ctx.editMessageText(
        `❌ Top-up failed: ${err.message || "unknown error"}\n\nTry /topup again.`,
      );
    }
  });
}
