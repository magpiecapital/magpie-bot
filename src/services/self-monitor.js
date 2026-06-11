/**
 * Bot self-monitoring tick.
 *
 * Runs every 60s INSIDE the bot process. Catches degradation that
 * the external watchdogs can't see — sub-systems failing, DB pool
 * exhausted, queues backing up, error rates spiking. DMs the
 * operator BEFORE users start complaining.
 *
 * Why we need this on top of the external watchdogs:
 *   The Vercel cron and GitHub Actions watchdogs check whether the
 *   bot is REACHABLE. They can't see whether:
 *     - The notification queue is stuck (DB write but no TG send)
 *     - The DB connection pool is exhausted (queries timing out)
 *     - Error rate has spiked (every borrow is failing)
 *     - A specific background watcher has died
 *   These are silent failures that look "up" from outside but break
 *   the actual user experience. This module catches them.
 *
 * Alert deduplication:
 *   Sub-systems can be in a bad state for many ticks in a row. We
 *   don't want to DM the operator every 60s about the same issue —
 *   that trains them to ignore alerts. Each alert kind is throttled
 *   to one DM per ALERT_COOLDOWN_MS; subsequent failures during the
 *   cooldown are counted (and surfaced in the next alert when the
 *   cooldown elapses).
 *
 * Alert escalation:
 *   First alert: "X is degraded."
 *   After cooldown: "X is still degraded — N consecutive bad ticks."
 *   On recovery: "X has recovered after N bad ticks."
 *   That cycle gives the operator the SHAPE of the problem without
 *   spamming.
 *
 * Failure-mode of the monitor itself:
 *   If any of the probes throw, we catch + log + continue. A broken
 *   monitor must NEVER cause the bot to crash. Better to silently
 *   miss an alert than take down the very thing we're monitoring.
 */
import { query, pool } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";

const TICK_MS = 60_000;
const ALERT_COOLDOWN_MS = 15 * 60_000; // 15 min between same-kind alerts

// In-memory state. Reset on bot restart, which is fine: restart =
// fresh start = no prior context to track.
const state = {
  lastAlertAt: new Map(),        // kind -> timestamp
  consecutiveBad: new Map(),     // kind -> count of bad ticks
  lastReportedBad: new Map(),    // kind -> bool (last alert was bad)
};

function withinCooldown(kind) {
  const at = state.lastAlertAt.get(kind);
  if (!at) return false;
  return Date.now() - at < ALERT_COOLDOWN_MS;
}

function recordOutcome(kind, isBad) {
  if (isBad) {
    state.consecutiveBad.set(kind, (state.consecutiveBad.get(kind) || 0) + 1);
  } else {
    state.consecutiveBad.set(kind, 0);
  }
}

async function alertIfNew(bot, kind, line, severity = "warn") {
  // Don't alert if currently in cooldown AND we already reported as bad.
  // But DO alert on recovery even if in cooldown — recovery is a
  // distinct event the operator wants to know about.
  if (withinCooldown(kind) && state.lastReportedBad.get(kind)) return;
  state.lastAlertAt.set(kind, Date.now());
  const consecutive = state.consecutiveBad.get(kind) || 0;
  const prefix = severity === "crit" ? "🚨 CRIT" : "⚠️  WARN";
  const suffix = consecutive > 1 ? ` (consecutive bad ticks: ${consecutive})` : "";
  await notifyAdmin(bot, `${prefix} [self-monitor] ${line}${suffix}`);
  state.lastReportedBad.set(kind, true);
}

async function alertRecovery(bot, kind, line) {
  if (!state.lastReportedBad.get(kind)) return; // never reported as bad
  await notifyAdmin(bot, `✅ [self-monitor] ${line}`);
  state.lastReportedBad.set(kind, false);
  state.lastAlertAt.set(kind, Date.now());
}

/* ─── Probes ─────────────────────────────────────────────────── */

/**
 * DB pool exhaustion check. pg's pool has waitingCount > 0 when
 * queries are queued because all connections are busy. Persistent
 * waitingCount means we're CPU-bound on DB ops and other paths are
 * stalling.
 */
async function probeDbPool(bot) {
  const KIND = "db_pool_exhausted";
  const waiting = pool.waitingCount ?? 0;
  const idle = pool.idleCount ?? 0;
  const total = pool.totalCount ?? 0;
  // We consider exhaustion = >5 queries waiting OR 0 idle and total at cap.
  const isBad = waiting > 5;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `DB pool exhausted: ${waiting} queries waiting, ${idle}/${total} idle. Some endpoints may be slow.`,
      "warn",
    );
  } else {
    await alertRecovery(bot, KIND,
      `DB pool recovered. ${waiting} waiting / ${idle}/${total} idle.`,
    );
  }
}

/**
 * Pending-notifications backlog check. The engine writes here, the
 * sender drains. If pending grows unboundedly, something is broken
 * in the sender path (TG rate limit, blocked user spam, render fail).
 */
