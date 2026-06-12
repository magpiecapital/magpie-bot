/**
 * Tally + whale-cap math for governance votes.
 *
 * Implements the recursive whale-cap algorithm from
 * protocol-economics.md §5 with a convergence guarantee.
 *
 * Pure functions — no DB, no side effects. Caller passes in the raw
 * voter records (from governance_votes joined with the snapshot file)
 * and gets back a fully-computed tally.
 */

import { query } from "../db/pool.js";

/**
 * Apply the recursive whale-cap algorithm.
 *
 *   weights: Map<voter_pubkey, raw_weight (bigint)>
 *   capFraction: number ∈ (0, 1) — e.g. 0.02 for 2%
 *
 * Returns Map<voter_pubkey, capped_weight (bigint)>.
 * Sum of returned values == sum of input weights (within rounding),
 * EXCEPT in the degenerate case where capFraction × n_voters < 1, in
 * which case some pool weight is "uncapturable" — that excess is
 * returned in the metadata.
 */
export function applyWhaleCap(weights, capFraction) {
  if (weights.size === 0) return { capped: new Map(), uncapturableWeight: 0n };

  // Total raw weight
  let total = 0n;
  for (const w of weights.values()) total += w;
  if (total === 0n) return { capped: new Map(), uncapturableWeight: 0n };

  // Cap amount per voter, in raw weight units
  // Use fixed-point arithmetic via integer math to avoid float drift:
  // capWeight = total × capFraction. capFraction has up to 4 decimal places
  // typically (e.g. 0.0200), so scale by 10_000 and divide.
  const capBps = BigInt(Math.round(capFraction * 10_000));
  const capWeight = (total * capBps) / 10_000n;

  // Mutable working copy
  const result = new Map(weights);

  // Iterate until converged: each iteration either caps more voters or stops.
  let lastCappedCount = -1;
  for (let iter = 0; iter < 100; iter++) {  // hard ceiling — convergence is at most n
    const capped = new Set();
    let cappedWeight = 0n;
    let uncappedRaw = 0n;

    for (const [voter, w] of result) {
      if (w >= capWeight) {
        capped.add(voter);
        cappedWeight += capWeight;
      } else {
        uncappedRaw += weights.get(voter);  // use ORIGINAL weight for uncapped redistribution
      }
    }

    if (capped.size === lastCappedCount) break;  // converged
    lastCappedCount = capped.size;

    // Redistribute (total - cappedWeight) across uncapped voters by original weights
    const remainingPool = total - cappedWeight;
    if (uncappedRaw === 0n) break;

    for (const [voter, _] of result) {
      if (capped.has(voter)) {
        result.set(voter, capWeight);
      } else {
        const origW = weights.get(voter);
        const newW = (remainingPool * origW) / uncappedRaw;
        result.set(voter, newW);
      }
    }
  }

  // Final sanity: sum
  let finalSum = 0n;
  for (const w of result.values()) finalSum += w;
  const uncapturable = total - finalSum;

  return { capped: result, uncapturableWeight: uncapturable };
}

/**
 * Pull eligible voters for a proposal from the snapshot file referenced
 * by the proposal. Returns Map<voter_pubkey, weight_lamports (bigint)>.
 *
 * Snapshot file lives at SNAPSHOT_PATH (operator-private, mode 0600).
 * We read it inline (small enough — < 1 MB typically).
 *
 * Snapshot files are tagged with the snapshot_id they were generated
 * UNDER, not the proposal they're used FOR. A proposal can intentionally
 * reuse another proposal's snapshot (MGP-001 reuses MGP-002's snapshot
 * per the registry's snapshot_id field). The caller passes the
 * expected snapshot_id; this function verifies the file matches that,
 * not the proposal id.
 */
export async function loadEligibleVoters(proposalId, snapshotPath, expectedSnapshotId = null) {
  const fs = await import("node:fs");
  const raw = fs.readFileSync(snapshotPath, "utf8");
  const snap = JSON.parse(raw);
  const expected = expectedSnapshotId ?? proposalId;
  if (snap.proposal_id !== expected) {
    throw new Error(
      `Snapshot file proposal_id (${snap.proposal_id}) does not match expected snapshot id ${expected} — refusing to tally.`,
    );
  }
  const weights = new Map();
  for (const h of snap.categories?.holders ?? []) {
    weights.set(h.wallet, BigInt(h.magpie_balance_raw));
  }
  for (const c of snap.categories?.collateralized_borrowers ?? []) {
    const cur = weights.get(c.wallet) ?? 0n;
    weights.set(c.wallet, cur + BigInt(c.magpie_collateralized_raw));
  }
  return weights;
}

/**
 * DB-backed eligible voters loader. Reads the same data as the file-backed
 * loadEligibleVoters() but from governance_snapshot_weights — necessary
 * for the live tally endpoint running on Railway, where the operator's
 * snapshot file isn't on disk.
 *
 * Sums held_raw + collateralized_raw per wallet (same algebra as the
 * file loader, same algebra as voting-power.js). Both columns are
 * authoritative — collateralized_raw is the wallets whose $MAGPIE is
 * locked in active loans at snapshot time, which the operator explicitly
 * wants counted as voting power per the "include $MAGPIE collateral in
 * voting rights" mandate.
 *
 * Returns Map<voter_pubkey, weight_raw_lamports (bigint)>.
 */
