/**
 * Engine heartbeat watcher — detect when the limit-close engine
 * service goes silent.
 *
 * Pairs with magpiecapital/magpie-limitclose PR #9 (engine-side
 * heartbeat writer). The engine UPSERTs into engine_heartbeats id=1
 * every tick. This watcher polls last_tick_at and DMs the operator
 * with severity-tiered alerts if the engine stops ticking.
 *
 * LIMIT_CLOSE_ENGINE_AUDIT.md flagged this as P0 observability for the
 * "PERFECTED" mandate — if the engine dies, no orders fire and the
 * operator must hear about it BEFORE a user complains.
 *
 * Severity tiers:
 *   - 5 min  stale   WARN     "Engine hasn't ticked in 5+ min. Check Railway."
 *   - 15 min stale   CRITICAL "Engine still silent at 15 min. Probably down."
 *   - 30 min stale   EMERGENCY "Engine has been down 30+ min. Orders are dead."
 *
 * Anti-spam: same-tier dedupe (don't re-spam unless 6h passed OR severity
 * escalated). Recovery clears alert state so the next outage re-alerts.
 *
 * Poll interval: 60s. Tunable via ENGINE_HEARTBEAT_WATCH_MS.
 */
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.ENGINE_HEARTBEAT_WATCH_MS) || 60_000;

const TIERS = [
  { stale_ms:  5 * 60_000, level: "🟡 WARN",      action: "Engine hasn't ticked in 5+ min. Check Railway logs on the magpie-limitclose service." },
  { stale_ms: 15 * 60_000, level: "🟠 CRITICAL",  action: "Engine still silent at 15+ min. Likely crashed or in a restart loop." },
  { stale_ms: 30 * 60_000, level: "🔴 EMERGENCY", action: "Engine has been DOWN 30+ min. Armed orders are not being processed. Restart the service NOW." },
];

let lastAlertedAt = 0;
let lastAlertedTier = null;
// "alive but degraded" tracking (e.g. last_tick_status='jupiter_degraded').
// Distinct from lastAlertedTier — staleness tier and external-dep status
// are independent failure modes that need independent alert/recovery
// state. Both can be active at once if Jupiter dies AND the engine
// then stops ticking; we DM each transition exactly once.
let lastAlertedDegradedStatus = null;
let lastDegradedAlertAt = 0;
const DEGRADED_RE_ALERT_MS = 6 * 60 * 60 * 1000; // re-DM every 6h if still degraded

const DEGRADED_STATUS_COPY = {
  // Per-tick Jupiter probe failed 2+ consecutive times. Engine alive
  // but cannot read prices, so no orders are firing. Usually a Jupiter
  // outage, sometimes our IP getting rate-limited.
  jupiter_degraded: {
    title: "Engine degraded: Jupiter unreachable",
    action: "Check status.jup.ag and the engine logs. Orders are NOT firing while this is active.",
  },
};

async function emitDegradedAlert(bot, adminTgId, status, row) {
  const copy = DEGRADED_STATUS_COPY[status] || {
    title: `Engine degraded: ${status}`,
    action: "Unknown degraded status — check engine logs.",
  };
  const now = Date.now();
  const reAlertDue = lastAlertedDegradedStatus === status
    ? (now - lastDegradedAlertAt > DEGRADED_RE_ALERT_MS)
    : true;
  if (!reAlertDue) return;
  try {
    await bot.api.sendMessage(
      adminTgId,
      [
        `${copy.title}`,
        "",
        `Service: \`limit_close_watcher\` (magpie-limitclose)`,
        `Last tick: just now`,
        `Last tick status: \`${status}\``,
        `Armed orders right now: ${row.armed_count}`,
        "",
        `Action: ${copy.action}`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    lastAlertedDegradedStatus = status;
    lastDegradedAlertAt = now;
  } catch (err) {
    console.warn("[engine-heartbeat-watch] degraded DM failed:", err.message?.slice(0, 80));
  }
}

async function tick(bot) {
  const adminTgId = getAdminId();
  if (!adminTgId || !bot) return;

  let row;
  try {
    const r = await query(
      `SELECT last_tick_at, last_tick_status, armed_count
         FROM engine_heartbeats
        WHERE id = 1 AND service = 'limit_close_watcher'`,
    );
    row = r.rows[0];
  } catch (err) {
    console.warn("[engine-heartbeat-watch] read failed:", err.message);
    return;
  }

  if (!row) {
    // Table exists (migration applied) but engine hasn't written yet —
    // could be brand-new deploy. Skip alerting until first write lands.
    return;
  }

  const staleMs = Date.now() - new Date(row.last_tick_at).getTime();
  // Find the most severe tier we've crossed.
  const crossed = [...TIERS].reverse().find((t) => staleMs >= t.stale_ms);
  if (!crossed) {
    // Heartbeat is fresh. But the engine can be "alive but degraded"
    // — e.g. last_tick_status = 'jupiter_degraded' means the engine is
    // ticking fine but its upstream price source is dead, so orders
    // silently can't fire. Surface that as its own alert path so the
    // operator knows the engine is alive AND that there's a problem.
    const status = row.last_tick_status || "ok";
    if (status !== "ok") {
      await emitDegradedAlert(bot, adminTgId, status, row);
    } else if (lastAlertedDegradedStatus) {
      // Recovery from a previous degraded state (jupiter back up, etc.)
      try {
        await bot.api.sendMessage(
          adminTgId,
          `Engine status back to 'ok' (was '${lastAlertedDegradedStatus}'). ${row.armed_count} armed.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* noop */ }
      lastAlertedDegradedStatus = null;
    }
    // Standard "engine back online from stale" recovery DM
    if (lastAlertedTier) {
      try {
        await bot.api.sendMessage(
          adminTgId,
          `Engine back online — last tick ${Math.round(staleMs / 1000)}s ago, ${row.armed_count} armed.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* noop */ }
      lastAlertedTier = null;
    }
    return;
  }

  // Dedupe — don't re-spam same tier within 6h unless escalated.
  const now = Date.now();
  const sinceLast = now - lastAlertedAt;
  const tierEscalated = lastAlertedTier && TIERS.indexOf(crossed) > TIERS.indexOf(lastAlertedTier);
  const enoughTimeElapsed = sinceLast > 6 * 60 * 60 * 1000;
  if (lastAlertedTier === crossed && !tierEscalated && !enoughTimeElapsed) return;

  const ageMin = Math.round(staleMs / 60_000);
  try {
    await bot.api.sendMessage(
      adminTgId,
      [
        `${crossed.level} *Engine heartbeat stale*`,
        "",
        `Service: \`limit_close_watcher\` (magpie-limitclose)`,
        `Last tick: ${ageMin} min ago`,
        `Armed orders at last tick: ${row.armed_count}`,
        "",
        `Action: ${crossed.action}`,
        "",
        `When the engine recovers, you'll get a one-shot ✅ "Engine back online" DM.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    lastAlertedAt = now;
    lastAlertedTier = crossed;
  } catch (err) {
    console.warn("[engine-heartbeat-watch] DM failed:", err.message?.slice(0, 80));
  }
}

export function startEngineHeartbeatWatcher(bot) {
  console.log(`[engine-heartbeat-watch] started; polling every ${POLL_INTERVAL_MS / 1000}s`);
  setTimeout(() => tick(bot).catch((e) => console.error("[engine-heartbeat-watch] tick:", e.message)), 60_000);
  setInterval(() => tick(bot).catch((e) => console.error("[engine-heartbeat-watch] tick:", e.message)), POLL_INTERVAL_MS);
}
