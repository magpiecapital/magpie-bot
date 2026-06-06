/**
 * Daily ops report — DMs the admin a /siteops-style summary every day
 * at REPORT_HOUR_UTC. Catches anything weird that happened overnight
 * without requiring the operator to remember to run /siteops.
 *
 * Started from index.js after bot.start(). Self-throttling: only fires
 * once per UTC day, tracked in-memory + via last-sent timestamp in
 * site_global_state.set_at (re-used as a "last report sent at" flag
 * via a separate column).
 *
 * Failure is silent so a transient TG error doesn't crash the bot.
 */
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";
import { getGlobalSiteState } from "./site-global.js";

const REPORT_HOUR_UTC = 12; // noon UTC
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // check every 15 min — coarse is fine

function fmtSol(lamports) {
  if (lamports == null) return "0";
  return (Number(lamports) / 1e9).toFixed(4);
}

async function buildReport() {
  const [
    { rows: [users] },
    { rows: [locked] },
    { rows: [withdraws] },
    { rows: nonces },
    { rows: [tickets] },
    { rows: [lockEvents] },
    { rows: [loans24h] },
    siteState,
  ] = await Promise.all([
    query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new,
         (SELECT COUNT(*) FROM users)::int AS total`,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE site_locked_until IS NOT NULL AND site_locked_until > NOW()`,
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='confirmed')::int AS ok,
              COUNT(*) FILTER (WHERE status='failed')::int AS fail,
              COALESCE(SUM(CASE WHEN asset='SOL' THEN raw_amount ELSE 0 END), 0)::text AS sol_lamports
         FROM site_withdrawals
        WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query(
      `SELECT purpose, COUNT(*)::int AS n
         FROM used_nonces
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY purpose ORDER BY n DESC LIMIT 8`,
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE auto_resolved_at IS NOT NULL)::int AS auto
         FROM support_tickets
        WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query(
      `SELECT COUNT(*)::int AS n
         FROM site_lock_events
        WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query(
      `SELECT
         COUNT(*)::int AS new_loans,
         COUNT(*) FILTER (WHERE status = 'repaid')::int AS repaid,
         COUNT(*) FILTER (WHERE status = 'liquidated')::int AS liquidated,
         COALESCE(SUM(original_loan_amount_lamports::numeric), 0)::text AS volume_lamports
         FROM loans
        WHERE start_timestamp > NOW() - INTERVAL '24 hours'`,
    ),
    getGlobalSiteState(),
  ]);

  const lines = [
    `🌅 *Magpie ops · daily report*`,
    "",
    siteState.disabled
      ? `🛑 *Site signed actions DISABLED* — ${siteState.reason || "no reason"}`
      : "✅ Site signed actions enabled",
    "",
    "*Users (24h):*",
    `  New: ${users.new}  ·  Total: ${users.total}`,
    `  Currently locked: ${locked.n}`,
    "",
    "*Loans (24h):*",
    `  ${loans24h.new_loans} originated · ${loans24h.repaid} repaid · ${loans24h.liquidated} liquidated`,
    `  Volume: ${fmtSol(loans24h.volume_lamports)} SOL`,
    "",
    "*Site withdraws (24h):*",
    `  ${withdraws.total} total · ${withdraws.ok} ok · ${withdraws.fail} failed`,
    `  SOL out: ${fmtSol(withdraws.sol_lamports)} SOL`,
    "",
    "*Signed actions by purpose (24h):*",
  ];
  if (nonces.length === 0) {
    lines.push("  (none)");
  } else {
    for (const n of nonces) lines.push(`  • ${n.purpose}: ${n.n}`);
  }
  lines.push(
    "",
    "*Support (24h):*",
    `  ${tickets.total} tickets · ${tickets.auto} auto-resolved by AI`,
    "",
    `*Lock events (24h):* ${lockEvents.n}`,
    "",
    "_Run /siteops anytime for a fresh snapshot._",
  );
  return lines.join("\n");
}

let lastReportYmd = null;

async function tick(bot) {
  try {
    const now = new Date();
    if (now.getUTCHours() < REPORT_HOUR_UTC) return;
    const ymd = now.toISOString().slice(0, 10);
    if (lastReportYmd === ymd) return; // already sent today

    const adminId = getAdminId();
    if (!adminId) return;

    const text = await buildReport();
    await bot.api.sendMessage(Number(adminId), text, { parse_mode: "Markdown" });
    lastReportYmd = ymd;
    console.log("[daily-ops] report sent");
  } catch (err) {
    console.warn("[daily-ops] tick failed:", err.message);
  }
}

export function startDailyOpsReport(bot) {
  if (!bot) return;
  console.log(`[daily-ops] starting — will DM admin once per day after ${REPORT_HOUR_UTC}:00 UTC`);
  // Initial fire if we're already past the hour; subsequent ticks
  // throttle via lastReportYmd.
  setTimeout(() => tick(bot), 30_000);
  return setInterval(() => tick(bot), CHECK_INTERVAL_MS);
}
