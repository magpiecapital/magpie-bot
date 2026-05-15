/**
 * Loan-deadline watcher.
 *
 * Sends DM warnings to borrowers at two checkpoints:
 *   - 24h before due → first warning (warned_24h_at)
 *   -  6h before due → urgent follow-up (warned_6h_at)
 *
 * Each warning is sent at most once per loan. Includes inline "Repay now"
 * button that piggybacks on the existing `/repay` callback-query handler.
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { getPrefs } from "./prefs.js";

const POLL_INTERVAL_MS = Number(process.env.LOAN_WATCH_MS) || 60_000;

async function warn24h(bot) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.user_id, l.due_timestamp,
            l.original_loan_amount_lamports, u.telegram_id
     FROM loans l JOIN users u ON u.id = l.user_id
     WHERE l.status = 'active'
       AND l.warned_24h_at IS NULL
       AND l.due_timestamp <= NOW() + INTERVAL '24 hours'
       AND l.due_timestamp > NOW()`,
  );

  for (const row of rows) {
    const prefs = await getPrefs(row.user_id);
    if (!prefs.notify_loan_warnings) {
      await query(`UPDATE loans SET warned_24h_at = NOW() WHERE id = $1`, [row.id]);
      continue;
    }

    const hours = Math.max(
      0,
      Math.round((new Date(row.due_timestamp).getTime() - Date.now()) / 3_600_000),
    );
    const solOwed = Number(row.original_loan_amount_lamports) / 1e9;
    const msg = [
      "⚠️ *Loan due soon*",
      "",
      `Loan #${row.loan_id} is due in ~${hours}h.`,
      `Repay *${solOwed.toFixed(4)} SOL* to reclaim your collateral.`,
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("⏱ Extend", `extend:loan:${row.id}`);

    try {
      await bot.api.sendMessage(row.telegram_id, msg, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
      await query(`UPDATE loans SET warned_24h_at = NOW() WHERE id = $1`, [row.id]);
    } catch (err) {
      console.error(`[loan-watcher] 24h DM failed for loan ${row.loan_id}: ${err.message}`);
    }
  }
}

async function warn6h(bot) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.user_id, l.due_timestamp,
            l.original_loan_amount_lamports, u.telegram_id
     FROM loans l JOIN users u ON u.id = l.user_id
     WHERE l.status = 'active'
       AND l.warned_6h_at IS NULL
       AND l.due_timestamp <= NOW() + INTERVAL '6 hours'
       AND l.due_timestamp > NOW()`,
  );

  for (const row of rows) {
    const prefs = await getPrefs(row.user_id);
    if (!prefs.notify_loan_warnings) {
      await query(`UPDATE loans SET warned_6h_at = NOW() WHERE id = $1`, [row.id]);
      continue;
    }

    const mins = Math.max(
      0,
      Math.round((new Date(row.due_timestamp).getTime() - Date.now()) / 60_000),
    );
    const solOwed = Number(row.original_loan_amount_lamports) / 1e9;
    const timeStr = mins >= 60 ? `${Math.round(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const msg = [
      "🚨 *URGENT — Loan expiring soon*",
      "",
      `Loan #${row.loan_id} is due in *${timeStr}*.`,
      `Repay *${solOwed.toFixed(4)} SOL* NOW to save your collateral.`,
      "",
      "After the deadline your tokens will be liquidated.",
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("⏱ Extend", `extend:loan:${row.id}`);

    try {
      await bot.api.sendMessage(row.telegram_id, msg, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
      await query(`UPDATE loans SET warned_6h_at = NOW() WHERE id = $1`, [row.id]);
    } catch (err) {
      console.error(`[loan-watcher] 6h DM failed for loan ${row.loan_id}: ${err.message}`);
    }
  }
}

async function tick(bot) {
  await warn24h(bot);
  await warn6h(bot);
}

export function startLoanWatcher(bot) {
  console.log(`⏰ Loan watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);
  const run = () => tick(bot).catch((err) => console.error("[loan-watcher]", err));
  run();
  return setInterval(run, POLL_INTERVAL_MS);
}
