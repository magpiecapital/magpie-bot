/**
 * points.js — the user POINTS ledger (truth) + a fast-read running balance.
 * ─────────────────────────────────────────────────────────────────────────
 * Mirrors the pool_credit_events idempotency pattern verbatim: an append-only
 * `points_events` table whose UNIQUE(source_type, source_id) IS the entire
 * double-credit guarantee, plus a single-row-per-user `user_points_balance`
 * counter kept in lock-step via a gated CTE. Every credit goes through
 * `creditPoints`, so the retroactive backfill, the live forward-sync, and the
 * reconciler all converge on the SAME ids and can never double-count.
 *
 * Invariants:
 *  - Points are FORWARD-ONLY (positive only). Penalties (e.g. liquidation) write
 *    ZERO points, never a subtraction — matching the published "Liquidation =
 *    0 pts, existing balance untouched".
 *  - This module is a READ-SIDE derivation over activity. It NEVER writes to
 *    loans / collateral / vault state. Safe by construction.
 */
import { query } from "../db/pool.js";

// DDL also lives in pool.js applyStartupPatches (so the deployed bot creates it);
// re-declared here so the backfill/reconciler can run standalone via `railway run`.
export const POINTS_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS points_events (
     id          BIGSERIAL PRIMARY KEY,
     user_id     BIGINT      NOT NULL,
     source_type TEXT        NOT NULL,
     source_id   TEXT        NOT NULL,
     category    TEXT        NOT NULL,
     points      BIGINT      NOT NULL CHECK (points > 0),
     metadata    JSONB,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (source_type, source_id)
   )`,
  `CREATE INDEX IF NOT EXISTS points_events_user_created_idx ON points_events(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS points_events_user_cat_idx ON points_events(user_id, category)`,
  `CREATE TABLE IF NOT EXISTS user_points_balance (
     user_id      BIGINT PRIMARY KEY,
     total_points BIGINT NOT NULL DEFAULT 0 CHECK (total_points >= 0),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];

let _ensured = false;
export async function ensurePointsTables() {
  if (_ensured) return;
  for (const sql of POINTS_TABLES_SQL) await query(sql);
  _ensured = true;
}

/**
 * Idempotently credit points. Safe to call repeatedly with the same
 * (sourceType, sourceId): the ledger INSERT is a no-op on conflict and the
 * balance only moves when the insert actually inserted. Returns the new running
 * total, or null when it was a duplicate / invalid / non-positive (0 writes
 * nothing). Callers on hot paths still wrap this in try/catch — it must never
 * delay or fail a loan/repay tx.
 */
export async function creditPoints({ userId, sourceType, sourceId, category, points, metadata }) {
  if (!userId || !sourceType || !sourceId || !category) {
    console.warn("[points] refusing credit — missing id fields", { userId, sourceType, sourceId, category });
    return null;
  }
  const pts = Math.floor(Number(points) || 0);
  if (pts <= 0) return null; // points are positive-only (liquidation etc. = 0 = no row)
  const r = await query(
    `WITH ins AS (
       INSERT INTO points_events (user_id, source_type, source_id, category, points, metadata)
       VALUES ($1, $2, $3, $4, $5::bigint, $6::jsonb)
       ON CONFLICT (source_type, source_id) DO NOTHING
       RETURNING points
     ),
     bal AS (
       INSERT INTO user_points_balance (user_id, total_points)
       SELECT $1, points FROM ins
       ON CONFLICT (user_id) DO UPDATE
         SET total_points = user_points_balance.total_points + EXCLUDED.total_points,
             updated_at = NOW()
       RETURNING total_points
     )
     SELECT total_points FROM bal`,
    [String(userId), sourceType, sourceId, category, pts, metadata ? JSON.stringify(metadata) : null],
  );
  return r.rows[0]?.total_points ?? null;
}

/** Tier multiplier from a loan's duration (published: Express 2d ×1.5,
 *  Quick 3d ×1.25, Standard 7d ×1.0). */
export function tierMultForDuration(durationDays) {
  const d = Number(durationDays) || 7;
  if (d <= 2) return 1.5;
  if (d <= 3) return 1.25;
  return 1.0;
}

/** Canonical borrow points for a loan: floor(loanSOL × 100 × tierMult). */
export function borrowPoints({ loanLamports, durationDays }) {
  const sol = Number(loanLamports) / 1e9;
  if (!Number.isFinite(sol) || sol <= 0) return 0;
  return Math.floor(sol * 100 * tierMultForDuration(durationDays));
}

/** Repay bonus as a fraction of the loan's base borrow points: early +25%,
 *  on-time +10%, late 0 (published). One repay bonus per loan. */
export function repayBonusPoints(base, variant) {
  const pct = variant === "repay_early" ? 0.25 : variant === "repay_ontime" ? 0.10 : 0;
  return Math.floor(base * pct);
}

export const FIRST_LOAN_BONUS = 500;
