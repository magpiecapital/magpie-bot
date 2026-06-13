/**
 * /lc-perf — historical engine performance.
 *
 * /lc-status answers "what is the engine doing RIGHT NOW?". This
 * command answers "is the engine getting BETTER over time, and where
 * are the rough edges?".
 *
 * For "perfection" you need numbers you can compare across days:
 *   - fires/day (engine activity)
 *   - time-to-fire p50/p95 (latency between arm and execution)
 *   - source breakdown (TG vs site vs x402 — are agents adopting?)
 *   - direction breakdown (TP vs SL — what are users actually using
 *     this for?)
 *   - failure-reason top-N (the rough edges)
 *   - net-to-user totals (the dollars users got back through Magpie
 *     instead of liquidation/manual selling)
 *
 * Window is configurable via subcommand: 24h, 7d (default), 30d, all.
 * Admin-gated. Read-only — pure analytics over the existing
 * limit_close_orders columns, no schema change required.
 *
 * Usage:
 *   /lc-perf            — last 7 days, full summary
 *   /lc-perf 24h        — last 24 hours
 *   /lc-perf 30d        — last 30 days
 *   /lc-perf all        — every order ever
 *   /lc-perf failures   — failure-reason breakdown over 7d
 */
import { query } from "../db/pool.js";
import { isAdmin } from "../services/admin.js";

const WINDOWS = {
  "24h":   { interval: "24 hours",  label: "24h" },
  "7d":    { interval: "7 days",    label: "7d" },
  "30d":   { interval: "30 days",   label: "30d" },
  "all":   { interval: null,        label: "all-time" },
};

