/**
 * Database Health Monitor — alerts admin if DB becomes unreachable.
 *
 * Runs a SELECT 1 every 2 minutes. After 3 consecutive failures (6 min),
 * sends a Telegram alert. Sends a recovery alert when DB comes back.
 */
import { query } from "../db/pool.js";

const CHECK_INTERVAL_MS = 120_000; // 2 min
const FAILURES_TO_ALERT = 3;
const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;

let consecutiveFailures = 0;
let alertSent = false;
let lastDownAt = null;

async function tick(bot) {
  try {
    await query("SELECT 1");

    // DB is up
    if (alertSent && consecutiveFailures === 0) {
      // Already recovered, nothing to do
    } else if (alertSent) {
      // Was down, now recovered — send recovery alert
      const downMinutes = lastDownAt ? Math.round((Date.now() - lastDownAt) / 60_000) : "?";
      console.log(`[db-health] Database recovered after ~${downMinutes} min`);
      if (bot && ADMIN_TG_ID) {
        try {
          await bot.api.sendMessage(
            ADMIN_TG_ID,
            `*Database Recovered*\n\nPostgres is back online after ~${downMinutes} minutes of downtime.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* non-critical */ }
      }
      alertSent = false;
      lastDownAt = null;
    }
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    console.warn(`[db-health] DB check failed (${consecutiveFailures}/${FAILURES_TO_ALERT}): ${err.message}`);

    if (consecutiveFailures === 1) {
      lastDownAt = Date.now();
    }

    if (consecutiveFailures >= FAILURES_TO_ALERT && !alertSent) {
      alertSent = true;
      console.error(`[db-health] DATABASE DOWN — ${consecutiveFailures} consecutive failures`);
      if (bot && ADMIN_TG_ID) {
        try {
          await bot.api.sendMessage(
            ADMIN_TG_ID,
            `*DATABASE DOWN*\n\nPostgres has been unreachable for ${consecutiveFailures} consecutive checks (~${consecutiveFailures * 2} min).\n\nError: \`${err.message}\`\n\nThe site will serve cached data. Token screener, health monitor, and loans are paused until recovery.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* non-critical */ }
      }
    }
  }
}

export function startDbHealth(bot) {
  console.log(`[db-health] Database health monitor running (every ${CHECK_INTERVAL_MS / 1000}s)`);

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(bot);
    } catch (err) {
      console.error("[db-health] tick error:", err.message);
    } finally {
      running = false;
    }
  };

  // Run immediately
  run();
  return setInterval(run, CHECK_INTERVAL_MS);
}
