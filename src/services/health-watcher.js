/**
 * Progressive health-alert watcher.
 *
 * For every active loan, compute its current collateral-value-to-owed ratio.
 * When the ratio crosses a warning threshold downward for the first time, DM
 * the user with actionable context (repay button, add-collateral hint).
 *
 * Thresholds (descending): 1.3x (yellow), 1.2x (orange), 1.1x (red — imminent
 * liquidation). `loans.last_health_alert` stores the lowest threshold we've
 * already sent, so recovery + re-drop still produces a fresh alert only when
 * crossing a lower threshold we haven't warned about.
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { collateralValueLamports } from "./price.js";
import { getPrefs } from "./prefs.js";

const POLL_INTERVAL_MS = Number(process.env.HEALTH_WATCH_MS) || 120_000;

const THRESHOLDS = [
  { ratio: 1.3, emoji: "🟡", label: "Your loan health is getting tight." },
  { ratio: 1.2, emoji: "🟠", label: "Your loan is close to liquidation." },
  { ratio: 1.1, emoji: "🔴", label: "Imminent liquidation risk." },
];

function alertFor(ratio, lastAlertedAt) {
  // Pick the lowest threshold the loan is now under, that we haven't warned
  // the user about yet.
  for (const t of THRESHOLDS) {
    if (ratio < t.ratio) {
      if (lastAlertedAt == null || Number(lastAlertedAt) > t.ratio) {
        return t;
      }
    }
  }
  return null;
}

async function checkLoan(bot, row) {
  const decimals = row.decimals;
  if (decimals == null) return; // unsupported mint — can't price

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
  const ratio = valueLamports / owed;

  const alert = alertFor(ratio, row.last_health_alert);
  if (!alert) return;

  const prefs = await getPrefs(row.user_id);
  if (!prefs.notify_health) {
    // Respect opt-out, but still record the threshold crossing so we don't
    // spam later if they re-enable.
    await query(`UPDATE loans SET last_health_alert = $2 WHERE id = $1`, [
      row.id,
      alert.ratio,
    ]);
    return;
  }

  const kb = new InlineKeyboard()
    .text("🔧 Repay now", `repay:loan:${row.id}`)
    .text("➕ Top up", `topup:loan:${row.id}`)
    .row()
    .text("⏱ Extend", `extend:loan:${row.id}`);

  const msg = [
    `${alert.emoji} *Loan health alert*`,
    "",
    `${alert.label}`,
    "",
    `Loan #${row.loan_id} — health ${ratio.toFixed(2)}x`,
    `Collateral value: ${(valueLamports / 1e9).toFixed(4)} SOL`,
    `Owed: ${(owed / 1e9).toFixed(4)} SOL`,
    "",
    "Options: /repay · /partialrepay · /topup collateral · /extend",
  ].join("\n");

  try {
    await bot.api.sendMessage(row.telegram_id, msg, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    await query(`UPDATE loans SET last_health_alert = $2 WHERE id = $1`, [
      row.id,
      alert.ratio,
    ]);
  } catch (err) {
    console.error(`[health-watcher] DM failed for loan ${row.loan_id}: ${err.message}`);
  }
}

export function startHealthWatcher(bot) {
  console.log(`🩺 Health watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await query(
        `SELECT l.id, l.loan_id, l.user_id, l.collateral_mint, l.collateral_amount,
                l.original_loan_amount_lamports, l.last_health_alert,
                u.telegram_id, sm.decimals
         FROM loans l
         JOIN users u ON u.id = l.user_id
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
         WHERE l.status = 'active'`,
      );
      // Serialise per-loan checks so we don't hammer the price API.
      for (const row of rows) {
        await checkLoan(bot, row);
      }
    } catch (err) {
      console.error("[health-watcher] cycle error:", err.message);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
