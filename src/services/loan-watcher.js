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

// Format a deep-link to the user's dashboard view of a specific loan.
// The dashboard route accepts ?loan=<chain_loan_id> and scrolls/focuses
// the matching card so the user lands directly on the action surface.
const DASHBOARD_LOAN_BASE = process.env.DASHBOARD_LOAN_BASE
  || "https://magpie.capital/dashboard?loan=";

function fmtWallet(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function warn24h(bot) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.user_id, l.due_timestamp,
            l.original_loan_amount_lamports,
            l.borrower_wallet,
            u.telegram_id
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
    const loanLink = `${DASHBOARD_LOAN_BASE}${row.loan_id}`;
    const walletShort = fmtWallet(row.borrower_wallet);
    const msg = [
      "⚠️ *Loan due soon*",
      "",
      `Loan [#${row.loan_id}](${loanLink}) is due in ~${hours}h.`,
      `Wallet: \`${walletShort}\``,
      `Repay *${solOwed.toFixed(4)} SOL* to reclaim your collateral.`,
      "",
      `Tap the loan number above to open it in the dashboard, or use the buttons below.`,
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("⏱ Extend", `extend:loan:${row.id}`)
      .row()
      .url("📋 Open loan in dashboard", loanLink);

    try {
      await bot.api.sendMessage(row.telegram_id, msg, {
        parse_mode: "Markdown",
        reply_markup: kb,
        disable_web_page_preview: true,
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
            l.original_loan_amount_lamports,
            l.borrower_wallet,
            u.telegram_id
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
    const loanLink = `${DASHBOARD_LOAN_BASE}${row.loan_id}`;
    const walletShort = fmtWallet(row.borrower_wallet);
    const msg = [
      "🚨 *URGENT — Loan expiring soon*",
      "",
      `Loan [#${row.loan_id}](${loanLink}) is due in *${timeStr}*.`,
      `Wallet: \`${walletShort}\``,
      `Repay *${solOwed.toFixed(4)} SOL* NOW to save your collateral.`,
      "",
      "After the deadline your tokens will be liquidated. Tap the loan number above or use a button below.",
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("⏱ Extend", `extend:loan:${row.id}`)
      .row()
      .url("📋 Open loan in dashboard", loanLink);

    try {
      await bot.api.sendMessage(row.telegram_id, msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
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
