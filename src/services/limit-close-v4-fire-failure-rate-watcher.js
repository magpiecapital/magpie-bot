/**
 * V4 fire-failure rate watcher.
 *
 * The existing first-V4-fire-watcher only DMs on the VERY FIRST failure
 * (one-shot, anti-spam). Once it's celebrated/alerted, it stops. That's
 * correct for the "is V4 wired up at all?" question, but doesn't catch
 * the "V4 is wired but something is silently failing repeatedly" case.
 *
 * This watcher complements it by tracking ONGOING rate of failures and
 * alerting when either:
 *   - Same mint fails 3+ times in a rolling window (engine/oracle issue
 *     specific to that token's V4 feed or Jupiter route)
 *   - Any 5+ V4 failures across all mints in the window (engine-wide
 *     problem the canary may have missed)
 *
 * Rate-limit: once alerted on a (mint, window) the watcher mutes for
 * ALERT_MUTE_MS so we don't repeatedly wake the operator on the same
 * underlying issue. Recovery DM when the window clears.
 *
 * Cadence: every 5 min. Cheap query, indexed by (engine_program_id,
 * status, created_at).
 *
 * No emojis per Magpie copy rules.
 */
import { query } from "../db/pool.js";
import { getAdminId, notifyAdmin } from "./admin-notify.js";

const WATCH_INTERVAL_MS = Number(process.env.V4_FAILURE_RATE_INTERVAL_MS) || 5 * 60_000;
const WINDOW_MS = Number(process.env.V4_FAILURE_RATE_WINDOW_MS) || 60 * 60_000;
const ALERT_MUTE_MS = Number(process.env.V4_FAILURE_RATE_MUTE_MS) || 6 * 60 * 60_000;
const PER_MINT_THRESHOLD = Number(process.env.V4_FAILURE_RATE_PER_MINT) || 3;
const TOTAL_THRESHOLD = Number(process.env.V4_FAILURE_RATE_TOTAL) || 5;

let _timer = null;
const lastAlertedAt = new Map(); // key → epoch ms

async function tick(bot) {
  const v4 = process.env.PROGRAM_ID_V4;
  if (!v4) return; // V4 not configured

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { rows } = await query(
    `SELECT
       COALESCE(l.collateral_mint, 'UNKNOWN') AS mint,
       sm.symbol,
       COUNT(*) FILTER (WHERE lc.status = 'failed')::int AS fail_count,
       MAX(lc.updated_at) AS last_fail
     FROM limit_close_orders lc
     LEFT JOIN loans l ON l.id = lc.loan_id
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE lc.engine_program_id = $1
       AND lc.status = 'failed'
       AND lc.updated_at >= $2
     GROUP BY l.collateral_mint, sm.symbol`,
    [v4, since],
  );

  const totalFailures = rows.reduce((s, r) => s + r.fail_count, 0);
  const offenders = rows.filter((r) => r.fail_count >= PER_MINT_THRESHOLD);
  const now = Date.now();

  // Per-mint alerts
  for (const o of offenders) {
    const key = `mint:${o.mint}`;
    const last = lastAlertedAt.get(key) || 0;
    if (now - last < ALERT_MUTE_MS) continue;
    const sym = o.symbol || o.mint.slice(0, 8) + "…";
    await notifyAdmin(
      bot,
      [
        `*V4 fire-failure rate alarm — ${sym}*`,
        "",
        `${o.fail_count} V4 fire failures on \`${sym}\` in the last ${Math.round(WINDOW_MS / 60_000)} min.`,
        `Last fail: \`${new Date(o.last_fail).toISOString().slice(0, 19)}Z\`.`,
        "",
        "Likely causes:",
        "  • V4 price feed for this mint went stale / never warmed",
        "  • Jupiter routing for this mint thin or unhealthy",
        "  • Slippage cap too tight for current market conditions",
        "",
        "Check: /v4-status, /lc-perf mint=" + (o.symbol || o.mint.slice(0, 8)),
        `Muted ${Math.round(ALERT_MUTE_MS / 60_000 / 60)}h from now.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    lastAlertedAt.set(key, now);
  }

  // Engine-wide alert (independent of per-mint mutes)
  if (totalFailures >= TOTAL_THRESHOLD) {
    const key = "total";
    const last = lastAlertedAt.get(key) || 0;
    if (now - last >= ALERT_MUTE_MS) {
      await notifyAdmin(
        bot,
        [
          "*V4 engine-wide fire-failure alarm*",
          "",
          `${totalFailures} V4 fire failures across all mints in the last ${Math.round(WINDOW_MS / 60_000)} min.`,
          `Spread: ${rows.length} distinct mint(s).`,
          "",
          "Likely causes:",
          "  • Engine RPC / Jupiter outage",
          "  • V4 program upgrade in flight",
          "  • Engine authority keypair / wallet ran short of SOL",
          "",
          "Check: /v4-status, /lc-perf, railway logs --json | grep v4",
          `Muted ${Math.round(ALERT_MUTE_MS / 60_000 / 60)}h from now.`,
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
      lastAlertedAt.set(key, now);
    }
  }
}

export function startV4FireFailureRateWatcher(bot) {
  if (_timer) return;
  if (!process.env.PROGRAM_ID_V4) {
    console.log("[v4-failure-rate-watcher] PROGRAM_ID_V4 not set — disabled");
    return;
  }
  console.log(`[v4-failure-rate-watcher] armed — every ${WATCH_INTERVAL_MS / 60_000}m, window ${WINDOW_MS / 60_000}m, per-mint=${PER_MINT_THRESHOLD}, total=${TOTAL_THRESHOLD}`);
  // First tick after 2 min so we don't fire on startup state.
  setTimeout(() => {
    tick(bot).catch((e) => console.warn("[v4-failure-rate-watcher] first tick threw:", e.message?.slice(0, 80)));
    _timer = setInterval(() => {
      tick(bot).catch((e) => console.warn("[v4-failure-rate-watcher] tick threw:", e.message?.slice(0, 80)));
    }, WATCH_INTERVAL_MS);
  }, 2 * 60_000);
}
