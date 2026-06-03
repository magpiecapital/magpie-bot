import { query } from "../db/pool.js";
import { upsertUser } from "../services/users.js";
import { collateralValueLamports } from "../services/price.js";
import { getLiveOwedLamports } from "../services/loans.js";

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

function healthEmoji(ratio) {
  if (ratio >= 1.5) return "🟢";
  if (ratio >= 1.2) return "🟡";
  if (ratio >= 1.1) return "🟠";
  return "🔴";
}

async function enrichWithHealth(loan, owedLamports) {
  try {
    const { rows } = await query(
      `SELECT decimals FROM supported_mints WHERE mint = $1`,
      [loan.collateral_mint],
    );
    if (!rows[0]) return null;
    const currentLamports = await collateralValueLamports(
      loan.collateral_mint,
      loan.collateral_amount,
      rows[0].decimals,
    );
    const owed = Number(owedLamports ?? loan.original_loan_amount_lamports);
    const ratio = owed > 0 ? currentLamports / owed : 0;
    return { currentLamports, ratio };
  } catch {
    return null;
  }
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

  // Fetch live on-chain amount first, then use it for health calc.
  const liveAmounts = await Promise.all(rows.map(getLiveOwedLamports));
  const healthResults = await Promise.all(
    rows.map((loan, i) => enrichWithHealth(loan, liveAmounts[i])),
  );

  const lines = ["📊 *Your Active Loans*", ""];
  for (let i = 0; i < rows.length; i++) {
    const loan = rows[i];
    const health = healthResults[i];
    const owed = liveAmounts[i];
    lines.push(
      `*Loan #${loan.loan_id}* — ${loan.symbol ?? "Unknown"}`,
      `Collateral: ${loan.collateral_amount}`,
      `Borrowed: ${formatSol(loan.loan_amount_lamports)} SOL`,
      `Repay: ${formatSol(owed)} SOL`,
      `LTV: ${loan.ltv_percentage}% | ${loan.duration_days}d term`,
    );
    if (health) {
      lines.push(
        `${healthEmoji(health.ratio)} Health: ${health.ratio.toFixed(2)}x ` +
          `(collateral now ${formatSol(health.currentLamports)} SOL)`,
      );
    }
    lines.push(`⏱ ${timeLeft(loan.due_timestamp)}`, "");
  }
  lines.push(
    "_Health <1.1x risks liquidation._",
    "",
    "Actions: /repay · /partialrepay · /topup · /extend",
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
