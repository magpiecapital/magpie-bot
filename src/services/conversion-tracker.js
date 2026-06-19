/**
 * Conversion telemetry: every borrow / arm / fire / repay attempt
 * writes a row to `conversion_events`. This is the foundation for the
 * conversion-reliability work — without per-path / per-mint / per-version
 * visibility, we find out about failures from user complaints in TG
 * instead of from the dashboard.
 *
 * Operator-mandated 2026-06-19 (3rd reaffirmation):
 *   "We need to do everything in our power to make sure the loan
 *    conversions execute. … But we cannot be in a situation where a
 *    user has a 50/50 chance of executing their loan without getting
 *    some type of error message."
 *
 * Phase 1 of the conversion-reliability mandate. See
 * [[feedback_loan_conversions_must_execute_zero_50_50]] for the full
 * 4-phase plan + the four-path failure inventory.
 *
 * Fire-and-forget API on purpose — every recordConversionEvent() call
 * swallows DB errors. We NEVER want telemetry to bubble up and break
 * the actual conversion path. Visibility must not come at the cost of
 * reliability.
 */
import { query } from "../db/pool.js";

/**
 * Record one conversion attempt. Always fire-and-forget — caller does
 * not need to await this (although awaiting is fine for tests).
 *
 * @param {Object} ev
 * @param {'borrow'|'arm'|'fire'|'repay'} ev.path        - REQUIRED
 * @param {'success'|'failure'} ev.outcome              - REQUIRED
 * @param {string} [ev.failureClass]  - classifier class for failures (e.g. 'twap_warming_timeout')
 * @param {string} [ev.mint]          - collateral mint
 * @param {string} [ev.programId]     - V1/V3/V4 program id (base58)
 * @param {string} [ev.wallet]        - borrower wallet (base58)
 * @param {number|bigint|string} [ev.userId]  - Telegram user id when known
 * @param {string} [ev.surface]       - 'tg' | 'site' | 'pip' | 'agent' | 'engine'
 * @param {number} [ev.latencyMs]     - end-to-end latency in ms
 * @param {Object} [ev.detail]        - arbitrary forensic detail (small, JSONB)
 * @returns {Promise<void>}
 */
export async function recordConversionEvent(ev) {
  if (!ev?.path || !ev?.outcome) {
    console.warn("[conv-tracker] recordConversionEvent missing path/outcome — ignoring");
    return;
  }
  try {
    await query(
      `INSERT INTO conversion_events (
         path, outcome, failure_class, mint, program_id, wallet, user_id,
         surface, latency_ms, detail
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ev.path,
        ev.outcome,
        ev.failureClass ?? null,
        ev.mint ?? null,
        ev.programId ?? null,
        ev.wallet ?? null,
        ev.userId != null ? String(ev.userId) : null,
        ev.surface ?? null,
        ev.latencyMs ?? null,
        ev.detail != null ? JSON.stringify(ev.detail) : null,
      ],
    );
  } catch (err) {
    // Fire-and-forget — telemetry must NEVER break the conversion path.
    console.warn("[conv-tracker] DB write failed (swallowing):", err?.message?.slice(0, 160));
  }
}

/**
 * Compute success-rate aggregates over a time window. Used by
 * /conv-stats and probeConversionRate.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowSec=3600]  - window in seconds (default 1h)
 * @param {string} [opts.groupBy='path']  - 'path' | 'mint' | 'program' | 'path_mint' | 'path_program'
 * @returns {Promise<Array<{group_key, attempts, successes, failures, success_rate}>>}
 */
export async function getConversionStats({
  windowSec = 3600,
  groupBy = "path",
} = {}) {
  const groupBys = {
    path: "path",
    mint: "COALESCE(mint, '<no-mint>')",
    program: "COALESCE(program_id, '<no-program>')",
    path_mint: "path || '|' || COALESCE(mint, '<no-mint>')",
    path_program: "path || '|' || COALESCE(program_id, '<no-program>')",
  };
  const groupExpr = groupBys[groupBy] || groupBys.path;
  const { rows } = await query(
    `SELECT ${groupExpr} AS group_key,
            COUNT(*)::int AS attempts,
            COUNT(*) FILTER (WHERE outcome = 'success')::int AS successes,
            COUNT(*) FILTER (WHERE outcome = 'failure')::int AS failures
       FROM conversion_events
      WHERE created_at >= NOW() - ($1 || ' seconds')::interval
   GROUP BY group_key
   ORDER BY attempts DESC`,
    [String(windowSec)],
  );
  return rows.map((r) => ({
    ...r,
    success_rate: r.attempts > 0 ? r.successes / r.attempts : null,
  }));
}

/**
 * Return failure-class breakdown over a time window, optionally
 * filtered by path and/or mint.
 */
export async function getConversionFailureClasses({
  windowSec = 3600,
  path,
  mint,
} = {}) {
  const filters = [];
  const params = [String(windowSec)];
  if (path) { params.push(path); filters.push(`AND path = $${params.length}`); }
  if (mint) { params.push(mint); filters.push(`AND mint = $${params.length}`); }
  const { rows } = await query(
    `SELECT COALESCE(failure_class, '<unclassified>') AS klass,
            COUNT(*)::int AS n
       FROM conversion_events
      WHERE created_at >= NOW() - ($1 || ' seconds')::interval
        AND outcome = 'failure'
        ${filters.join(' ')}
   GROUP BY klass
   ORDER BY n DESC`,
    params,
  );
  return rows;
}

/**
 * For the self-monitor probe. Returns each (path, mint) group with at
 * least minAttempts attempts in the last windowSec seconds and whose
 * success_rate is below minSuccessRate. CRIT-DM triggers on any such
 * row.
 */
export async function findDegradedConversionTargets({
  windowSec = 3600,
  minAttempts = 5,
  minSuccessRate = 0.95,
} = {}) {
  const { rows } = await query(
    `WITH grouped AS (
       SELECT path,
              COALESCE(mint, '<no-mint>') AS mint,
              COALESCE(program_id, '<no-program>') AS program_id,
              COUNT(*)::int AS attempts,
              COUNT(*) FILTER (WHERE outcome = 'success')::int AS successes
         FROM conversion_events
        WHERE created_at >= NOW() - ($1 || ' seconds')::interval
        GROUP BY path, mint, program_id
     )
     SELECT path, mint, program_id, attempts, successes,
            successes::float / attempts::float AS success_rate
       FROM grouped
      WHERE attempts >= $2
        AND successes::float / attempts::float < $3
      ORDER BY attempts DESC`,
    [String(windowSec), minAttempts, minSuccessRate],
  );
  return rows;
}
