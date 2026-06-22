/**
 * Limit-close engine_program_id NULL sentinel.
 *
 * Migration 050 added `engine_program_id` to `limit_close_orders` as
 * the discriminator the limit-close engine uses to pick which lending
 * program to call when filling a TP/SL/trailing/bracket order. The
 * column is nullable for backwards-compatibility with rows armed
 * BEFORE the migration landed. The engine treats NULL as V1
 * (memecoin) — fine for legacy rows, but a brand-new V2 or V3 row
 * with NULL would silently fire against the wrong pool and either
 * fail or fill against an unintended program.
 *
 * Three-layer defense already in place (arm-core stamps program_id,
 * recordLoan reads on-chain owner, healer corrects drift) — this
 * sentinel is the canary that surfaces any silent escape.
 *
 * Cadence: every 5 minutes. Cheap query (indexed by engine_program_id
 * IS NULL via partial index 050).
 *
 * Alert policy:
 *   - First non-zero count → DM operator with affected row IDs.
 *   - While count stays non-zero, re-DM at most every 6h (anti-spam).
 *   - When count returns to zero, send a recovery DM so the alert
 *     state is visibly cleared.
 *
 * No emojis per Magpie copy rules.
 */

import { query } from "../db/pool.js";
import { getAdminId, notifyAdmin } from "./admin-notify.js";

// The boundary date: rows armed BEFORE this are legacy and may legitimately
// have NULL engine_program_id (engine treats NULL as V1 — correct for the
// memecoin-only pre-RWA-routing era). Rows armed AFTER must have a non-NULL
// value because arm-core always stamps loan.program_id (which is itself
// authoritatively sourced from the on-chain Loan account owner).
//
// 2026-06-13 = day migration 050 landed AND day V3 routing went live.
// Any NULL row created after this date indicates either:
//   - loan.program_id was somehow NULL when arm-core read it, OR
//   - the arm-core INSERT silently dropped the column.
// Either is a bug worth waking the operator over.
const BOUNDARY_DATE = "2026-06-13";

const POLL_INTERVAL_MS = Number(process.env.ENGINE_PROGRAM_ID_NULL_WATCH_MS) || 5 * 60_000;
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

let lastAlertedAt = 0;
let lastAlertedCount = -1;

function fmtRows(rows) {
  if (rows.length === 0) return "";
  const sample = rows.slice(0, 8).map((r) =>
    `  • order_id=${r.id} loan_id=${r.loan_id} direction=${r.trigger_direction} status=${r.status} armed=${new Date(r.created_at).toISOString().slice(0, 16)}Z`,
  ).join("\n");
  const more = rows.length > 8 ? `\n  ... and ${rows.length - 8} more` : "";
  return sample + more;
}

async function runOneCycle(bot) {
  const { rows } = await query(
    `SELECT id, loan_id, trigger_direction, status, created_at
       FROM limit_close_orders
      WHERE engine_program_id IS NULL
        AND created_at > $1::date
        AND status IN ('armed', 'fired')
      ORDER BY created_at DESC`,
    [BOUNDARY_DATE],
  );
  const count = rows.length;
  const now = Date.now();

  if (count === 0) {
    // Recovery path: if we previously alerted and we're now back to zero,
    // send a single recovery message so the operator's alert state is clear.
    if (lastAlertedCount > 0) {
      await notifyAdmin(
        bot,
        `[engine-program-id-null] CLEAR — no post-${BOUNDARY_DATE} rows with NULL engine_program_id remain.`,
        { parse_mode: undefined },
      );
      lastAlertedCount = 0;
      lastAlertedAt = 0;
    }
    return { count: 0 };
  }

  // Non-zero path. DM if first occurrence OR enough time has passed.
  const shouldAlert =
    lastAlertedCount <= 0 ||
    now - lastAlertedAt > ALERT_REPEAT_MS ||
    count > lastAlertedCount * 1.5; // re-alert if the count grows materially

  if (shouldAlert) {
    const msg = [
      `[engine-program-id-null] ALERT — ${count} active limit-close order(s) armed after ${BOUNDARY_DATE} have NULL engine_program_id.`,
      `These orders will fire against V1 by default. If the loan is V2 or V3, the fill will fail.`,
      `Rows:`,
      fmtRows(rows),
      ``,
      `Likely fix: re-run the loan-program-id healer + back-fill engine_program_id from loans.program_id for these order rows.`,
    ].join("\n");
    await notifyAdmin(bot, msg, { parse_mode: undefined });
    lastAlertedAt = now;
    lastAlertedCount = count;
  }
  return { count };
}

export function startLimitCloseEngineProgramIdSentinel(bot) {
  if (!getAdminId()) {
    console.warn("[engine-program-id-null] no ADMIN_TG_ID — sentinel will run but alerts will be silent");
  }
  // First tick on a short delay so boot completes; then every POLL_INTERVAL_MS.
  setTimeout(async function tick() {
    try {
      await runOneCycle(bot);
    } catch (err) {
      console.error("[engine-program-id-null] tick failed:", err?.message?.slice(0, 200));
    } finally {
      setTimeout(tick, POLL_INTERVAL_MS);
    }
  }, 60_000);
  console.log(`[engine-program-id-null] sentinel armed (interval ${Math.round(POLL_INTERVAL_MS / 1000)}s, boundary ${BOUNDARY_DATE})`);
}
