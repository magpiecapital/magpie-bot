/**
 * Protocol Reserve Pool — the 10% share of every loan fee earmarked for
 * the protocol's counter-cyclical buffer (bad-debt cover, emergency
 * fixes, lender wallet backstop). Created by MGP-001 governance vote.
 *
 * Bps is read live from governance_config.protocol_reserve_bps so any
 * future vote that adjusts the share takes effect without a code push.
 *
 * Accrual is idempotent per (loan_db_id, event_type) via the unique
 * constraint on protocol_reserve_events — safe to retry on transient
 * DB errors during recordLoan's accrual block.
 *
 * Spend is intentionally manual + governance-visible. No auto-payout
 * path. Operator runs a separate spend script when authorized.
 */
import { query } from "../db/pool.js";
import { getRuntimeConfigBps } from "./runtime-config.js";

export const PROTOCOL_RESERVE_BPS_FALLBACK = 1_000; // 10% (matches MGP-001 ratified value)

/**
 * Read the LIVE protocol reserve bps from governance_config.
 */
export async function getProtocolReserveBps() {
  return getRuntimeConfigBps("protocol_reserve_bps", PROTOCOL_RESERVE_BPS_FALLBACK);
}

/**
 * Accrue the reserve share of a single loan-fee event. Idempotent per
 * (loan_db_id, event_type). Mirrors the holder/LP/referral hooks so
 * the caller pattern is uniform.
 *
 * Returns the lamports added on this call, or null if no-op
 * (zero fee, duplicate event, or DB error — never throws).
 */
export async function accrueToProtocolReserve({ loanDbId, feeLamports, eventType }) {
  const fee = BigInt(feeLamports);
  if (fee <= 0n) return null;
  const liveBps = await getProtocolReserveBps();
  const reward = (fee * BigInt(liveBps)) / 10_000n;
  if (reward <= 0n) return null;

  try {
    // Insert the event idempotently first. If the unique constraint
    // catches a duplicate, the pool counter must NOT bump again.
    const ins = await query(
      `INSERT INTO protocol_reserve_events
         (loan_db_id, event_type, fee_lamports, reward_lamports, reward_bps)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (loan_db_id, event_type) DO NOTHING
       RETURNING id`,
      [loanDbId, eventType, fee.toString(), reward.toString(), liveBps],
    );
    if (ins.rows.length === 0) return null; // duplicate — already accrued

    await query(
      `UPDATE protocol_reserve_pool
          SET accrued_lamports = accrued_lamports + $1::numeric,
              last_accrual_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
      [reward.toString()],
    );
    return reward;
  } catch (err) {
    console.error("[protocol-reserve] accrual failed:", err.message);
    return null;
  }
}

/**
 * Credit a pre-computed lamport amount directly to the protocol
 * reserve pool. Same idempotency model as accrueToProtocolReserve
 * (INSERT a protocol_reserve_events row first; if it duplicates,
 * skip the pool counter bump). Used by the Phase 2
 * liquidation-distribution-watcher, which has already done the
 * fraction math against the defaulted-loan net profit. Idempotency
 * key is (loan_db_id, event_type) — caller should use a distinct
 * event_type like 'default_profit' so it doesn't collide with
 * the regular fee-side accrual.
 */
export async function creditProtocolReserveDirect(opts) {
  // Accept either the new ledger-style ({sourceType, sourceId, lamports})
  // OR the legacy ({loanDbId, eventType, lamports}) shape. New callers
  // should use sourceType+sourceId; legacy callers are auto-mapped to
  // sourceType='legacy_'+eventType, sourceId=String(loanDbId).
  const lamports = opts?.lamports;
  let { sourceType, sourceId, metadata } = opts || {};
  if (!sourceType) {
    const { loanDbId, eventType } = opts || {};
    if (eventType) {
      sourceType = `legacy_${eventType}`;
      sourceId = String(loanDbId ?? "null");
    }
  }
  const amt = BigInt(lamports || 0);
  if (amt <= 0n) return null;
  if (!sourceType || sourceId === undefined || sourceId === null) {
    console.error(`[protocol-reserve] CRIT ledger-gated credit called WITHOUT sourceType/sourceId — refusing. amt=${amt}`);
    return null;
  }
  try {
    // Dual-write: pool_credit_events is the canonical idempotency ledger,
    // protocol_reserve_events stays for backward-compat readers.
    const { rows } = await query(
      `WITH ins AS (
         INSERT INTO pool_credit_events (source_type, source_id, pool_kind, lamports, metadata)
         VALUES ($1, $2, 'protocol_reserve', $3::numeric, $4::jsonb)
         ON CONFLICT (source_type, source_id, pool_kind) DO NOTHING
         RETURNING id
       )
       UPDATE protocol_reserve_pool
          SET accrued_lamports = accrued_lamports + $3::numeric,
              last_accrual_at = NOW(),
              updated_at = NOW()
        WHERE id = 1 AND EXISTS (SELECT 1 FROM ins)
        RETURNING accrued_lamports::text AS new_total`,
      [sourceType, String(sourceId), amt.toString(), metadata ? JSON.stringify(metadata) : null],
    );
    return rows.length > 0 ? amt : null;
  } catch (err) {
    console.error("[protocol-reserve] direct credit failed:", err.message);
    return null;
  }
}

/**
 * Current reserve pool state — read-only.
 */
export async function getProtocolReserveState() {
  const { rows } = await query(
    `SELECT accrued_lamports::text AS accrued,
            spent_lamports::text AS spent,
            last_accrual_at,
            updated_at
       FROM protocol_reserve_pool
      WHERE id = 1`,
  );
  if (rows.length === 0) {
    return { accrued_lamports: 0n, spent_lamports: 0n, balance_lamports: 0n };
  }
  const accrued = BigInt(rows[0].accrued);
  const spent = BigInt(rows[0].spent);
  return {
    accrued_lamports: accrued,
    spent_lamports: spent,
    balance_lamports: accrued - spent,
    last_accrual_at: rows[0].last_accrual_at,
    updated_at: rows[0].updated_at,
  };
}
