/**
 * Liquidation safety watchdog — the "keeper canary."
 * ─────────────────────────────────────────────────────────────────────────
 * READ-ONLY. Liquidates NOTHING. It watches for any ACTIVE loan that is past
 * its deadline (start_timestamp + duration_days) by more than a grace period
 * and has NOT been liquidated — i.e. the permissionless keeper (keeper.js,
 * "Liquidation Scavenger") is down / stalled / unfunded and bad debt is
 * starting to accrue — and DMs the operator.
 *
 * Why this exists: the liquidation EXECUTOR runs as a separate process from
 * the main bot. The post-liquidation services (economics / distribution /
 * collateral-sweeper) are wired in here, but nothing noticed if the executor
 * itself silently died. This closes that blind spot without ever touching
 * funds — the keeper's health becomes self-evident: silent = keeping up,
 * alarms = something's wrong. Overdue is Magpie's liquidation trigger, and
 * it's derived purely from the DB, so this is safe read-only.
 *
 * Env:
 *   LIQ_WATCHDOG_POLL_MS    — poll interval (default 10 min)
 *   LIQ_WATCHDOG_GRACE_MIN  — how far past due before alerting (default 15 min;
 *                             gives a healthy keeper ample time to fire)
 */
import { query } from "../db/pool.js";
import { notifyAdmin, getAdminId } from "./admin-notify.js";

const POLL_MS = Number(process.env.LIQ_WATCHDOG_POLL_MS) || 10 * 60_000;
const GRACE_MIN = Number(process.env.LIQ_WATCHDOG_GRACE_MIN) || 15;
const RE_ALERT_MS = 6 * 60 * 60_000; // re-DM at most every 6h while still overdue

const VERSION_LABELS = {
  "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh": "V1",
  "6wSpKAGuiRf3nYHj9raVwmoTPbG5MswBzTy6aMXZHBe": "V2",
  "B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP": "V3",
  "HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo": "V4",
};

// Anti-spam: dedupe on the set of overdue loan IDs; re-alert only when the set
// changes or 6h passes. An empty set (keeper caught up / loans repaid) clears it.
let lastAlertKey = null;
let lastAlertAt = 0;

async function tick(bot) {
  const adminId = getAdminId();
  if (!adminId || !bot) return;

  let rows;
  try {
    const r = await query(
      `SELECT id, program_id,
              EXTRACT(EPOCH FROM (NOW() - (start_timestamp + (duration_days || ' days')::interval)))::int
                AS overdue_secs
         FROM loans
        WHERE status = 'active'
          AND duration_days IS NOT NULL
          AND NOW() > start_timestamp + (duration_days || ' days')::interval
                       + ($1 || ' minutes')::interval
        ORDER BY overdue_secs DESC`,
      [GRACE_MIN],
    );
    rows = r.rows;
  } catch (err) {
    console.warn("[liq-watchdog] read failed:", err.message?.slice(0, 120));
    return;
  }

  if (!rows.length) {
    // Healthy — no active loan is meaningfully past due. Keeper is keeping up
    // (or nothing is due). Clear alert state so the next outage re-alarms.
    if (lastAlertKey !== null) console.log("[liq-watchdog] recovered — no overdue-unliquidated loans.");
    lastAlertKey = null;
    return;
  }

  const key = rows.map((x) => x.id).sort().join(",");
  const now = Date.now();
  if (key === lastAlertKey && now - lastAlertAt < RE_ALERT_MS) return; // already alerted, not time to re-DM

  const lines = rows.slice(0, 12).map((x) => {
    const v = VERSION_LABELS[x.program_id] || "?";
    const h = Math.floor((x.overdue_secs || 0) / 3600);
    return `  • loan ${x.id} (${v}) — overdue ${h}h`;
  });
  const more = rows.length > 12 ? `\n  …and ${rows.length - 12} more` : "";
  try {
    await notifyAdmin(
      bot,
      [
        `🔴 LIQUIDATION KEEPER CANARY`,
        `${rows.length} active loan(s) OVERDUE > ${GRACE_MIN}m and NOT liquidated.`,
        `The keeper (Liquidation Scavenger) may be down / stalled / unfunded — bad debt is starting to accrue.`,
        ``,
        lines.join("\n") + more,
        ``,
        `Action: check the keeper process + its wallet balance. (Verify these are genuinely liquidatable before acting.)`,
      ].join("\n"),
    );
    lastAlertKey = key;
    lastAlertAt = now;
    console.warn(`[liq-watchdog] ALERTED — ${rows.length} overdue-unliquidated loan(s).`);
  } catch (err) {
    console.warn("[liq-watchdog] alert DM failed:", err.message?.slice(0, 100));
  }
}

export function startLiquidationSafetyWatchdog(bot) {
  const run = () => tick(bot).catch((e) => console.warn("[liq-watchdog] tick error:", e.message));
  setTimeout(run, 60_000);        // first check ~1 min after boot (immediate ground-truth read)
  setInterval(run, POLL_MS);
  console.log(`[liq-watchdog] liquidation safety canary started (poll ${POLL_MS / 60000}m, grace ${GRACE_MIN}m).`);
}
