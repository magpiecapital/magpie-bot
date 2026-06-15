/**
 * /lc-status — operator observability into the limit-close engine.
 *
 * Operator escalated 2026-06-12: limit-close must be PERFECTED. The
 * engine has been live but zero orders have fired in production yet.
 * This command gives the operator a real-time read on:
 *
 *   - How many orders are armed right now (TP vs SL)
 *   - Pending/firing/twap orders in flight
 *   - Recent fires + their settlement state (success/error/partial)
 *   - Engine heartbeat: when was the last tick? are watchers alive?
 *   - Failed orders awaiting operator review
 *
 * Read-only — no state mutation. Admin-only (admin gate logged via the
 * existing admin-audit pipeline so operator activity stays on the
 * forensic trail).
 *
 * Usage:
 *   /lc-status            — summary + recent fires
 *   /lc-status armed      — list every armed order with TP/SL + trigger
 *   /lc-status fired      — last N fires with tx links
 *   /lc-status failed     — failed orders for triage
 *   /lc-status engine     — engine watcher heartbeats + topup wallet balance
 */
import { query } from "../db/pool.js";
import { isAdmin } from "../services/admin.js";

const SOLSCAN = (sig) => sig ? `[tx](https://solscan.io/tx/${sig})` : "—";
const fmtSol = (lamports) => (Number(lamports) / 1e9).toFixed(4);
const ageStr = (date) => {
  if (!date) return "n/a";
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
};

export async function handleLcStatus(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply("❌ Not authorized.");
  }
  const sub = (ctx.message?.text || "").trim().split(/\s+/)[1] || "summary";

  if (sub === "armed") return showArmed(ctx);
  if (sub === "fired") return showFired(ctx);
  if (sub === "failed") return showFailed(ctx);
  if (sub === "engine") return showEngine(ctx);
  return showSummary(ctx);
}