function fmtSol(lamports) {
  if (lamports == null) return "—";
  const n = Number(lamports) / 1e9;
  if (n < 0.001) return "<0.001";
  if (n < 1) return n.toFixed(4);
  if (n < 100) return n.toFixed(3);
  return n.toFixed(1);
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/* Build a `WHERE armed_at > NOW() - INTERVAL '…'` clause + params.
   Returns { sqlClause, params } so each query in the command shares
   the same windowing without param-index drift. */
function windowClause(windowKey) {
  const win = WINDOWS[windowKey] || WINDOWS["7d"];
  if (!win.interval) return { sqlClause: "", params: [] };
  return { sqlClause: ` AND armed_at > NOW() - INTERVAL '${win.interval}'`, params: [] };
}

export async function handleLcPerf(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply("❌ Not authorized.");
  }
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const sub = parts[1] || "7d";

  if (sub === "failures") return showFailures(ctx, parts[2] || "7d");
  if (!WINDOWS[sub]) {
    return ctx.reply(
      [
        "Usage:",
        "`/lc-perf [24h|7d|30d|all]`",
        "`/lc-perf failures [24h|7d|30d|all]`",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }
  return showPerf(ctx, sub);
}

async function showPerf(ctx, windowKey) {
  const win = WINDOWS[windowKey];
  const { sqlClause } = windowClause(windowKey);

  // ── Overall counts by status, with TP/SL breakdown ──
  const { rows: countRows } = await query(
    `SELECT status,
            COALESCE(trigger_direction, 'above') AS dir,
            COUNT(*)::int AS n
       FROM limit_close_orders
      WHERE 1=1 ${sqlClause}
      GROUP BY status, COALESCE(trigger_direction, 'above')`,
  );
  const byStatus = new Map();
  for (const r of countRows) {
    const cur = byStatus.get(r.status) || { tp: 0, sl: 0 };
    if (r.dir === "below") cur.sl += r.n; else cur.tp += r.n;
    byStatus.set(r.status, cur);
  }
  const totalArmed   = (byStatus.get("armed")   || { tp: 0, sl: 0 });
  const totalFired   = (byStatus.get("fired")   || { tp: 0, sl: 0 });
  const totalFailed  = (byStatus.get("failed")  || { tp: 0, sl: 0 });
  const totalCancel  = (byStatus.get("cancelled") || { tp: 0, sl: 0 });
  const totalExpired = (byStatus.get("expired") || { tp: 0, sl: 0 });
  const firedTotal   = totalFired.tp + totalFired.sl;
  const failedTotal  = totalFailed.tp + totalFailed.sl;
  const fireRate     = firedTotal + failedTotal > 0
    ? ((firedTotal / (firedTotal + failedTotal)) * 100).toFixed(1)
    : "—";

  // ── Time-to-fire latency (percentiles) ──
  // Latency is fired_at - armed_at for orders that actually fired in window.
  // Postgres percentile_cont needs an ordered set so we use that.
  const { rows: [latency] } = await query(
    `SELECT
        percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fired_at - armed_at)) * 1000) AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fired_at - armed_at)) * 1000) AS p95_ms,
        MIN(EXTRACT(EPOCH FROM (fired_at - armed_at)) * 1000) AS min_ms,
        MAX(EXTRACT(EPOCH FROM (fired_at - armed_at)) * 1000) AS max_ms
       FROM limit_close_orders
      WHERE status = 'fired'
        AND fired_at IS NOT NULL
        AND armed_at IS NOT NULL
        ${sqlClause}`,
  );

  // ── Source breakdown ──
  const { rows: sources } = await query(
    `SELECT source, COUNT(*)::int AS n
       FROM limit_close_orders
      WHERE 1=1 ${sqlClause}
      GROUP BY source ORDER BY n DESC`,
  );

  // ── Net-to-user totals (dollars users got back through the engine) ──
  const { rows: [econ] } = await query(
    `SELECT
        COALESCE(SUM(net_to_user_lamports), 0)::text AS total_net,
        COALESCE(SUM(proceeds_lamports), 0)::text    AS total_proceeds,
        COALESCE(SUM(protocol_fee_lamports), 0)::text AS total_fees,
        COALESCE(SUM(loan_owed_at_fire_lamports), 0)::text AS total_repaid
       FROM limit_close_orders
      WHERE status = 'fired' ${sqlClause}`,
  );

  // ── Top failure reasons ──
  const { rows: failures } = await query(
    `SELECT failure_reason, COUNT(*)::int AS n
       FROM limit_close_orders
      WHERE status = 'failed'
        AND failure_reason IS NOT NULL
        ${sqlClause}
      GROUP BY failure_reason
      ORDER BY n DESC
      LIMIT 5`,
  );

  // ── Engine activity (from engine_metrics_hourly) ──
  // engine_metrics_hourly has the per-hour rollups the engine writes
  // every tick. Without this, /lc-perf goes silent during quiet
  // periods — even though the engine has been ticking faithfully.
  // The "ticks" column is the proof-of-life number; jupiter probe
  // success rate is the proof-of-health number.
  let engineSummary = null;
  try {
    const engineWindow = win.interval
      ? ` AND hour > NOW() - INTERVAL '${win.interval}'`
      : "";
    const { rows: [eng] } = await query(
      `SELECT COALESCE(SUM(ticks), 0)::bigint::text                 AS ticks,
              COALESCE(SUM(jupiter_probes_ok), 0)::bigint::text     AS jup_ok,
              COALESCE(SUM(jupiter_probes_failed), 0)::bigint::text AS jup_fail,
              COALESCE(SUM(armed_orders_evaluated), 0)::bigint::text AS evaluated,
              COALESCE(SUM(fires_attempted), 0)::bigint::text       AS fires_attempted,
              COALESCE(SUM(fires_succeeded), 0)::bigint::text       AS fires_succeeded,
              COALESCE(SUM(fires_failed), 0)::bigint::text          AS fires_failed,
              COALESCE(SUM(fires_reverted), 0)::bigint::text        AS fires_reverted,
              COALESCE(SUM(errors), 0)::bigint::text                AS errors,
              MIN(hour)                                              AS earliest_hour,
              MAX(hour)                                              AS latest_hour
         FROM engine_metrics_hourly
        WHERE service = 'limit_close_watcher' ${engineWindow}`,
    );
    if (eng && Number(eng.ticks) > 0) {
      const jupTotal = Number(eng.jup_ok) + Number(eng.jup_fail);
      const jupRate  = jupTotal > 0
        ? ((Number(eng.jup_ok) / jupTotal) * 100).toFixed(2)
        : "—";
      // Activity span — useful when the window straddles a deploy or restart.
      let span = "n/a";
      if (eng.earliest_hour && eng.latest_hour) {
        const spanMs = new Date(eng.latest_hour).getTime() - new Date(eng.earliest_hour).getTime();
        const spanH  = Math.max(1, Math.round(spanMs / 3_600_000));
        span = spanH < 24 ? `${spanH}h` : `${Math.round(spanH / 24)}d`;
      }
      engineSummary = { eng, jupRate, span };
    }
  } catch (err) {
    // engine_metrics_hourly may not exist yet on a fresh deploy — log
    // and continue. /lc-perf still renders the order-driven sections.
    console.warn("[lc-perf] engine_metrics_hourly read failed:", err.message?.slice(0, 80));
  }

  const lines = [
    `*Limit-close performance — ${win.label}*`,
    "",
    "*Lifecycle (TP / SL):*",
    `• Armed (open):  ${totalArmed.tp + totalArmed.sl} (TP:${totalArmed.tp} SL:${totalArmed.sl})`,
    `• Fired:         ${firedTotal} (TP:${totalFired.tp} SL:${totalFired.sl})`,
    `• Failed:        ${failedTotal} (TP:${totalFailed.tp} SL:${totalFailed.sl})`,
    `• Cancelled:     ${totalCancel.tp + totalCancel.sl}`,
    `• Expired:       ${totalExpired.tp + totalExpired.sl}`,
    `• Fire success rate: *${fireRate}%* (of attempts)`,
    "",
    "*Time-to-fire (fired_at − armed_at):*",
    `• p50: ${fmtMs(latency?.p50_ms)}`,
    `• p95: ${fmtMs(latency?.p95_ms)}`,
    `• range: ${fmtMs(latency?.min_ms)} → ${fmtMs(latency?.max_ms)}`,
    "",
    "*Source breakdown:*",
    ...sources.map((s) => `• ${s.source.padEnd(12)} ${s.n}`),
    "",
    "*Economic totals (fired only):*",
    `• Total proceeds:   ${fmtSol(econ?.total_proceeds)} SOL`,
    `• Loans repaid:     ${fmtSol(econ?.total_repaid)} SOL`,
    `• Protocol fees:    ${fmtSol(econ?.total_fees)} SOL`,
    `• Net to users:     *${fmtSol(econ?.total_net)} SOL*`,
    "",
  ];

  if (failures.length > 0) {
    lines.push("*Top failure reasons:*");
    for (const f of failures) {
      lines.push(`• \`${f.failure_reason}\` × ${f.n}`);
    }
    lines.push("");
    lines.push("_/lc-perf failures for the full breakdown._");
  } else {
    lines.push("*No failures in this window.* ✓");
  }

  if (engineSummary) {
    const { eng, jupRate, span } = engineSummary;
    lines.push("");
    lines.push(`*Engine activity (rollup span: ${span}):*`);
    lines.push(`• Ticks:              ${Number(eng.ticks).toLocaleString()}`);
    lines.push(`• Jupiter probe rate: *${jupRate}%* (${Number(eng.jup_ok)} ok / ${Number(eng.jup_fail)} failed)`);
    lines.push(`• Orders evaluated:   ${Number(eng.evaluated).toLocaleString()}`);
    lines.push(`• Fires attempted:    ${Number(eng.fires_attempted)} → ${Number(eng.fires_succeeded)} ok · ${Number(eng.fires_failed)} fail · ${Number(eng.fires_reverted)} revert`);
    if (Number(eng.errors) > 0) {
      lines.push(`• Tick errors:        ${Number(eng.errors)}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true });
}

async function showFailures(ctx, windowKey) {
  const win = WINDOWS[windowKey];
  if (!win) {
    return ctx.reply("Usage: `/lc-perf failures [24h|7d|30d|all]`", { parse_mode: "Markdown" });
  }
  const { sqlClause } = windowClause(windowKey);

  const { rows } = await query(
    `SELECT failure_reason,
            COUNT(*)::int AS n,
            COUNT(DISTINCT user_id)::int AS users_affected,
            MAX(updated_at) AS last_seen
       FROM limit_close_orders
      WHERE status = 'failed'
        AND failure_reason IS NOT NULL
        ${sqlClause}
      GROUP BY failure_reason
      ORDER BY n DESC, last_seen DESC`,
  );

  if (rows.length === 0) {
    return ctx.reply(`*No failures in the ${win.label} window.*`, { parse_mode: "Markdown" });
  }

  const lines = [
    `*Failure reasons — ${win.label}*`,
    "",
  ];
  for (const r of rows) {
    const ageMs = Date.now() - new Date(r.last_seen).getTime();
    const age = ageMs < 60_000     ? `${Math.round(ageMs / 1000)}s`
              : ageMs < 3_600_000  ? `${Math.round(ageMs / 60_000)}m`
              : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h`
              :                      `${Math.round(ageMs / 86_400_000)}d`;
    lines.push(`• \`${r.failure_reason}\` × ${r.n} (${r.users_affected} users · last ${age} ago)`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
