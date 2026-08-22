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
const userTouchedAt = new Map(); // wallet -> ts (Pip outreach debounce, 6h)

// Failure-class-specific remedies Pip can offer ON THE SPOT. Derived from
// live telemetry only — never guesses. Operator directive 2026-08-22:
// detection must flow into remedy, not just an admin DM.
const REMEDIES = {
  twap_warming_timeout: (m) =>
    `I can see your borrow${m} is waiting on our price-history window — it builds automatically and usually completes within ~5 minutes of your first attempt. Please tap Borrow once more; if it still says warming, the countdown it shows is now accurate.`,
  sim_failed: () =>
    `Your signing window expired while we were verifying the transaction. Refresh the page and approve again — the new quote will go straight through.`,
  drain_guard_trip: () =>
    `A safety pre-check was too strict and briefly blocked legitimate borrows — we've already shipped a fix. Please try your borrow again now; it should complete in a few seconds.`,
  account_not_initialized: () =>
    `We were finishing one-time setup for that token. It's done within ~15 seconds of your first attempt — please tap Borrow again.`,
  default: () =>
    `Something interrupted your borrow and our team has been alerted with the full details. Please try once more — and if it fails again, reply here or post in @MagpieTalk and we'll take it from there personally.`,
};

async function pipOutreach(wallet, mint, classes) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) return;
  const last = userTouchedAt.get(wallet) || 0;
  if (Date.now() - last < 6 * 60 * 60_000) return;
  // wallet -> telegram user. ⛔ telegram_id < 0 = site-only pseudo-id — NEVER
  // DM those (overlaps real TG group ids). Respect proactive_dms_disabled.
  const { rows } = await query(
    `SELECT u.telegram_id FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 AND u.telegram_id > 0
        AND COALESCE(u.proactive_dms_disabled, false) = false
      LIMIT 1`,
    [wallet],
  );
  if (!rows.length) return;
  userTouchedAt.set(wallet, Date.now());
  const klass = (classes || []).find((c) => REMEDIES[c]) || "default";
  const remedy = (REMEDIES[klass] || REMEDIES.default)(mint ? "" : "");
  const text = `🪶 Hi — Pip from Magpie. I noticed your loan request just hit an error, and I wanted to help right away.

${remedy}

Your funds are safe — nothing was moved. If anything still feels off, reply here any time.`;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: rows[0].telegram_id, text }),
    });
    console.log(`[borrow-fail-watcher] pip outreach sent to tg user for wallet ${wallet.slice(0, 8)} (class=${klass})`);
  } catch (e) {
    console.warn(`[borrow-fail-watcher] pip outreach failed: ${e.message?.slice(0, 80)}`);
  }
}

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

    // Pip on-the-spot support: reach the borrower with a remedy, not silence.
    try { await pipOutreach(r.wallet, r.mint, r.classes); } catch { /* never blocks */ }
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
