/**
 * Anomaly detection — the circuit-breaker step.
 *
 * Before the pipeline executes ANY mutation, this layer cross-checks
 * for conditions that suggest the vote may have been compromised or
 * the system is in an unhealthy state. Any flag halts execution and
 * raises an operator alert. False positives are preferred over silent
 * autonomous action on compromised data.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { query } from "../db/pool.js";
import { getProposal } from "./registry.js";

/**
 * Verify the snapshot file's SHA-256 hash matches what was recorded
 * when the proposal was activated. If anything changed on disk after
 * activation, that's tampering and we halt.
 *
 * Returns { ok: true } | { ok: false, reason }.
 */
export function checkSnapshotIntegrity(snapshotPath, expectedHash) {
  let bytes;
  try {
    bytes = readFileSync(snapshotPath);
  } catch (err) {
    return { ok: false, reason: `snapshot_file_unreadable: ${err.message}` };
  }
  const computed = createHash("sha256").update(bytes).digest("hex");
  if (computed !== expectedHash) {
    return {
      ok: false,
      reason: `snapshot_hash_mismatch: expected ${expectedHash}, got ${computed}`,
    };
  }
  return { ok: true };
}

/**
 * Cluster check — were a suspicious number of votes cast in the last
 * 30 minutes of the window? Plausible-deniability heuristic, not a
 * definitive proof of manipulation. Flags for operator review.
 *
 * Returns { ok: true } | { ok: false, reason }.
 */
export async function checkLateVoteCluster(proposalId, windowEndsAtIso, thresholdPct = 25) {
  const windowEnd = new Date(windowEndsAtIso);
  const windowStart = new Date(windowEnd.getTime() - 30 * 60 * 1000);
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE received_at >= $1) AS late,
       COUNT(*) AS total
     FROM governance_votes
     WHERE proposal_id = $2`,
    [windowStart.toISOString(), proposalId],
  );
  const late = Number(rows[0].late);
  const total = Number(rows[0].total);
  if (total === 0) return { ok: true };
  const latePct = (late / total) * 100;
  if (latePct > thresholdPct) {
    return {
      ok: false,
      reason: `late_vote_cluster: ${latePct.toFixed(1)}% of votes in last 30min (threshold ${thresholdPct}%)`,
    };
  }
  return { ok: true };
}

/**
 * Sanity: was the cast weight plausible relative to eligible weight?
 *
 * If cast >= eligible, something is broken. If cast == 0, no need to
 * panic but flag (could be a quorum failure scenario).
 */
export function checkTallyPlausibility(tally) {
  const cast = BigInt(tally.weights.cast_weight);
  const elig = BigInt(tally.weights.total_eligible_capped);
  if (elig === 0n) {
    return { ok: false, reason: "zero_eligible_weight" };
  }
  if (cast > elig) {
    return { ok: false, reason: `cast_exceeds_eligible: cast=${cast} elig=${elig}` };
  }
  return { ok: true };
}

/**
 * Master kill switch — operator can pause the autopilot via /gov-pause.
 * This is the LAST gate before any state-mutating action.
 */
export async function checkAutopilotEnabled() {
  const { rows } = await query(
    `SELECT enabled, paused_by, paused_at, paused_reason
       FROM governance_autopilot_state WHERE id = 1`,
  );
  if (rows.length === 0) {
    return { ok: false, reason: "autopilot_state_row_missing" };
  }
  if (!rows[0].enabled) {
    return {
      ok: false,
      reason: `autopilot_paused: by=${rows[0].paused_by || "unknown"} at=${rows[0].paused_at?.toISOString?.() || "?"} reason=${rows[0].paused_reason || "(none)"}`,
    };
  }
  return { ok: true };
}

/**
 * Run all anomaly checks. Returns { ok: true, flags: [] } if everything
 * is clean, or { ok: false, flags: [reasons...] } with the failures.
 */
export async function runAnomalyChecks({ proposalId, tally, snapshotPath, expectedSnapshotHash, windowEndsAtIso }) {
  const flags = [];

  const a = checkSnapshotIntegrity(snapshotPath, expectedSnapshotHash);
  if (!a.ok) flags.push(a.reason);

  const b = await checkLateVoteCluster(proposalId, windowEndsAtIso);
  if (!b.ok) flags.push(b.reason);

  const c = checkTallyPlausibility(tally);
  if (!c.ok) flags.push(c.reason);

  const d = await checkAutopilotEnabled();
  if (!d.ok) flags.push(d.reason);

  return { ok: flags.length === 0, flags };
}
