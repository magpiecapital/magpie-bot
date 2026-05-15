/**
 * Pump watcher — notifies borrowers when their collateral value increases
 * significantly relative to what they owe.
 *
 * Checks active loans periodically. When collateral value reaches 2x or 3x
 * the owed amount (and we haven't already notified at that level), sends a
 * positive DM encouraging the user to take action.
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { collateralValueLamports } from "./price.js";
import { getPrefs } from "./prefs.js";

const POLL_INTERVAL_MS = Number(process.env.PUMP_WATCH_MS) || 300_000; // 5 min

// Multipliers at which we notify (ascending)
const PUMP_THRESHOLDS = [
  { multiple: 2.0, emoji: "📈", label: "Your collateral is now worth *2x* what you owe!" },
  { multiple: 3.0, emoji: "🚀", label: "Your collateral is now worth *3x* what you owe!" },
  { multiple: 5.0, emoji: "🔥", label: "Your collateral is now worth *5x* what you owe!" },
];

async function checkLoan(bot, row) {
  const decimals = row.decimals;
  if (decimals == null) return;

  let valueLamports;
  try {
    valueLamports = await collateralValueLamports(
      row.collateral_mint,
      row.collateral_amount,
      decimals,
    );
  } catch {
    return;
  }

  const owed = Number(row.original_loan_amount_lamports);
  if (owed <= 0) return;
  const multiple = valueLamports / owed;
  const lastAlerted = Number(row.last_pump_alert_value) || 0;

  // Find the highest threshold crossed that we haven't notified about yet
  let bestThreshold = null;
  for (const t of PUMP_THRESHOLDS) {
    if (multiple >= t.multiple && t.multiple > lastAlerted) {
      bestThreshold = t;
    }
  }

  if (!bestThreshold) return;

  const prefs = await getPrefs(row.user_id);
  if (!prefs.notify_health) {
    await query(
      `UPDATE loans SET last_pump_alert_value = $2 WHERE id = $1`,
      [row.id, bestThreshold.multiple],
    );
    return;
  }

  const valueSol = (valueLamports / 1e9).toFixed(4);
  const owedSol = (owed / 1e9).toFixed(4);
  const msg = [
    `${bestThreshold.emoji} *Your bag is pumping!*`,
    "",
    bestThreshold.label,
    "",
    `Collateral value: *${valueSol} SOL*`,
    `You owe: *${owedSol} SOL*`,
    "",
    "Repay now to reclaim your tokens while they're up, or take out another loan against a different bag.",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("🔧 Repay now", `repay:loan:${row.id}`)
    .text("💰 Borrow more", "start:borrow");

  try {
    await bot.api.sendMessage(row.telegram_id, msg, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    await query(
      `UPDATE loans SET last_pump_alert_value = $2 WHERE id = $1`,
      [row.id, bestThreshold.multiple],
    );
  } catch (err) {
    console.error(`[pump-watcher] DM failed for loan ${row.loan_id}: ${err.message}`);
  }
}

export function startPumpWatcher(bot) {
  console.log(`📈 Pump watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await query(
        `SELECT l.id, l.loan_id, l.user_id, l.collateral_mint, l.collateral_amount,
                l.original_loan_amount_lamports, l.last_pump_alert_value,
                u.telegram_id, sm.decimals
         FROM loans l
         JOIN users u ON u.id = l.user_id
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
         WHERE l.status = 'active'`,
      );
      for (const row of rows) {
        await checkLoan(bot, row);
      }
    } catch (err) {
      console.error("[pump-watcher] cycle error:", err.message);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
