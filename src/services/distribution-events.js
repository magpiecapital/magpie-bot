/**
 * Distribution events — the unified investor-facing accounting layer.
 *
 * One row per distribution event regardless of kind. Per-kind detail
 * tables stay as source of truth for per-wallet payouts; this rolls them
 * up into a single canonical stream for the public /distributions page
 * and for any future investor-grade reporting.
 *
 * Kinds:
 *   - holder_reward     — $MAGPIE pro-rata distributions
 *   - governance        — MGP-NNN ratification payouts
 *   - lp_loyalty        — LP share-seconds distributions
 *   - yield             — generic LP-yield distributions
 *   - loan_remediation  — refunds / remediation payments
 *
 * See feedback_unified_distribution_accounting.md for the rule.
 */
import { query } from "../db/pool.js";

/**
 * Upsert a distribution_events row.
 *
 * Idempotent on (kind, external_ref) — re-running with the same
 * external_ref updates the existing row rather than inserting a
 * duplicate. Use this from every distribution writer.
 *
 * @param {Object} ev
 * @param {string} ev.kind                     - one of the CHECK kinds
 * @param {string} ev.external_ref             - e.g. "MGP-001", "holder-2026-06-19"
 * @param {Date|string} ev.snapshot_at         - when the eligible set was captured
 * @param {Date|string} [ev.paid_first_at]
 * @param {Date|string} [ev.paid_last_at]
 * @param {bigint|string} [ev.pool_lamports]
 * @param {bigint|string} [ev.distributed_lamports]
 * @param {bigint|string} [ev.unpaid_lamports]
 * @param {number} [ev.eligible_wallet_count]
 * @param {number} [ev.paid_wallet_count]
 * @param {number} [ev.unpayable_wallet_count]
 * @param {string} [ev.denominator_kind]
 * @param {bigint|string} [ev.denominator_value]
 * @param {bigint|string} [ev.min_payout_lamports]
 * @param {bigint|string} [ev.max_payout_lamports]
 * @param {bigint|string} [ev.median_payout_lamports]
 * @param {bigint|string} [ev.source_borrow_fees_lamports]
 * @param {bigint|string} [ev.source_liquidation_lamports]
 * @param {bigint|string} [ev.source_other_lamports]
 * @param {string} [ev.plan_hash]
 * @param {string} [ev.snapshot_hash]
 * @param {string[]} [ev.sample_tx_signatures]
 * @param {string} [ev.notes]
 * @param {string} [ev.status]
 * @param {Object} [ev.metadata]
 */
