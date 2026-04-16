import { query } from "../db/pool.js";
import { upsertUser } from "../services/users.js";

function formatSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function timeLeft(due) {
  const ms = new Date(due).getTime() - Date.now();
  if (ms <= 0) return "⚠️ PAST DUE";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h left`;
  return `${hours}h left`;
}

export async function handlePositions(ctx) {
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
    return ctx.reply("📭 No active loans.\n\nUse /borrow to take one out.");
  }

  const lines = ["📊 *Your Active Loans*", ""];
  for (const loan of rows) {
    lines.push(
      `*Loan #${loan.loan_id}* — ${loan.symbol ?? "Unknown"}`,
      `Collateral: ${loan.collateral_amount}`,
      `Borrowed: ${formatSol(loan.loan_amount_lamports)} SOL`,
      `Repay: ${formatSol(loan.original_loan_amount_lamports)} SOL`,
      `LTV: ${loan.ltv_percentage}% | ${loan.duration_days}d term`,
      `⏱ ${timeLeft(loan.due_timestamp)}`,
      "",
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
