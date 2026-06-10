/**
 * Voting-power lookup — exposes "what's MY voting weight on proposal X?"
 *
 * Reads from the governance_snapshots + governance_snapshot_weights DB
 * tables. The snapshot's JSON file remains on the snapshot-author's disk
 * as the operator-private master record (mode 0600); the DB stores a
 * normalized, queryable mirror so the bot (on Railway / any ephemeral
 * filesystem) can answer per-wallet voting weight without disk access.
 */

import { query } from "../db/pool.js";

/**
 * Lookup voting power for a given (wallet, proposal_id).
 *
 * Returns:
 *   {
 *     eligible: bool,
 *     wallet,
 *     snapshot_taken_at,
 *     snapshot_id,
 *     raw_weight: string (lamports of $MAGPIE),
 *     held_raw: string,
 *     collateralized_raw: string,
 *     weight_pct_of_pool: number,  // pre-cap
 *     capped_pct_of_pool: number,  // post-cap (max = cap)
 *     total_eligible_weight: string,
 *     cap_fraction: number,
 *     reason?: string              // present when eligible=false
 *   }
 *
 * NOTE: async now (DB-backed). Previous file-backed version was sync.
 */
export async function getVotingPower({ wallet, proposalId, snapshotId, capFraction = 0.02 }) {
  const snapId = snapshotId || proposalId;

  const headerRes = await query(
    `SELECT taken_at_utc, total_eligible_weight, hash_sha256
       FROM governance_snapshots WHERE snapshot_id = $1`,
    [snapId],
  );
  if (headerRes.rows.length === 0) {
    return {
      eligible: false,
      wallet,
      reason: "no_snapshot_in_db",
      snapshot_id: snapId,
    };
  }
  const header = headerRes.rows[0];
  const totalRaw = BigInt(header.total_eligible_weight);

  const weightRes = await query(
    `SELECT held_raw::text AS held, collateralized_raw::text AS collat, lp_shares::text AS lp
       FROM governance_snapshot_weights
       WHERE snapshot_id = $1 AND wallet = $2`,
    [snapId, wallet],
  );
  const row = weightRes.rows[0];
  const held = BigInt(row?.held ?? "0");
  const locked = BigInt(row?.collat ?? "0");
  const raw = held + locked;

  if (raw === 0n) {
    return {
      eligible: false,
      wallet,
      reason: "wallet_not_in_snapshot_or_zero_balance",
      snapshot_id: snapId,
      snapshot_taken_at: header.taken_at_utc,
    };
  }

  const capBps = BigInt(Math.round(capFraction * 10_000));
  const capWeight = (totalRaw * capBps) / 10_000n;
  const cappedRaw = raw > capWeight ? capWeight : raw;

  const pctOfPool = Number((raw * 1_000_000n) / totalRaw) / 10_000;
  const cappedPct = Number((cappedRaw * 1_000_000n) / totalRaw) / 10_000;

  return {
    eligible: true,
    wallet,
    snapshot_id: snapId,
    snapshot_taken_at: header.taken_at_utc,
    raw_weight: raw.toString(),
    held_raw: held.toString(),
    collateralized_raw: locked.toString(),
    cap_fraction: capFraction,
    capped_weight: cappedRaw.toString(),
    weight_pct_of_pool: pctOfPool,
    capped_pct_of_pool: cappedPct,
    total_eligible_weight: totalRaw.toString(),
    was_capped: raw > capWeight,
  };
}
