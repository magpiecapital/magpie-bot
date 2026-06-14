/**
 * Neon quota watcher — hourly probe of Neon's HTTP API to record
 * compute-hours-used + storage-bytes-used. Alerts the operator when
 * usage crosses 70% of the plan's allowance on either dimension.
 *
 * Why this exists
 * ───────────────
 * 2026-06-14 outage. Neon compute-hours quota was exhausted with no
 * advance warning, every query returned XX000, bot crash-looped
 * for ~30 min. See [[project_magpie_outage_2026_06_14_neon_quota]].
 *
 * Quota dashboards in the Neon UI exist but operator can't be
 * watching them 24/7. This service is the alarm: if usage trend is
 * heading to the cliff, the operator gets a 24h+ heads-up via TG.
 *
 * Configuration (env)
 * ───────────────────
 *   NEON_API_KEY       — Neon API key (Project settings → API keys).
 *                        Without this, the watcher LOGS "disabled" at
 *                        boot and exits. Optional means optional —
 *                        the bot still works fine without quota
 *                        telemetry, just blind to the cliff.
 *   NEON_PROJECT_ID    — Neon project ID. The "ep-plain-shadow…" host
 *                        prefix maps to a project ID via the API; we
 *                        require the ID directly so we don't have to
 *                        parse hostnames.
 *   NEON_QUOTA_TICK_MS — Override the hourly tick. Default 3_600_000.
 *                        Set lower in staging if you want faster
 *                        feedback.
 *   NEON_ALERT_THRESHOLD_PCT — Alert threshold. Default 70.
 *
 * Honest scope
 * ────────────
 * This watcher catches the SLOW failure: usage approaching the
 * monthly cliff. It does NOT catch sudden spikes that exhaust the
 * quota in one hour (those would still show up as the db-quota-guard
 * "degraded" page). The watchdog and the guard work together — guard
 * is the floor; this is the ceiling early-warning.
 */
import { query } from "../db/pool.js";

const NEON_API = "https://console.neon.tech/api/v2";
const TG_API = "https://api.telegram.org";
const DEFAULT_TICK_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_ALERT_PCT = 70;
const FETCH_TIMEOUT_MS = 10_000;

