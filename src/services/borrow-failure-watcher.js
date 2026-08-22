/**
 * borrow-failure watcher — turns repeated borrow failures into an INCIDENT
 * alarm instead of silent telemetry.
 *
 * Lesson (TRIPLET lockout, 2026-08-22): one wallet failed the same borrow
 * 8 times in 2 minutes against an unsatisfiable readiness gate, and nothing
 * alerted — the OPERATOR had to report it. Standing rule: loans must execute
 * when requested; a borrower retry-looping is the protocol failing its #1
 * priority in real time, and the operator must know within minutes.
 *
 * Every 5 min, scan the last 15 min of conversion_events (path='borrow'):
 *   - any (wallet, mint) with >= THRESHOLD failures and NO success after the
 *     last failure → admin DM with wallet, mint, failure classes, and count.
 *   - per-(wallet,mint) 30-min re-notify debounce; recovery is implicit (a
 *     success after the last failure clears the condition).
 *
 * Read-only over the DB. No RPC, no signing, no on-chain surface — cannot
 * affect the borrow path itself.
 */
import { query } from "../db/pool.js";
import { getAdminId, notifyAdmin } from "./admin-notify.js";

const TICK_MS = Number(process.env.BORROW_FAIL_WATCH_INTERVAL_MS) || 5 * 60_000;
const LOOKBACK_MIN = Number(process.env.BORROW_FAIL_WATCH_LOOKBACK_MIN) || 15;
const THRESHOLD = Number(process.env.BORROW_FAIL_WATCH_THRESHOLD) || 3;
const RENOTIFY_MS = 30 * 60_000;

const alertedAt = new Map(); // `${wallet}:${mint}` -> ts

async function tick() {
  const { rows } = await query(
    `SELECT wallet, mint,
            COUNT(*)::int AS fails,
            MAX(created_at) AS last_fail,
            ARRAY_AGG(DISTINCT COALESCE(failure_class,'unclassified')) AS classes
       FROM conversion_events
      WHERE path = 'borrow' AND outcome = 'failure'
        AND created_at > now() - ($1 || ' minutes')::interval
        AND wallet IS NOT NULL
      GROUP BY wallet, mint
     HAVING COUNT(*) >= $2`,
    [String(LOOKBACK_MIN), THRESHOLD],
  );
  if (!rows.length) return;

  for (const r of rows) {
    // Cleared if the borrower converted after their last failure.
    const ok = await query(
      `SELECT 1 FROM conversion_events
        WHERE path='borrow' AND outcome='success'
          AND wallet = $1 AND created_at > $2 LIMIT 1`,
      [r.wallet, r.last_fail],
    );
    if (ok.rows.length) continue;

    const key = `${r.wallet}:${r.mint || "?"}`;
    const last = alertedAt.get(key) || 0;
    if (Date.now() - last < RENOTIFY_MS) continue;
    alertedAt.set(key, Date.now());

    const adminId = getAdminId();
    if (!adminId) return;
    const msg = [
      `🚨 *borrow-failure cluster — borrower stuck RIGHT NOW*`,
      ``,
      `Wallet: \`${r.wallet}\``,
      `Mint: \`${r.mint || "unknown"}\``,
      `Failures (last ${LOOKBACK_MIN}m): *${r.fails}* — no success since`,
      `Classes: \`${(r.classes || []).join(", ")}\``,
      ``,
      `_Loans must execute when requested. A user is retry-looping and losing — investigate the failure class root-cause now, do not wait for a report._`,
    ].join("\n");
    try { await notifyAdmin(msg, { parse_mode: "Markdown" }); } catch { /* swallow */ }
  }
}

export function startBorrowFailureWatcher() {
  if (process.env.BORROW_FAIL_WATCH_DISABLED === "true") {
    console.log("[borrow-fail-watcher] disabled via env");
    return;
  }
  console.log(`[borrow-fail-watcher] starting — every ${TICK_MS}ms, threshold=${THRESHOLD} fails/${LOOKBACK_MIN}min per wallet+mint`);
  setTimeout(() => tick().catch((e) => console.warn("[borrow-fail-watcher] tick err:", e.message)), 90_000);
  setInterval(() => tick().catch((e) => console.warn("[borrow-fail-watcher] tick err:", e.message)), TICK_MS);
}
