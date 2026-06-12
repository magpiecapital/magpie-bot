/**
 * Credit-events auto-healer.
 *
 * Periodically scans for loans missing their canonical credit_events:
 *   - Every loan must have a 'borrow' event
 *   - Every repaid loan must have one of repay_early / repay_ontime / repay_late
 *   - Every liquidated loan must have a 'liquidated' event
 *
 * Detected gaps are backfilled with the SAME deltas the live writers use
 * (recordCreditEvent's hardcoded map), then affected users' scores are
 * recomputed.
 *
 * Why a watchdog vs only the live writers:
 *   - PRs that touch loan-write paths CAN have bugs that silently drop
 *     the credit_events emit (the FxDAn6 dashboard-zero-points issue
 *     was exactly this — the recordLoan path didn't emit borrow events
 *     for site-native borrowers from launch until PR #84 on 2026-06-12).
 *   - A loan created BETWEEN the bug shipping and the fix shipping has
 *     no live mechanism that re-tries. Only a sweeper catches it.
 *   - Operator-stated mandate: "make sure we have parameters in place
 *     for this to NEVER happen again." This is the parameter.
 *
 * Cadence: every 6 hours. Audit query is two LEFT JOINs over loans +
 * credit_events; both tables are indexed. Cheap.
 *
 * Self-monitor probe (in self-monitor.js) reads the same query at every
 * 60s tick and DMs the operator if gap > 0, so the operator finds out
 * within a minute rather than waiting for the healer's 6h cadence.
 *
 * Security:
 *   - Read-only audit query + INSERT into credit_events + UPDATE on
 *     users.credit_score via recomputeScore. No external surface.
 *   - WHERE ... AND ce.id IS NULL guards against double-credit (the
 *     re-running this sweep can never re-add an event for a loan that
 *     already has one).
 */
import { query } from "../db/pool.js";

const TICK_MS = 6 * 60 * 60_000; // 6h

let _timer = null;

/**
 * One-shot audit + backfill. Returns counts for the operator/logging.
 * Idempotent: re-running cannot double-emit because the SELECT only
 * picks loans whose canonical event is missing.
 */
export async function healCreditEvents() {
  let borrowFilled = 0;
  let repayFilled = 0;
  let liquidatedFilled = 0;

  // 1. Backfill missing 'borrow' events for every loan (any status).
  try {
    const r = await query(`
      INSERT INTO credit_events (user_id, loan_id, event_type, score_delta, metadata, created_at)
      SELECT l.user_id, l.id, 'borrow', 3,
             jsonb_build_object(
               'lamports', l.original_loan_amount_lamports::text,
               'backfill', true,
               'reason', 'healer'
             ),
             l.created_at
        FROM loans l
        LEFT JOIN credit_events ce
               ON ce.loan_id = l.id
              AND ce.event_type = 'borrow'
              AND ce.user_id = l.user_id
       WHERE ce.id IS NULL
       RETURNING user_id
    `);
    borrowFilled = r.rows.length;
    if (borrowFilled > 0) {
      await recomputeAffected(r.rows);
    }
  } catch (err) {
    console.error("[credit-healer] borrow backfill failed:", err.message);
  }

  // 2. Backfill missing repay events. Choose the right subtype based on
  //    when the loan was repaid relative to due. We rely on
  //    updated_at as a proxy for repaid_at since loans.status='repaid'
  //    doesn't carry a dedicated repaid_at column.
  try {
    const r = await query(`
      WITH eligible AS (
        SELECT l.id, l.user_id, l.due_timestamp, l.updated_at
          FROM loans l
          LEFT JOIN credit_events ce
                 ON ce.loan_id = l.id
                AND ce.event_type IN ('repay_early', 'repay_ontime', 'repay_late')
                AND ce.user_id = l.user_id
         WHERE l.status = 'repaid' AND ce.id IS NULL
      )
      INSERT INTO credit_events (user_id, loan_id, event_type, score_delta, metadata, created_at)
      SELECT user_id, id,
             CASE
               WHEN updated_at > due_timestamp THEN 'repay_late'
               WHEN due_timestamp - updated_at > INTERVAL '24 hours' THEN 'repay_early'
               ELSE 'repay_ontime'
             END,
             CASE
               WHEN updated_at > due_timestamp THEN -10
               WHEN due_timestamp - updated_at > INTERVAL '24 hours' THEN 20
               ELSE 15
             END,
             jsonb_build_object('backfill', true, 'reason', 'healer'),
             updated_at
        FROM eligible
       RETURNING user_id
    `);
    repayFilled = r.rows.length;
    if (repayFilled > 0) {
      await recomputeAffected(r.rows);
    }
  } catch (err) {
    console.error("[credit-healer] repay backfill failed:", err.message);
  }

  // 3. Backfill missing 'liquidated' events.
  try {
    const r = await query(`
      INSERT INTO credit_events (user_id, loan_id, event_type, score_delta, metadata, created_at)
      SELECT l.user_id, l.id, 'liquidated', -40,
             jsonb_build_object('backfill', true, 'reason', 'healer'),
             COALESCE(l.updated_at, l.created_at)
        FROM loans l
        LEFT JOIN credit_events ce
               ON ce.loan_id = l.id
              AND ce.event_type = 'liquidated'
              AND ce.user_id = l.user_id
       WHERE l.status = 'liquidated' AND ce.id IS NULL
       RETURNING user_id
    `);
    liquidatedFilled = r.rows.length;
    if (liquidatedFilled > 0) {
      await recomputeAffected(r.rows);
    }
  } catch (err) {
    console.error("[credit-healer] liquidated backfill failed:", err.message);
  }

  const total = borrowFilled + repayFilled + liquidatedFilled;
  if (total > 0) {
    console.log(`[credit-healer] backfilled borrow=${borrowFilled} repay=${repayFilled} liquidated=${liquidatedFilled}`);
  }
  return { borrowFilled, repayFilled, liquidatedFilled, total };
}