function envIntOr(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

let _running = false;

/**
 * Hits Neon API for the project's quota status. Returns a normalized
 * snapshot. Throws on HTTP failure — caller decides whether to retry.
 */
async function probeNeonUsage(apiKey, projectId) {
  const url = `${NEON_API}/projects/${encodeURIComponent(projectId)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Neon API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  // Normalize. Neon's response shape lives at data.project.{...}
  // with quota / usage fields. The exact keys have shifted between
  // API versions; we read each field defensively and let any missing
  // ones fall through as null.
  const p = data?.project || data;
  const limits = p?.limits || {};
  // Compute hours: Neon reports `cpu_used_sec` and `compute_time_seconds`
  // in different API versions. Take whichever is present and convert.
  const computeUsedSec =
    Number(p?.cpu_used_sec) ||
    Number(p?.compute_time_seconds) ||
    Number(p?.consumption?.compute_time_seconds) ||
    0;
  const computeUsedHours = computeUsedSec / 3600;
  // Limits live under `limits.compute_time_seconds` on most API
  // versions, or under the plan slug for older ones.
  const computeAllowedSec =
    Number(limits?.compute_time_seconds) ||
    Number(p?.plan_compute_time_seconds) ||
    null;
  const computeAllowedHours = computeAllowedSec ? computeAllowedSec / 3600 : null;
  const computePct =
    computeAllowedHours && computeAllowedHours > 0
      ? Math.min(100, (computeUsedHours / computeAllowedHours) * 100)
      : null;

  const storageUsed =
    Number(p?.data_storage_bytes_hour) ||
    Number(p?.consumption?.data_storage_bytes_hour) ||
    Number(p?.synthetic_storage_size) ||
    null;
  const storageAllowed = Number(limits?.data_storage_bytes_hour) || null;
  const storagePct =
    storageAllowed && storageAllowed > 0
      ? Math.min(100, (storageUsed / storageAllowed) * 100)
      : null;

  const transferUsed = Number(p?.data_transfer_bytes) || null;
  const transferAllowed = Number(limits?.data_transfer_bytes) || null;

  return {
    computeUsedHours,
    computeAllowedHours,
    computePct: computePct == null ? null : Number(computePct.toFixed(2)),
    storageUsed,
    storageAllowed,
    storagePct: storagePct == null ? null : Number(storagePct.toFixed(2)),
    transferUsed,
    transferAllowed,
    plan: p?.plan_id || p?.pricing_plan || null,
    raw: data,
  };
}

/**
 * Direct-to-Telegram alert. Mirrors db-quota-guard's pattern: does
 * NOT depend on the DB or security-alerts.js for the page itself —
 * fetch against api.telegram.org with a stripped-down body. Quota
 * warnings DO depend on the DB to insert the history row, but that's
 * separate from the page itself.
 */
async function pageOperatorDirect(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = (process.env.OPERATOR_TG_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || ids.length === 0) {
    console.error("[neon-quota] cannot page: TELEGRAM_BOT_TOKEN / OPERATOR_TG_IDS unset");
    return;
  }
  for (const id of ids) {
    try {
      await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(id),
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.error(`[neon-quota] tg page to ${id} threw: ${err.message?.slice(0, 120)}`);
    }
  }
}

/**
 * Single tick: probe Neon, persist the sample, alert on rising-edge.
 */
async function tick(apiKey, projectId, alertPct) {
  let snap;
  try {
    snap = await probeNeonUsage(apiKey, projectId);
  } catch (err) {
    console.warn(`[neon-quota] probe failed: ${err.message?.slice(0, 200)}`);
    return;
  }

  const hour = new Date();
  hour.setMinutes(0, 0, 0); // bucket to the hour

  // Was the prior bucket at/over the threshold? Used for rising-edge
  // alert (one DM per crossing, not per hour while sitting at 75%).
  let priorAtOrOver = false;
  try {
    const { rows } = await query(
      `SELECT compute_pct, storage_pct
         FROM neon_quota_history
        WHERE hour < $1
        ORDER BY hour DESC
        LIMIT 1`,
      [hour.toISOString()],
    );
    if (rows[0]) {
      priorAtOrOver =
        (Number(rows[0].compute_pct) >= alertPct) ||
        (Number(rows[0].storage_pct) >= alertPct);
    }
  } catch (err) {
    console.warn(`[neon-quota] prior lookup failed: ${err.message?.slice(0, 100)}`);
  }

  const nowAtOrOver =
    (snap.computePct != null && snap.computePct >= alertPct) ||
    (snap.storagePct != null && snap.storagePct >= alertPct);
  const risingEdge = nowAtOrOver && !priorAtOrOver;

  // Persist. Raw response is capped to ~10 KB to keep the table small;
  // we strip down to a slice of keys we care about, not the full blob.
  const rawSlim = {
    plan_id: snap.raw?.project?.plan_id ?? snap.raw?.plan_id ?? null,
    cpu_used_sec: snap.raw?.project?.cpu_used_sec ?? snap.raw?.cpu_used_sec ?? null,
    synthetic_storage_size: snap.raw?.project?.synthetic_storage_size ?? null,
    limits: snap.raw?.project?.limits ?? snap.raw?.limits ?? null,
  };

  try {
    await query(
      `INSERT INTO neon_quota_history
         (hour, compute_hours_used, compute_hours_allowed, compute_pct,
          storage_bytes_used, storage_bytes_allowed, storage_pct,
          data_transfer_bytes_used, data_transfer_bytes_allowed,
          plan, alerted, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (hour) DO UPDATE SET
          compute_hours_used = EXCLUDED.compute_hours_used,
          compute_hours_allowed = EXCLUDED.compute_hours_allowed,
          compute_pct = EXCLUDED.compute_pct,
          storage_bytes_used = EXCLUDED.storage_bytes_used,
          storage_bytes_allowed = EXCLUDED.storage_bytes_allowed,
          storage_pct = EXCLUDED.storage_pct,
          data_transfer_bytes_used = EXCLUDED.data_transfer_bytes_used,
          data_transfer_bytes_allowed = EXCLUDED.data_transfer_bytes_allowed,
          plan = EXCLUDED.plan,
          alerted = neon_quota_history.alerted OR EXCLUDED.alerted,
          probed_at = NOW()`,
      [
        hour.toISOString(),
        snap.computeUsedHours,
        snap.computeAllowedHours,
        snap.computePct,
        snap.storageUsed,
        snap.storageAllowed,
        snap.storagePct,
        snap.transferUsed,
        snap.transferAllowed,
        snap.plan,
        risingEdge,
        JSON.stringify(rawSlim),
      ],
    );
  } catch (err) {
    console.warn(`[neon-quota] persist failed: ${err.message?.slice(0, 100)}`);
  }

  if (risingEdge) {
    const lines = [
      "*MAGPIE-BOT — NEON QUOTA WARNING*",
      "",
      "Usage crossed " + alertPct + "% on the current Neon plan:",
    ];
    if (snap.computePct != null) {
      lines.push(
        `• Compute: *${snap.computePct.toFixed(1)}%* (${snap.computeUsedHours.toFixed(1)}h / ${snap.computeAllowedHours?.toFixed(1) ?? "?"}h)`,
      );
    }
    if (snap.storagePct != null) {
      lines.push(
        `• Storage: *${snap.storagePct.toFixed(1)}%*`,
      );
    }
    lines.push("");
    lines.push("Don't wait for the cliff. Open the Neon dashboard, decide:");
    lines.push("• Upgrade plan (Scale -> Business?)");
    lines.push("• Or wait for monthly window reset if usage is end-of-month spike");
    lines.push("");
    lines.push("Plan: `" + (snap.plan || "unknown") + "`. This alert fires once per crossing, not hourly.");
    await pageOperatorDirect(lines.join("\n"));
  } else {
    // Quiet log so /lc-perf operators can see steady state.
    console.log(
      `[neon-quota] sample plan=${snap.plan ?? "?"} compute=${snap.computePct?.toFixed(1) ?? "?"}% storage=${snap.storagePct?.toFixed(1) ?? "?"}%`,
    );
  }
}

export async function startNeonQuotaWatcher() {
  if (_running) return;
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.log("[neon-quota] disabled — NEON_API_KEY and/or NEON_PROJECT_ID not set");
    return;
  }
  const tickMs = envIntOr("NEON_QUOTA_TICK_MS", DEFAULT_TICK_MS);
  const alertPct = envIntOr("NEON_ALERT_THRESHOLD_PCT", DEFAULT_ALERT_PCT);
  _running = true;
  console.log(`[neon-quota] starting — tick ${Math.round(tickMs / 60000)}m, alert at ${alertPct}%`);

  // First tick after a short delay so the bot's normal boot sequence
  // finishes before we hit Neon's API. After that, fixed interval.
  setTimeout(async function loop() {
    try {
      await tick(apiKey, projectId, alertPct);
    } catch (err) {
      console.warn(`[neon-quota] tick threw: ${err.message?.slice(0, 200)}`);
    }
    setTimeout(loop, tickMs).unref();
  }, 30_000).unref();
}
