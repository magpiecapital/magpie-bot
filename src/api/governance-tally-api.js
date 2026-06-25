/**
 * GET /api/v1/governance/tally?proposal_id=MGP-001
 *
 * Returns live aggregate WEIGHTS for an active proposal. Used by the
 * site's live-results bar on the proposal page.
 *
 * Aggregate-only by design. No per-wallet info. No snapshot
 * publication. Same privacy posture as the close-time tally — just
 * recomputed on-demand against the current votes table so voters
 * can see momentum.
 *
 * Cached server-side for 30 seconds. Tally is moderately expensive
 * (reads the full snapshot file, recursive whale-cap converges in
 * up to n iterations). 30s gives the live-results bar fresh enough
 * data to feel real-time without melting the box if /governance gets
 * a traffic spike.
 *
 * Returns 404 for unknown proposals, 409 if the proposal isn't
 * active, 503 if the snapshot file isn't on disk (e.g. running
 * against a dev DB that hasn't generated snapshots).
 */
import { readdirSync } from "node:fs";
import { tallyProposal } from "../governance/tally.js";
import { getProposal } from "../governance/registry.js";
import { query } from "../db/pool.js";

// A clean, FINAL outcome the site can flip a proposal to "completed" on. Error /
// in-flight states (anomaly_held, pipeline_error, pending, in_progress, null) are
// deliberately excluded — those must NOT auto-complete a proposal.
function isFinalOutcome(o) {
  return o === "passed" || o === "failed" || o === "operator_discretion" || /^[A-E]$/.test(o || "");
}

const SNAPSHOT_DIR = process.env.GOVERNANCE_SNAPSHOT_DIR || `${process.env.HOME}/.magpie-private/snapshots`;
const CACHE_TTL_MS = 30_000;
const cache = new Map(); // proposal_id → { expiresAt, body }

function findSnapshotFile(snapshotId) {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith(snapshotId + "-") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return null;
    return `${SNAPSHOT_DIR}/${files[files.length - 1]}`;
  } catch {
    return null;
  }
}

export async function handleGovernanceTally(req, url) {
  const proposalId = url.searchParams.get("proposal_id");
  if (!proposalId) {
    return { status: 400, body: { error: "Missing proposal_id" } };
  }
  const proposal = getProposal(proposalId);
  if (!proposal) {
    return { status: 404, body: { error: `Unknown proposal: ${proposalId}` } };
  }
  // Time-based activation gate (registry doesn't use a status field — the
  // voting window is the truth). Tally is meaningful from voting_started
  // onward; results after close are the final-but-not-yet-announced
  // numbers (the autopilot will publish them via the announcement template).
  const startsAt = proposal.voting_started_at_iso ? Date.parse(proposal.voting_started_at_iso) : null;
  const now = Date.now();
  if (startsAt && now < startsAt) {
    return { status: 409, body: { error: `Voting for ${proposalId} hasn't started yet`, voting_started_at_iso: proposal.voting_started_at_iso } };
  }
  if (proposal.proposal_type === "withdrawn") {
    return { status: 409, body: { error: `Proposal ${proposalId} is withdrawn` } };
  }
  const cached = cache.get(proposalId);
  if (cached && cached.expiresAt > now) {
    return { status: 200, body: cached.body };
  }

  // Tally reads from the DB-backed snapshot mirror first (the only path
  // that works on Railway — the operator's filesystem snapshot isn't on
  // disk here). Falls back to the filesystem path for operator CLI use.
  const snapshotId = proposal.snapshot_id ?? proposalId;
  const snapshotPath = findSnapshotFile(snapshotId);

  let tally;
  try {
    tally = await tallyProposal({
      proposalId,
      questionId: "Vote",
      // Prefer DB when filesystem isn't available. tallyProposal picks
      // the right loader based on which arg is set.
      snapshotId: snapshotPath ? null : snapshotId,
      snapshotPath: snapshotPath ?? null,
      expectedSnapshotId: snapshotId,
      capFraction: 0.02,
    });
  } catch (err) {
    // Detect "snapshot truly missing" specifically — distinct from a
    // generic tally compute error.
    if (err.message?.includes("not in DB")) {
      return {
        status: 503,
        body: { error: "Snapshot not available — tally cannot be computed", proposal_id: proposalId },
      };
    }
    // Internal error details are NEVER bubbled to the public response.
    // Node's fs.readFileSync error messages include the absolute path
    // (e.g. "ENOENT: no such file or directory, open
    // '/Users/<operator>/.magpie-private/snapshots/MGP-001-…json'")
    // — that leaks both the operator-internal snapshot directory and
    // the operator's local username. Log server-side, respond opaquely.
    console.error("[gov-tally] failed:", err);
    return {
      status: 500,
      body: { error: "Tally failed" },
    };
  }

  // Strip anything we don't want public. Snapshot path is operator-
  // internal; eligible voter count is fine (it's the snapshot size,
  // not the wallet set); voter counts and the aggregate weight totals
  // are fine.
  const body = {
    proposal_id: tally.proposal_id,
    voting_started_at_iso: proposal.voting_started_at_iso,
    voting_ends_at_iso: proposal.voting_ends_at_iso,
    quorum_pct: proposal.quorum_pct,
    threshold_pct: proposal.threshold_pct,
    counts: tally.counts,
    weights: tally.weights,
    percentages: tally.percentages,
    computed_at: tally.computed_at,
    cap_fraction: tally.cap_fraction,
  };

  // ── Final outcome (set by the autopilot at close) ──────────────────────────
  // Once voting has ended and the pipeline has computed + persisted the result,
  // expose it so the SITE can auto-flip the proposal to its final state (winning
  // option / passed / failed / operator_discretion) with NO manual edit. Null
  // while voting is open or before the autopilot has run.
  const votingEnded =
    proposal.voting_ends_at_iso && now >= Date.parse(proposal.voting_ends_at_iso);
  if (votingEnded) {
    try {
      const { rows } = await query(
        `SELECT outcome, closed_at, tally_json->'outcome_detail' AS outcome_detail
           FROM governance_proposal_state WHERE proposal_id = $1`,
        [proposalId],
      );
      const st = rows[0];
      if (st && isFinalOutcome(st.outcome)) {
        body.outcome = {
          result: st.outcome, // "A" | "passed" | "failed" | "operator_discretion"
          closed_at: st.closed_at,
          ...(st.outcome_detail || {}),
        };
      }
    } catch (err) {
      console.error("[gov-tally] outcome read failed (non-fatal):", err.message);
    }
  }

  cache.set(proposalId, { expiresAt: now + CACHE_TTL_MS, body });
  return { status: 200, body };
}