export async function upsertDistributionEvent(ev) {
  if (!ev?.kind || !ev?.external_ref) {
    throw new Error("upsertDistributionEvent requires kind + external_ref");
  }
  const sql = `
    INSERT INTO distribution_events (
      kind, external_ref, snapshot_at,
      paid_first_at, paid_last_at,
      pool_lamports, distributed_lamports, unpaid_lamports,
      eligible_wallet_count, paid_wallet_count, unpayable_wallet_count,
      denominator_kind, denominator_value,
      min_payout_lamports, max_payout_lamports, median_payout_lamports,
      source_borrow_fees_lamports, source_liquidation_lamports, source_other_lamports,
      plan_hash, snapshot_hash, sample_tx_signatures, notes, status, metadata
    ) VALUES (
      $1, $2, $3,
      $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13,
      $14, $15, $16,
      $17, $18, $19,
      $20, $21, $22, $23, $24, $25
    )
    ON CONFLICT (kind, external_ref) DO UPDATE SET
      snapshot_at                    = EXCLUDED.snapshot_at,
      paid_first_at                  = COALESCE(EXCLUDED.paid_first_at, distribution_events.paid_first_at),
      paid_last_at                   = COALESCE(EXCLUDED.paid_last_at, distribution_events.paid_last_at),
      pool_lamports                  = COALESCE(EXCLUDED.pool_lamports, distribution_events.pool_lamports),
      distributed_lamports           = EXCLUDED.distributed_lamports,
      unpaid_lamports                = EXCLUDED.unpaid_lamports,
      eligible_wallet_count          = EXCLUDED.eligible_wallet_count,
      paid_wallet_count              = EXCLUDED.paid_wallet_count,
      unpayable_wallet_count         = EXCLUDED.unpayable_wallet_count,
      denominator_kind               = COALESCE(EXCLUDED.denominator_kind, distribution_events.denominator_kind),
      denominator_value              = COALESCE(EXCLUDED.denominator_value, distribution_events.denominator_value),
      min_payout_lamports            = EXCLUDED.min_payout_lamports,
      max_payout_lamports            = EXCLUDED.max_payout_lamports,
      median_payout_lamports         = EXCLUDED.median_payout_lamports,
      source_borrow_fees_lamports    = EXCLUDED.source_borrow_fees_lamports,
      source_liquidation_lamports    = EXCLUDED.source_liquidation_lamports,
      source_other_lamports          = EXCLUDED.source_other_lamports,
      plan_hash                      = COALESCE(EXCLUDED.plan_hash, distribution_events.plan_hash),
      snapshot_hash                  = COALESCE(EXCLUDED.snapshot_hash, distribution_events.snapshot_hash),
      sample_tx_signatures           = COALESCE(EXCLUDED.sample_tx_signatures, distribution_events.sample_tx_signatures),
      notes                          = COALESCE(EXCLUDED.notes, distribution_events.notes),
      status                         = EXCLUDED.status,
      metadata                       = COALESCE(EXCLUDED.metadata, distribution_events.metadata),
      updated_at                     = NOW()
    RETURNING id
  `;
  const params = [
    ev.kind,
    ev.external_ref,
    ev.snapshot_at,
    ev.paid_first_at ?? null,
    ev.paid_last_at ?? null,
    ev.pool_lamports != null ? String(ev.pool_lamports) : null,
    ev.distributed_lamports != null ? String(ev.distributed_lamports) : "0",
    ev.unpaid_lamports != null ? String(ev.unpaid_lamports) : "0",
    ev.eligible_wallet_count ?? 0,
    ev.paid_wallet_count ?? 0,
    ev.unpayable_wallet_count ?? 0,
    ev.denominator_kind ?? null,
    ev.denominator_value != null ? String(ev.denominator_value) : null,
    ev.min_payout_lamports != null ? String(ev.min_payout_lamports) : null,
    ev.max_payout_lamports != null ? String(ev.max_payout_lamports) : null,
    ev.median_payout_lamports != null ? String(ev.median_payout_lamports) : null,
    ev.source_borrow_fees_lamports != null ? String(ev.source_borrow_fees_lamports) : "0",
    ev.source_liquidation_lamports != null ? String(ev.source_liquidation_lamports) : "0",
    ev.source_other_lamports != null ? String(ev.source_other_lamports) : "0",
    ev.plan_hash ?? null,
    ev.snapshot_hash ?? null,
    ev.sample_tx_signatures ?? null,
    ev.notes ?? null,
    ev.status ?? "planned",
    ev.metadata != null ? JSON.stringify(ev.metadata) : null,
  ];
  const { rows } = await query(sql, params);
  return rows[0]?.id;
}

/**
 * Return the public-facing list of distribution events.
 * Excludes nothing — all kinds together, newest first, with lifetime
 * aggregates included so a single API call powers the whole /distributions page.
 */
export async function listDistributionEventsPublic({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) | 0));
  const events = await query(
    `SELECT id, kind, external_ref, snapshot_at,
            paid_first_at, paid_last_at,
            distributed_lamports::text                  AS distributed_lamports,
            unpaid_lamports::text                       AS unpaid_lamports,
            eligible_wallet_count, paid_wallet_count, unpayable_wallet_count,
            denominator_kind,
            denominator_value::text                     AS denominator_value,
            min_payout_lamports::text                   AS min_payout_lamports,
            max_payout_lamports::text                   AS max_payout_lamports,
            median_payout_lamports::text                AS median_payout_lamports,
            source_borrow_fees_lamports::text           AS source_borrow_fees_lamports,
            source_liquidation_lamports::text           AS source_liquidation_lamports,
            source_other_lamports::text                 AS source_other_lamports,
            sample_tx_signatures,
            notes, status, metadata
       FROM distribution_events
      ORDER BY snapshot_at DESC
      LIMIT $1`,
    [lim],
  );
  const totals = await query(
    `SELECT COUNT(*)::int                                                AS event_count,
            COALESCE(SUM(distributed_lamports), 0)::text                 AS lifetime_distributed_lamports,
            COALESCE(SUM(paid_wallet_count), 0)::int                     AS lifetime_payout_count,
            MIN(snapshot_at)                                             AS first_event_at,
            MAX(COALESCE(paid_last_at, snapshot_at))                     AS most_recent_event_at,
            COUNT(*) FILTER (WHERE kind = 'holder_reward')::int          AS holder_reward_count,
            COUNT(*) FILTER (WHERE kind = 'governance')::int             AS governance_count,
            COUNT(*) FILTER (WHERE kind = 'lp_loyalty')::int             AS lp_loyalty_count,
            COUNT(*) FILTER (WHERE kind = 'yield')::int                  AS yield_count,
            COUNT(*) FILTER (WHERE kind = 'loan_remediation')::int       AS loan_remediation_count
       FROM distribution_events`,
  );
  return { events: events.rows, totals: totals.rows[0] };
}