async function recomputeAffected(rows) {
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { recomputeScore } = await import("./credit-score.js");
  for (const uid of userIds) {
    try { await recomputeScore(uid); } catch (e) {
      console.warn(`[credit-healer] recomputeScore failed uid=${uid}:`, e.message);
    }
  }
}

/**
 * Pure audit — no INSERTs. Used by the self-monitor probe so the
 * operator-facing alert can quote concrete counts.
 */
export async function auditCreditCoverage() {
  const [{ rows: a }, { rows: b }, { rows: c }] = await Promise.all([
    query(`
      SELECT count(*)::int AS n FROM loans l
        LEFT JOIN credit_events ce ON ce.loan_id = l.id AND ce.event_type = 'borrow' AND ce.user_id = l.user_id
       WHERE ce.id IS NULL
    `),
    query(`
      SELECT count(*)::int AS n FROM loans l
        LEFT JOIN credit_events ce ON ce.loan_id = l.id AND ce.event_type IN ('repay_early','repay_ontime','repay_late') AND ce.user_id = l.user_id
       WHERE l.status = 'repaid' AND ce.id IS NULL
    `),
    query(`
      SELECT count(*)::int AS n FROM loans l
        LEFT JOIN credit_events ce ON ce.loan_id = l.id AND ce.event_type = 'liquidated' AND ce.user_id = l.user_id
       WHERE l.status = 'liquidated' AND ce.id IS NULL
    `),
  ]);
  return {
    missing_borrow: a[0].n,
    missing_repay: b[0].n,
    missing_liquidated: c[0].n,
    total: a[0].n + b[0].n + c[0].n,
  };
}

export function startCreditEventsHealer() {
  if (_timer) return;
  console.log(`[credit-healer] armed — sweeping every ${TICK_MS / 3_600_000}h`);
  // First sweep 5 min after boot; gives the bot time to fully start and
  // the migration runner to settle.
  setTimeout(() => {
    healCreditEvents().catch((e) => console.warn("[credit-healer] sweep threw:", e.message));
    _timer = setInterval(() => {
      healCreditEvents().catch((e) => console.warn("[credit-healer] sweep threw:", e.message));
    }, TICK_MS);
  }, 5 * 60_000);
}

export function stopCreditEventsHealer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