async function showSummary(ctx) {
  const { rows: counts } = await query(
    `SELECT status, COALESCE(trigger_direction, 'above') AS dir, COUNT(*)::int AS n
       FROM limit_close_orders
      GROUP BY status, COALESCE(trigger_direction, 'above')
      ORDER BY status, dir`,
  );

  // Tally by status with TP/SL breakdown
  const byStatus = new Map();
  for (const r of counts) {
    const cur = byStatus.get(r.status) || { tp: 0, sl: 0 };
    if (r.dir === "below") cur.sl += r.n; else cur.tp += r.n;
    byStatus.set(r.status, cur);
  }
  const fmt = (s) => {
    const c = byStatus.get(s) || { tp: 0, sl: 0 };
    return `${c.tp + c.sl} (TP:${c.tp} SL:${c.sl})`;
  };

  const { rows: [last] } = await query(
    `SELECT MAX(fired_at) AS last_fire FROM limit_close_orders WHERE status IN ('fired','partial_fired')`,
  );

  const { rows: [lastFail] } = await query(
    `SELECT MAX(updated_at) AS last_fail FROM limit_close_orders WHERE status = 'failed'`,
  );

  const lines = [
    "🎯 *Limit-close engine status*",
    "",
    "*Order book:*",
    `  Armed:     ${fmt("armed")}`,
    `  Firing:    ${fmt("firing")}`,
    `  TWAP:      ${fmt("twap_in_progress")}`,
    `  Fired:     ${fmt("fired")}`,
    `  Partial:   ${fmt("partial_fired")}`,
    `  Cancelled: ${fmt("cancelled")}`,
    `  Failed:    ${fmt("failed")}`,
    "",
    `Last fire:    ${last?.last_fire ? `${ageStr(last.last_fire)} ago` : "*never*"}`,
    `Last failure: ${lastFail?.last_fail ? `${ageStr(lastFail.last_fail)} ago` : "*never*"}`,
    "",
    "_Sub-commands:_ `/lc-status armed | fired | failed | engine`",
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function showArmed(ctx) {
  const { rows } = await query(
    `SELECT lc.id, lc.loan_id, l.loan_id::text AS chain_loan_id, l.collateral_mint,
            lc.trigger_kind, lc.trigger_value_micro::text AS trigger_value_micro,
            COALESCE(lc.trigger_direction, 'above') AS dir,
            lc.slippage_bps, lc.armed_at, lc.source, lc.source_agent_pubkey,
            sm.symbol
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE lc.status = 'armed'
      ORDER BY lc.armed_at DESC
      LIMIT 25`,
  );
  if (rows.length === 0) {
    return ctx.reply("No armed orders right now.");
  }
  const lines = [`*Armed orders* (${rows.length})`, "```"];
  for (const r of rows) {
    const tag = r.dir === "below" ? "SL" : "TP";
    const sym = r.symbol || r.collateral_mint.slice(0, 8);
    const src = r.source === "agent_x402" ? "x402" : r.source;
    const trigDisp = r.trigger_kind === "mc_usd"
      ? `mc=$${(Number(r.trigger_value_micro) / 1e12).toFixed(0)}M`
      : r.trigger_kind === "price_usd"
        ? `$${(Number(r.trigger_value_micro) / 1e6).toFixed(6)}`
        : `${(Number(r.trigger_value_micro) / 1e6).toFixed(6)} SOL`;
    lines.push(`#${r.id} ${tag} ${sym}/${src} ${trigDisp} slip=${(r.slippage_bps / 100).toFixed(1)}% (${ageStr(r.armed_at)} ago)`);
  }
  lines.push("```");
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function showFired(ctx) {
  const { rows } = await query(
    `SELECT lc.id, lc.loan_id, l.collateral_mint, sm.symbol,
            COALESCE(lc.trigger_direction, 'above') AS dir,
            lc.status, lc.fired_at, lc.tx_signature_repay, lc.tx_signature_swap,
            lc.proceeds_lamports::text AS proceeds,
            (lc.proceeds_lamports - COALESCE(lc.net_to_user_lamports, lc.proceeds_lamports))::text AS fee,
            lc.source
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE lc.status IN ('fired', 'partial_fired')
      ORDER BY lc.fired_at DESC NULLS LAST
      LIMIT 15`,
  );
  if (rows.length === 0) {
    return ctx.reply(
      "No fires yet — engine is live but no order has triggered.\n\n_When an order fires, this view will show repay+swap tx links and the fee that landed in the protocol wallet._",
      { parse_mode: "Markdown" },
    );
  }
  const lines = [`*Recent fires* (${rows.length})`];
  for (const r of rows) {
    const tag = r.dir === "below" ? "SL" : "TP";
    const sym = r.symbol || r.collateral_mint.slice(0, 8);
    const proceeds = r.proceeds ? `${fmtSol(r.proceeds)} SOL` : "n/a";
    const fee = r.fee ? `${fmtSol(r.fee)} SOL` : "n/a";
    const partial = r.status === "partial_fired" ? " *(partial)*" : "";
    lines.push(
      `\n*#${r.id}* ${tag} ${sym}/${r.source} — ${ageStr(r.fired_at)} ago${partial}\n` +
      `  proceeds: ${proceeds}, fee: ${fee}\n` +
      `  repay: ${SOLSCAN(r.tx_signature_repay)} · swap: ${SOLSCAN(r.tx_signature_swap)}`,
    );
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true });
}

async function showFailed(ctx) {
  const { rows } = await query(
    `SELECT lc.id, lc.loan_id, l.collateral_mint, sm.symbol,
            COALESCE(lc.trigger_direction, 'above') AS dir,
            lc.failure_reason, lc.failure_count, lc.updated_at, lc.source,
            lc.notes
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE lc.status = 'failed'
      ORDER BY lc.updated_at DESC
      LIMIT 10`,
  );
  if (rows.length === 0) {
    return ctx.reply("No failed orders. ✅");
  }
  const lines = [`*Failed orders* (${rows.length})`, ""];
  for (const r of rows) {
    const tag = r.dir === "below" ? "SL" : "TP";
    const sym = r.symbol || r.collateral_mint.slice(0, 8);
    lines.push(
      `*#${r.id}* ${tag} ${sym}/${r.source} — ${ageStr(r.updated_at)} ago\n` +
      `  reason: \`${r.failure_reason || "n/a"}\`\n` +
      `  retries: ${r.failure_count || 0}\n`,
    );
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function showEngine(ctx) {
  // Operator-facing snapshot of every engine signal we know about.
  // The engine itself runs in magpie-limitclose; we surface the
  // DB-mediated signals here so the operator can answer "is it alive
  // and healthy" without leaving Telegram.
  const { rows: [recentArm] } = await query(
    `SELECT MAX(armed_at) AS last_arm FROM limit_close_orders`,
  );
  const { rows: [recentTransition] } = await query(
    `SELECT MAX(updated_at) AS last_transition FROM limit_close_orders`,
  );

  // Heartbeat row (proof-of-life; the bot's heartbeat-watcher alerts
  // off this same row but here we just render it).
  let heartbeatLine = "_heartbeat row missing — engine never wrote, or migration not applied_";
  try {
    const { rows: [hb] } = await query(
      `SELECT last_tick_at, last_tick_status, armed_count
         FROM engine_heartbeats
        WHERE id = 1 AND service = 'limit_close_watcher'`,
    );
    if (hb) {
      const statusBadge = hb.last_tick_status === "ok" ? "ok" : `*${hb.last_tick_status}*`;
      heartbeatLine = `${ageStr(hb.last_tick_at)} ago · status=${statusBadge} · ${hb.armed_count} armed`;
    }
  } catch { /* table may not exist yet on a brand-new deploy */ }

  // Latest canary result — high-confidence "would a fire succeed
  // right now" signal. Engine writes one row hourly; we surface the
  // most recent one's overall_ok + which checks failed (if any).
  let canaryLines = [];
  try {
    const { rows: [c] } = await query(
      `SELECT run_at, overall_ok, duration_ms, checks, jupiter_ok,
              dexscreener_ok, cross_source_ok, program_ok
         FROM engine_canary_runs
        WHERE service = 'limit_close_watcher'
        ORDER BY run_at DESC
        LIMIT 1`,
    );
    if (c) {
      const tag = c.overall_ok ? "passed" : "*FAILED*";
      const ageStrCanary = ageStr(c.run_at);
      const compactStatus = [
        `jup=${c.jupiter_ok ? "ok" : "X"}`,
        `dex=${c.dexscreener_ok ? "ok" : "X"}`,
        `cross=${c.cross_source_ok ? "ok" : "X"}`,
        `prog=${c.program_ok ? "ok" : "X"}`,
      ].join(" ");
      canaryLines = [
        "",
        "*Latest canary (synthetic fire-path validation):*",
        `${tag} · ${ageStrCanary} ago · ${c.duration_ms}ms · ${compactStatus}`,
      ];
      if (!c.overall_ok && c.checks) {
        const failing = Object.entries(c.checks)
          .filter(([, v]) => v && !v.ok)
          .map(([k, v]) => `  • ${k}: ${(v.detail || "").slice(0, 60)}`)
          .join("\n");
        if (failing) canaryLines.push(failing);
      }
    }
  } catch { /* table may not exist on a fresh deploy */ }

  // engine_metrics_hourly recent rollups — last hour + last 24h
  let metricsLines = [];
  try {
    const { rows: [last1h] } = await query(
      `SELECT COALESCE(SUM(ticks), 0)::int                  AS ticks,
              COALESCE(SUM(jupiter_probes_ok), 0)::int      AS jup_ok,
              COALESCE(SUM(jupiter_probes_failed), 0)::int  AS jup_fail,
              COALESCE(SUM(fires_attempted), 0)::int        AS fires_attempted,
              COALESCE(SUM(fires_succeeded), 0)::int        AS fires_succeeded,
              COALESCE(SUM(fires_failed), 0)::int           AS fires_failed,
              COALESCE(SUM(errors), 0)::int                 AS errors
         FROM engine_metrics_hourly
        WHERE service = 'limit_close_watcher'
          AND hour > NOW() - INTERVAL '1 hour'`,
    );
    const { rows: [last24h] } = await query(
      `SELECT COALESCE(SUM(ticks), 0)::int                  AS ticks,
              COALESCE(SUM(jupiter_probes_ok), 0)::int      AS jup_ok,
              COALESCE(SUM(jupiter_probes_failed), 0)::int  AS jup_fail,
              COALESCE(SUM(fires_attempted), 0)::int        AS fires_attempted,
              COALESCE(SUM(fires_succeeded), 0)::int        AS fires_succeeded
         FROM engine_metrics_hourly
        WHERE service = 'limit_close_watcher'
          AND hour > NOW() - INTERVAL '24 hours'`,
    );
    const jup1h    = last1h.jup_ok + last1h.jup_fail;
    const jup24h   = last24h.jup_ok + last24h.jup_fail;
    const jup1hPct = jup1h > 0
      ? `${((last1h.jup_ok / jup1h) * 100).toFixed(1)}%`
      : "n/a";
    const jup24hPct = jup24h > 0
      ? `${((last24h.jup_ok / jup24h) * 100).toFixed(1)}%`
      : "n/a";
    if (last1h.ticks > 0 || last24h.ticks > 0) {
      metricsLines = [
        "",
        "*Activity rollups:*",
        `1h:  ${last1h.ticks} ticks · jup ${jup1hPct} · fires ${last1h.fires_attempted}→${last1h.fires_succeeded}ok${last1h.errors ? ` · err ${last1h.errors}` : ""}`,
        `24h: ${last24h.ticks} ticks · jup ${jup24hPct} · fires ${last24h.fires_attempted}→${last24h.fires_succeeded}ok`,
      ];
    }
  } catch { /* table may not exist yet */ }

  // Topup wallet balance (operator funds for fee/repay topup).
  let topupBalance = "—";
  try {
    const { Connection, Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const secret = process.env.ENGINE_TOPUP_KEYPAIR;
    if (secret) {
      const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
      const kp = Keypair.fromSecretKey(bs58.decode(secret));
      const lamports = await conn.getBalance(kp.publicKey);
      topupBalance = `${fmtSol(lamports)} SOL (${kp.publicKey.toBase58().slice(0, 8)}…)`;
    }
  } catch (err) {
    topupBalance = `error: ${err.message?.slice(0, 60)}`;
  }

  const lines = [
    "*Engine state*",
    "",
    `Heartbeat:       ${heartbeatLine}`,
    `Last arm:        ${recentArm?.last_arm ? `${ageStr(recentArm.last_arm)} ago` : "*never*"}`,
    `Last transition: ${recentTransition?.last_transition ? `${ageStr(recentTransition.last_transition)} ago` : "*never*"}`,
    `Topup wallet:    ${topupBalance}`,
    ...metricsLines,
    "",
    "_Run `/lc-perf` for full historical analytics. Engine itself runs in `magpie-limitclose` Railway service._",
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
