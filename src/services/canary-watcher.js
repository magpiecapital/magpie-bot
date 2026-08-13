/**
 * Canary watcher — reads engine_canary_runs and alerts the operator
 * on consecutive failures, PER PROGRAM (V1/V2/V3/V4).
 *
 * Pairs with magpie-limitclose/src/canary.js which writes one row
 * PER PROGRAM per canary tick, each tagged with program_id. The watcher
 * polls every POLL_INTERVAL_MS and surfaces the operator-relevant signals:
 *
 *   - 2 consecutive failures → WARN ("canary degraded")
 *   - 3+ consecutive failures → CRITICAL ("canary blocked — fires
 *     would likely fail right now")
 *   - Recovery from any failure tier → one-shot "recovered" DM
 *   - Canary row stale > 3h → engine not running canaries for that program
 *
 * CRITICAL CORRECTNESS (audit 2026-06-28, P0): the engine writes up to 4
 * rows per tick (one per program), interleaved by run_at. Evaluating them
 * as one mixed stream collapses a V4-ONLY fire regression into the V1/V2/V3
 * OK rows on the same tick — consecFails resets to 0 every tick, so a real
 * V4 fire regression NEVER reaches WARN/CRIT and pages NOBODY (the exact
 * thing the "memecoins must never regress" + "RWA/xStock must execute"
 * mandates rely on this to catch). So we compute consecutive-fails and hold
 * alert/recovery/staleness state PER program_id. The V4 program is labeled
 * explicitly so the operator immediately knows the in-vault exit path is
 * the one degraded.
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

// Per-program alert state (keyed by program_id, or 'legacy' for NULL rows).
// Previously module-level scalars collapsed all programs into one alert
// state, so a V1 OK could "recover" a V4 degradation. Maps fix that.
const lastAlertedTier = new Map();        // program_id -> "WARN" | "CRITICAL"
const lastAlertedAt = new Map();          // program_id -> epoch ms
const lastStalenessAlertedAt = new Map(); // program_id -> epoch ms

function fmtAgeMs(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function programLabel(program, v4ProgramId) {
  if (v4ProgramId && program === v4ProgramId) return "V4 (in-vault exits)";
  if (program === "legacy") return "legacy/V1";
  return `program ${String(program).slice(0, 8)}…`;
}

async function tick(bot) {
  const adminId = getAdminId();
  if (!adminId || !bot) return;

  // Which programs have written canary rows recently? Evaluate each on its
  // OWN stream so a V4-only regression can never be masked by V1/V2/V3.
  let programs;
  try {
    const r = await query(
      `SELECT DISTINCT COALESCE(program_id, 'legacy') AS program_id
         FROM engine_canary_runs
        WHERE service = 'limit_close_watcher'
          AND run_at > NOW() - INTERVAL '6 hours'`,
    );
    programs = r.rows.map((x) => x.program_id);
  } catch (err) {
    console.warn("[canary-watch] program list read failed:", err.message?.slice(0, 80));
    return;
  }
  if (programs.length === 0) return;

  const v4ProgramId = process.env.PROGRAM_ID_V4 || null;
  for (const program of programs) {
    try {
      await evaluateProgram(bot, adminId, program, v4ProgramId);
    } catch (err) {
      console.warn(`[canary-watch] evaluate ${program} threw:`, err.message?.slice(0, 80));
    }
  }
}

async function evaluateProgram(bot, adminId, program, v4ProgramId) {
  const label = programLabel(program, v4ProgramId);

  // Pull the most recent N canary runs FOR THIS PROGRAM to compute the
  // consecutive-fails window. CRIT requires 3 in a row so 5 is enough.
  let rows;
  try {
    const r = await query(
      `SELECT id, run_at, overall_ok, duration_ms, checks
         FROM engine_canary_runs
        WHERE service = 'limit_close_watcher'
          AND COALESCE(program_id, 'legacy') = $1
        ORDER BY run_at DESC
        LIMIT 5`,
      [program],
    );
    rows = r.rows;
  } catch (err) {
    console.warn(`[canary-watch] read failed (${label}):`, err.message?.slice(0, 80));
    return;
  }
  if (rows.length === 0) return;

  // Staleness (per program) — a V4-only scheduler stall is no longer masked
  // by fresh V1/V2/V3 ticks because we read THIS program's newest row.
  const newestAt = rows[0]?.run_at ? new Date(rows[0].run_at).getTime() : 0;
  const staleness = newestAt ? Date.now() - newestAt : null;
  if (staleness != null && staleness > STALE_THRESHOLD_MS) {
    const now = Date.now();
    if (now - (lastStalenessAlertedAt.get(program) || 0) > ALERT_RE_NOTIFY_MS) {
      try {
        await bot.api.sendMessage(
          adminId,
          [
            `*Canary stale — ${label}*`,
            "",
            `Last engine canary run for this program: ${fmtAgeMs(staleness)} ago.`,
            `Threshold: ${fmtAgeMs(STALE_THRESHOLD_MS)}.`,
            "",
            `The engine should write a canary row for each program every tick. If this program is stale, its canary scheduler stalled. Check engine logs for [canary] entries.`,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        lastStalenessAlertedAt.set(program, now);
      } catch (err) {
        console.warn(`[canary-watch] staleness DM failed (${label}):`, err.message?.slice(0, 80));
      }
    }
    return;
  }

  // Count consecutive failures at the head of THIS program's stream.
  let consecFails = 0;
  for (const r of rows) {
    if (r.overall_ok) break;
    consecFails++;
  }

  // Recovery — were we degraded for THIS program and is the latest run OK?
  if (rows[0].overall_ok && lastAlertedTier.get(program)) {
    try {
      await bot.api.sendMessage(
        adminId,
        `Canary recovered — ${label}: latest run OK. (was alerted at ${lastAlertedTier.get(program)}.)`,
        { parse_mode: "Markdown" },
      );
      lastAlertedTier.delete(program);
    } catch { /* silent */ }
    return;
  }

  if (consecFails < WARN_CONSEC_FAILS) return;

  const tier = consecFails >= CRIT_CONSEC_FAILS ? "CRITICAL" : "WARN";
  const tierEscalated = lastAlertedTier.get(program) === "WARN" && tier === "CRITICAL";
  const now = Date.now();
  const elapsedSinceAlert = now - (lastAlertedAt.get(program) || 0);
  if (!tierEscalated && lastAlertedTier.get(program) === tier && elapsedSinceAlert < ALERT_RE_NOTIFY_MS) return;

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
        `*Canary ${tier} — ${label} — ${consecFails} consecutive failures*`,
        "",
        `The engine's fire-path canary for ${label} has failed ${consecFails} runs in a row. A real fire on this program would likely fail right now.`,
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
    lastAlertedTier.set(program, tier);
    lastAlertedAt.set(program, now);
  } catch (err) {
    console.warn(`[canary-watch] alert DM failed (${label}):`, err.message?.slice(0, 80));
  }
}

export function startCanaryWatcher(bot) {
  console.log(`[canary-watch] armed — polling every ${POLL_INTERVAL_MS / 60_000} min, PER PROGRAM (V4 tripwire isolated)`);
  setTimeout(() => tick(bot).catch((e) => console.warn("[canary-watch] tick:", e.message?.slice(0, 80))), 60_000);
  setInterval(() => tick(bot).catch((e) => console.warn("[canary-watch] tick:", e.message?.slice(0, 80))), POLL_INTERVAL_MS);
}
