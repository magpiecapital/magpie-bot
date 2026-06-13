/**
 * Canary watcher — reads engine_canary_runs and alerts the operator
 * on consecutive failures.
 *
 * Pairs with magpie-limitclose/src/canary.js which writes one row
 * per canary tick (default every hour). The watcher polls every
 * POLL_INTERVAL_MS and surfaces the operator-relevant signals:
 *
 *   - 2 consecutive failures → WARN ("canary degraded")
 *   - 3+ consecutive failures → CRITICAL ("canary blocked — fires
 *     would likely fail right now")
 *   - Recovery from any failure tier → one-shot "recovered" DM
 *   - Canary row stale > 3h → engine not running canaries
 *     (different from engine_heartbeats staleness but related; this
 *     watcher only alerts on canary-specific staleness so we don't
 *     duplicate the heartbeat watcher's alerts)
 *
 * Distinct from engine-heartbeat-watcher (liveness) and the existing
 * status-aware alerts (Jupiter degraded) — canary is the highest-
 * confidence "would a real fire succeed RIGHT NOW" signal because it
 * runs the actual fire-path reads, not just dependency pings.
 */
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.CANARY_WATCH_INTERVAL_MS) || 5 * 60_000; // 5min
const STALE_THRESHOLD_MS = Number(process.env.CANARY_STALE_THRESHOLD_MS) || 3 * 60 * 60_000; // 3h
const WARN_CONSEC_FAILS = 2;
const CRIT_CONSEC_FAILS = 3;
const ALERT_RE_NOTIFY_MS = 6 * 60 * 60_000; // re-alert every 6h if still degraded

let lastAlertedTier = null;
let lastAlertedAt = 0;
let lastStalenessAlertedAt = 0;

function fmtAgeMs(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

async function tick(bot) {
  const adminId = getAdminId();
  if (!adminId || !bot) return;

  // Pull the most recent N canary runs to compute consecutive-fails
  // window. CRIT requires 3 consecutive failures so we read 5 to be
  // safe.
  let rows;
  try {
    const r = await query(
      `SELECT id, run_at, overall_ok, duration_ms, checks
         FROM engine_canary_runs
        WHERE service = 'limit_close_watcher'
        ORDER BY run_at DESC
        LIMIT 5`,
    );
    rows = r.rows;
  } catch (err) {
    console.warn("[canary-watch] read failed:", err.message?.slice(0, 80));
    return;
  }

  // Staleness check first — if the engine hasn't written a canary
  // row in over STALE_THRESHOLD_MS, that's an "engine not running
  // canaries" signal. Distinct from heartbeat staleness.
  const newestAt = rows[0]?.run_at ? new Date(rows[0].run_at).getTime() : 0;
  const staleness = newestAt ? Date.now() - newestAt : null;
  if (staleness != null && staleness > STALE_THRESHOLD_MS) {
    const now = Date.now();
    if (now - lastStalenessAlertedAt > ALERT_RE_NOTIFY_MS) {
      try {
        await bot.api.sendMessage(
          adminId,
          [
            `*Canary stale*`,
            "",
            `Last engine canary run: ${fmtAgeMs(staleness)} ago.`,
            `Threshold: ${fmtAgeMs(STALE_THRESHOLD_MS)}.`,
            "",
            `The engine should be writing a canary row hourly. If this is stale, the canary scheduler stopped (separately from the heartbeat). Check engine logs for [canary] entries.`,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        lastStalenessAlertedAt = now;
      } catch (err) {
        console.warn("[canary-watch] staleness DM failed:", err.message?.slice(0, 80));
      }
    }
    return;
  }

  if (rows.length === 0) {
    // No rows yet — engine hasn't written its first canary. Could
    // be a brand-new deploy. Skip silently.
    return;
  }

  // Count consecutive failures at the head of the result list.
  let consecFails = 0;
  for (const r of rows) {
    if (r.overall_ok) break;
    consecFails++;
  }

  // Recovery — were we in a degraded state and now the latest run is OK?
  if (rows[0].overall_ok && lastAlertedTier) {
    try {
      await bot.api.sendMessage(
        adminId,
        `Canary recovered — latest run OK. (was alerted at ${lastAlertedTier}.)`,
        { parse_mode: "Markdown" },
      );
      lastAlertedTier = null;
    } catch { /* silent */ }
    return;
  }

  if (consecFails < WARN_CONSEC_FAILS) return;

  const tier = consecFails >= CRIT_CONSEC_FAILS ? "CRITICAL" : "WARN";
  const tierEscalated = lastAlertedTier === "WARN" && tier === "CRITICAL";
  const now = Date.now();
  const elapsedSinceAlert = now - lastAlertedAt;
  if (!tierEscalated && lastAlertedTier === tier && elapsedSinceAlert < ALERT_RE_NOTIFY_MS) return;

  // Build a single-line summary of the failing checks from the latest run.
  const latestChecks = rows[0].checks || {};
  const failingChecks = Object.entries(latestChecks)
    .filter(([, v]) => v && !v.ok)
    .map(([k, v]) => `${k} (${v.detail?.slice(0, 60) || "no detail"})`)
    .join("; ");

  try {
    await bot.api.sendMessage(
      adminId,
      [
        `*Canary ${tier} — ${consecFails} consecutive failures*`,
        "",
        `The engine's fire-path canary has failed ${consecFails} runs in a row. A real fire would likely fail right now.`,
        "",
        `Failing checks on the latest run:`,
        failingChecks || "(no per-check details)",
        "",
        tier === "CRITICAL"
          ? `Action: investigate immediately. Likely root causes — Jupiter outage, RPC degraded, supported_mints config rotated, or borrower wallet decryption broken.`
          : `Action: keep an eye on the next canary. If it fails again the tier escalates to CRITICAL.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    lastAlertedTier = tier;
    lastAlertedAt = now;
  } catch (err) {
    console.warn("[canary-watch] alert DM failed:", err.message?.slice(0, 80));
  }
}

export function startCanaryWatcher(bot) {
  console.log(`[canary-watch] armed — polling every ${POLL_INTERVAL_MS / 60_000} min`);
  setTimeout(() => tick(bot).catch((e) => console.warn("[canary-watch] tick:", e.message?.slice(0, 80))), 60_000);
  setInterval(() => tick(bot).catch((e) => console.warn("[canary-watch] tick:", e.message?.slice(0, 80))), POLL_INTERVAL_MS);
}
