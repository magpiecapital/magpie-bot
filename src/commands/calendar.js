/**
 * /calendar — chronological view of all the user's active loans
 * sorted by due date. One screen, full mental model.
 *
 * Health rendered as plain-text labels (no emojis per the standing rule).
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { collateralValueLamports } from "../services/price.js";
import { getLiveOwedLamports } from "../services/loans.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";
import {
  formatLoanCard,
  totalOwedSol,
  countDueWithin,
} from "../services/loan-display.js";

export async function handleCalendar(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows: rawRows } = await query(
    `SELECT l.id, l.loan_id, l.loan_pda, l.collateral_mint, l.collateral_amount,
            l.original_loan_amount_lamports, l.loan_amount_lamports, l.due_timestamp,
            l.ltv_percentage, l.duration_days,
            sm.symbol, sm.decimals
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );
  // Scope to active wallet — calendar of every linked wallet's loans
  // would mix in things the user can't act on from the current signer.
  const { filtered: rows, otherWalletCount } = await scopeLoansToActiveWallet(user.id, rawRows);

  if (rows.length === 0) {
    return ctx.reply(
      [
        "*Loan Calendar*",
        "",
        otherWalletCount > 0
          ? `No active loans on your current wallet.\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch.`
          : "No active loans. Use /borrow to take one out.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // Compute live owed + health for each loan in parallel
  const enriched = await Promise.all(rows.map(async (r) => {
    let liveOwed = null;
    let healthRatio = null;
    let currentLamports = null;
    try {
      liveOwed = await getLiveOwedLamports(r);
    } catch { /* fall through to DB */ }
    const owed = liveOwed ?? BigInt(r.original_loan_amount_lamports ?? "0");
    try {
      if (r.decimals != null && owed > 0n) {
        currentLamports = await collateralValueLamports(
          r.collateral_mint,
          r.collateral_amount,
          r.decimals,
        );
        healthRatio = Number(currentLamports) / Number(owed);
      }
    } catch { /* skip health if price feed blips */ }
    return { ...r, liveOwed: owed, currentLamports, healthRatio };
  }));

  const totalSol = totalOwedSol(enriched.map((l) => l.liveOwed));
  const dueSoonCount = countDueWithin(enriched, 24);
  const summary = [
    `${enriched.length} active`,
    `${totalSol} SOL owed`,
  ];
  if (dueSoonCount > 0) summary.push(`${dueSoonCount} due within 24h`);

  const lines = [
    "*Loan Calendar*",
    `_${summary.join(" · ")} · sorted by due date_`,
    "",
  ];

  for (let i = 0; i < enriched.length; i++) {
    const loan = enriched[i];
    const card = formatLoanCard(loan, {
      owedLamports: loan.liveOwed,
      healthRatio: loan.healthRatio,
      collateralValueLamports: loan.currentLamports,
      position: i + 1,
    });
    lines.push(card, "");
  }

  // Inline action buttons for the first few loans
  const kb = new InlineKeyboard();
  for (let i = 0; i < Math.min(3, enriched.length); i++) {
    const l = enriched[i];
    kb.text(`Manage ${l.symbol ?? "?"} (${i + 1})`, `calendar:loan:${l.id}`).row();
  }
  if (enriched.length > 0) {
    lines.push("_Tap a loan below for repay / topup / extend, or use /repay /topup /extend directly._");
  }
  if (otherWalletCount > 0) {
    lines.push("", `_+${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch._`);
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

export function registerCalendarCallbacks(bot) {
  bot.callbackQuery(/^calendar:loan:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const loanId = Number(ctx.match[1]);
    const kb = new InlineKeyboard()
      .text("Repay", `repay:loan:${loanId}`)
      .text("Top up", `topup:loan:${loanId}`)
      .row()
      .text("Extend", `extend:loan:${loanId}`)
      .text("Partial repay", `partialrepay:loan:${loanId}`);
    await ctx.reply(`*Loan management actions:*`, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  });
}