export async function loadEligibleVotersFromDb(snapshotId) {
  const { rows: header } = await query(
    `SELECT total_eligible_weight FROM governance_snapshots WHERE snapshot_id = $1`,
    [snapshotId],
  );
  if (header.length === 0) {
    // No snapshot in DB → tally caller decides what to do. Distinct
    // signal from "snapshot present but voter not eligible" so the API
    // can return a 503 vs a 0-weight tally.
    return null;
  }
  const { rows } = await query(
    `SELECT wallet, held_raw::text AS held, collateralized_raw::text AS collat
       FROM governance_snapshot_weights
      WHERE snapshot_id = $1`,
    [snapshotId],
  );
  const weights = new Map();
  for (const r of rows) {
    const total = BigInt(r.held) + BigInt(r.collat);
    if (total > 0n) weights.set(r.wallet, total);
  }
  return weights;
}

/**
 * Pull the latest-per-voter votes from governance_votes.
 * Voter changing their vote means later signature supersedes earlier.
 * Returns Map<voter_pubkey, 'yes'|'no'|'abstain'>.
 */
export async function loadVotes(proposalId, questionId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (voter_pubkey) voter_pubkey, vote
       FROM governance_votes
       WHERE proposal_id = $1 AND question_id = $2
       ORDER BY voter_pubkey, received_at DESC`,
    [proposalId, questionId],
  );
  const m = new Map();
  for (const r of rows) m.set(r.voter_pubkey, r.vote);
  return m;
}

/**
 * Compute a full tally for a proposal. Returns an object with all
 * the numbers the rest of the pipeline needs.
 */
export async function tallyProposal({
  proposalId,
  questionId,
  snapshotPath = null,
  snapshotId = null,
  expectedSnapshotId = null,
  capFraction = 0.02,
}) {
  // Prefer the DB-backed loader when a snapshotId is provided — required
  // for the API path (Railway has no operator filesystem). Fall back to
  // the file loader for operator-CLI close-time tallies that still read
  // the on-disk authoritative file.
  let eligible;
  if (snapshotId && !snapshotPath) {
    eligible = await loadEligibleVotersFromDb(snapshotId);
    if (!eligible) {
      throw new Error(`snapshot ${snapshotId} not in DB`);
    }
  } else if (snapshotPath) {
    eligible = await loadEligibleVoters(proposalId, snapshotPath, expectedSnapshotId);
  } else {
    throw new Error("tallyProposal requires snapshotId or snapshotPath");
  }
  const votes = await loadVotes(proposalId, questionId);

  // Build raw weights of voters who actually voted, restricted to eligible set
  const voterWeights = new Map();
  for (const [voter, choice] of votes) {
    const w = eligible.get(voter);
    if (!w || w === 0n) continue;  // ineligible voter — silently drop
    voterWeights.set(voter, w);
  }

  // Apply whale cap to voter weights
  const { capped, uncapturableWeight } = applyWhaleCap(voterWeights, capFraction);

  let yesWeight = 0n, noWeight = 0n, abstainWeight = 0n;
  for (const [voter, w] of capped) {
    // Normalize case before comparison. Votes are stored as the literal
    // choice strings from the proposal's `choices` array (e.g. "YES",
    // "NO", "ABSTAIN" for MGP-001 — see ACTIVE_PROPOSALS in
    // src/api/governance-api.js:51-53). Without normalization, every
    // uppercase vote fell into the `else` branch and was counted as
    // abstain — meaning MGP-001's 15+ live YES votes would have tallied
    // as 0% YES, failing the proposal at autopilot close.
    const choice = (votes.get(voter) || "").toLowerCase();
    if (choice === "yes") yesWeight += w;
    else if (choice === "no") noWeight += w;
    else abstainWeight += w;
  }
  const castWeight = yesWeight + noWeight + abstainWeight;

  let totalEligibleWeight = 0n;
  for (const w of eligible.values()) totalEligibleWeight += w;

  // Apply cap to eligible too for participation_pct denominator (consistent denom)
  const { capped: cappedEligible } = applyWhaleCap(eligible, capFraction);
  let totalEligibleCapped = 0n;
  for (const w of cappedEligible.values()) totalEligibleCapped += w;

  const participationPct = totalEligibleCapped === 0n
    ? 0
    : Number((castWeight * 1_000_000n) / totalEligibleCapped) / 10_000;
  const yesShareOfCast = castWeight === 0n
    ? 0
    : Number((yesWeight * 1_000_000n) / castWeight) / 10_000;

  return {
    proposal_id: proposalId,
    question_id: questionId,
    snapshot_path: snapshotPath,
    cap_fraction: capFraction,
    counts: {
      eligible_voters: eligible.size,
      voters_cast: voterWeights.size,
    },
    weights: {
      total_eligible_raw: totalEligibleWeight.toString(),
      total_eligible_capped: totalEligibleCapped.toString(),
      yes_weight: yesWeight.toString(),
      no_weight: noWeight.toString(),
      abstain_weight: abstainWeight.toString(),
      cast_weight: castWeight.toString(),
      uncapturable_weight: uncapturableWeight.toString(),
    },
    percentages: {
      participation_pct: participationPct,
      yes_share_of_cast_pct: yesShareOfCast,
    },
    computed_at: new Date().toISOString(),
  };
}
