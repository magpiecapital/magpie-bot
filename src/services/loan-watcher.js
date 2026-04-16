/**
 * Loan-health watcher.
 *
 * Sends a one-time DM warning to borrowers when any active loan is within 24h
 * of expiry. The `warned_24h_at` column is set atomically so we never send
 * two warnings for the same loan.
 */
import { query } from "../db/pool.js";

const POLL_INTERVAL_MS = Number(process.env.LOAN_WATCH_MS) || 60_000;

async function tick(bot) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.due_timestamp, l.collateral_mint,
            l.original_loan_amount_lamports,
            u.telegram_id
     FROM loans l JOIN users u ON u.id = l.user_id
     WHERE l.status = 'active'
       AND l.warned_24h_at IS NULL
       AND l.due_timestamp <= NOW() + INTERVAL '24 hours'
       AND l.due_timestamp > NOW()`,
  );

  for (const row of rows) {
    const hours = Math.max(
      0,
      Math.round((new Date(row.due_timestamp).getTime() - Date.now()) / 3_600_000),
    );
    const solOwed = Number(row.original_loan_amount_lamports) / 1e9;
    const msg = [
      "⚠️ *Loan due soon*",
      "",
      `Loan #${row.loan_id} is due in ~${hours}h.`,
      `Repay *${solOwed.toFixed(4)} SOL* with /repay or it will be liquidated.`,
    ].join("\n");

    try {
      await bot.api.sendMessage(row.telegram_id, msg, { parse_mode: "Markdown" });
      await query(`UPDATE loans SET warned_24h_at = NOW() WHERE id = $1`, [row.id]);
    } catch (err) {
      console.error(`[loan-watcher] DM failed for loan ${row.loan_id}: ${err.message}`);
    }
  }
}

export function startLoanWatcher(bot) {
  console.log(`⏰ Loan watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);
  const run = () => tick(bot).catch((err) => console.error("[loan-watcher]", err));
  run();
  return setInterval(run, POLL_INTERVAL_MS);
}
