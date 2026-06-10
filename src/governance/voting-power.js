/**
 * Voting-power lookup — exposes "what's MY voting weight on proposal X?"
 *
 * Reads the proposal's snapshot file, returns the caller's eligible
 * weight, post-whale-cap weight, and their share of the eligible pool.
 *
 * Used by:
 *   - /votingpower TG command (caller's wallet looked up via /me state)
 *   - dashboard /api/v1/governance/voting-power?wallet=...&proposal_id=...
 *   - Pip nudges when user mentions voting
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_DIR = process.env.GOVERNANCE_SNAPSHOT_DIR || `${process.env.HOME}/.magpie-private/snapshots`;

/**
 * Find the most recent snapshot file for a snapshot_id.
 * Returns null if not found.
 */
function findSnapshotFile(snapshotId) {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith(snapshotId + "-") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return null;
    return join(SNAPSHOT_DIR, files[files.length - 1]);
  } catch {
    return null;
  }
}

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
 */
export function getVotingPower({ wallet, proposalId, snapshotId, capFraction = 0.02 }) {
  const snapId = snapshotId || proposalId;
  const path = findSnapshotFile(snapId);
  if (!path) {
    return {
      eligible: false,
      wallet,
      reason: "no_snapshot_found",
      snapshot_id: snapId,
    };
  }
  let snap;
  try {
    snap = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { eligible: false, wallet, reason: `snapshot_unreadable: ${err.message}` };
  }
  const holder = (snap.categories?.holders ?? []).find((h) => h.wallet === wallet);
  const collat = (snap.categories?.collateralized_borrowers ?? []).find((c) => c.wallet === wallet);
  const held = holder ? BigInt(holder.magpie_balance_raw) : 0n;
  const locked = collat ? BigInt(collat.magpie_collateralized_raw) : 0n;
  const raw = held + locked;

  if (raw === 0n) {
    return {
      eligible: false,
      wallet,
      reason: "wallet_not_in_snapshot_or_zero_balance",
      snapshot_id: snapId,
      snapshot_taken_at: snap.taken_at_utc,
    };
  }

  // Compute pool totals (raw and capped)
  let totalRaw = 0n;
  const allWeights = new Map();
  for (const h of snap.categories?.holders ?? []) {
    const w = BigInt(h.magpie_balance_raw);
    allWeights.set(h.wallet, w);
    totalRaw += w;
  }
  for (const c of snap.categories?.collateralized_borrowers ?? []) {
    const cur = allWeights.get(c.wallet) ?? 0n;
    const add = BigInt(c.magpie_collateralized_raw);
    allWeights.set(c.wallet, cur + add);
    totalRaw += add;
  }

  // Per-wallet cap in raw units
  const capBps = BigInt(Math.round(capFraction * 10_000));
  const capWeight = (totalRaw * capBps) / 10_000n;
  const cappedRaw = raw > capWeight ? capWeight : raw;

  const pctOfPool = Number((raw * 1_000_000n) / totalRaw) / 10_000;
  const cappedPct = Number((cappedRaw * 1_000_000n) / totalRaw) / 10_000;

  return {
    eligible: true,
    wallet,
    snapshot_id: snapId,
    snapshot_taken_at: snap.taken_at_utc,
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