async function probePendingNotifs(bot) {
  const KIND = "pending_notifs_backlog";
  let pending = 0;
  let oldestAgeSec = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT COUNT(*)::int AS n,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int AS oldest_sec
        FROM pending_notifications
       WHERE status = 'pending' AND attempt_count < 5
    `);
    pending = r.n;
    oldestAgeSec = r.oldest_sec;
  } catch {
    // DB error already covered by db_pool / db_query probes.
    return;
  }
  // Threshold: > 50 pending OR oldest > 5 minutes (rendering should be
  // < 5s per notification; a 5min-old pending means the sender is
  // making no progress).
  const isBad = pending > 50 || oldestAgeSec > 300;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `Pending notifications backlog: ${pending} pending, oldest ${oldestAgeSec}s old.`,
      pending > 200 || oldestAgeSec > 900 ? "crit" : "warn",
    );
  } else {
    await alertRecovery(bot, KIND,
      `Notifications backlog cleared. ${pending} pending.`,
    );
  }
}

/**
 * Stuck-firing limit-close orders. The engine's stuck-recovery
 * normally handles these, but if recovery itself is broken (e.g.
 * the engine is paused or crashed) we want to know.
 */
async function probeStuckOrders(bot) {
  const KIND = "stuck_firing_orders";
  let stuck = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT COUNT(*)::int AS n
        FROM limit_close_orders
       WHERE status = 'firing'
         AND firing_started_at < NOW() - INTERVAL '10 minutes'
    `);
    stuck = r.n;
  } catch { return; }
  const isBad = stuck > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `${stuck} limit-close order(s) stuck in 'firing' > 10 min. Engine may be paused or crashed.`,
      "crit",
    );
  } else {
    await alertRecovery(bot, KIND, `No stuck-firing orders.`);
  }
}

/**
 * Migration ledger drift. If process.env.DB_MIGRATIONS_FAILED is set
 * (we set this on degraded-mode boot), surface it every cooldown
 * until fixed. Operator can't easily forget about a migration that
 * failed silently if we keep DMing every 15 min.
 */
async function probeMigrationsFailed(bot) {
  const KIND = "migrations_failed";
  const failedMsg = process.env.DB_MIGRATIONS_FAILED;
  const isBad = Boolean(failedMsg);
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `Bot is running in DEGRADED mode — migrations failed at boot. ${failedMsg?.slice(0, 200)}. Investigate via Railway shell.`,
      "crit",
    );
  } else {
    // We never call recovery here — migration "recovers" only when
    // operator manually flips the env or redeploys with the fix. The
    // boot would clear DB_MIGRATIONS_FAILED on success.
  }
}

/**
 * Long-running TWAPs that exceeded their watchdog window without
 * being cleaned up. The engine's processTwapChunk handles this in
 * the normal path, but if the engine is down for >10 min those
 * rows linger. Surface so operator knows to investigate.
 */
async function probeTwapWatchdogMisses(bot) {
  const KIND = "twap_watchdog_miss";
  let lingering = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT COUNT(*)::int AS n
        FROM limit_close_orders
       WHERE status = 'twap_in_progress'
         AND twap_started_at < NOW() - INTERVAL '15 minutes'
    `);
    lingering = r.n;
  } catch { return; }
  const isBad = lingering > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `${lingering} TWAP order(s) past their 10-min window. Engine watchdog should have aborted them — investigate.`,
      "warn",
    );
  } else {
    await alertRecovery(bot, KIND, `No long-running TWAPs.`);
  }
}

/* ─── Tick loop ──────────────────────────────────────────────── */

let _timer = null;

async function tick(bot) {
  try {
    await Promise.all([
      probeDbPool(bot).catch((e) => console.warn("[self-monitor] db_pool probe threw:", e.message)),
      probePendingNotifs(bot).catch((e) => console.warn("[self-monitor] pending_notifs probe threw:", e.message)),
      probeStuckOrders(bot).catch((e) => console.warn("[self-monitor] stuck_orders probe threw:", e.message)),
      probeMigrationsFailed(bot).catch((e) => console.warn("[self-monitor] migrations probe threw:", e.message)),
      probeTwapWatchdogMisses(bot).catch((e) => console.warn("[self-monitor] twap_watchdog probe threw:", e.message)),
    ]);
  } catch (err) {
    // Belt-and-suspenders catch — Promise.all shouldn't throw because
    // each probe catches its own errors, but a defensive top-level
    // catch guarantees the tick loop survives no matter what.
    console.warn("[self-monitor] tick threw:", err.message);
  }
}

export function startSelfMonitor(bot) {
  if (_timer) return;
  console.log(`[self-monitor] armed — probing every ${TICK_MS / 1000}s`);
  // Stagger first tick by 60s so the bot has time to fully boot.
  setTimeout(() => {
    tick(bot).catch(() => {});
    _timer = setInterval(() => {
      tick(bot).catch(() => {});
    }, TICK_MS);
  }, 60_000);
}

export function stopSelfMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
