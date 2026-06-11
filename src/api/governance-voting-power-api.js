/**
 * GET /api/v1/governance/voting-power?wallet=<pubkey>&proposal_id=<id>
 *
 * Returns the caller's voting weight for a given proposal. Used by the
 * dashboard to display "your weight" on the governance tab.
 *
 * Public read — no auth required. Response is intentionally minimal:
 * only the wallet's capped percentage-of-pool plus proposal metadata.
 *
 * Fields deliberately NOT returned (operator-internal per
 * MEMORY/feedback_governance_snapshot_internal):
 *   - snapshot_taken_at / snapshot_id   (exact snapshot timing is load-
 *                                       bearing — would let attackers
 *                                       game the next snapshot)
 *   - total_eligible_weight             (denominator of the pool size)
 *   - raw_weight / held_raw / collat_raw (per-wallet balances — caller
 *                                       likely knows their own, but the
 *                                       JSON API shouldn't be the source
 *                                       of truth on someone else's)
 *   - weight_pct_of_pool                (pre-cap — capped-pct is enough)
 *
 * Pip's system prompt enforces the verbal version of this rule; the
 * JSON API needs the same redaction so a scraper can't bypass it.
 */

import { getProposal } from "../governance/registry.js";
import { getVotingPower } from "../governance/voting-power.js";

/**
 * Handler signature mirrors the rest of the API server:
 *   ({ req, url }) => { status, body }
 */
export async function handleVotingPowerQuery(req, url) {
  const wallet = url.searchParams.get("wallet");
  const proposalId = url.searchParams.get("proposal_id");

  if (!wallet || !proposalId) {
    return {
      status: 400,
      body: { error: "missing_params", required: ["wallet", "proposal_id"] },
    };
  }

  // Reject obviously malformed pubkeys before doing snapshot work.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return { status: 400, body: { error: "invalid_wallet_format" } };
  }
  if (!/^MGP-\d{3}$/.test(proposalId)) {
    return { status: 400, body: { error: "invalid_proposal_id" } };
  }

  const proposal = getProposal(proposalId);
  if (!proposal) {
    return { status: 404, body: { error: "proposal_not_found", proposal_id: proposalId } };
  }

  const power = await getVotingPower({
    wallet,
    proposalId,
    snapshotId: proposal.snapshot_id,
  });

  // Public response: ONLY the wallet's eligibility + capped pct + the
  // cap fraction itself + proposal metadata. Everything else from
  // getVotingPower (raw balances, snapshot timing, total eligible
  // weight) stays operator-internal.
  const publicBody = power.eligible
    ? {
        eligible: true,
        wallet: power.wallet,
        capped_pct_of_pool: power.capped_pct_of_pool,
        cap_fraction: power.cap_fraction,
        was_capped: power.was_capped,
      }
    : {
        eligible: false,
        wallet: power.wallet,
        reason: power.reason,
      };

  return {
    status: 200,
    headers: { "Cache-Control": "public, max-age=15, s-maxage=15" },
    body: {
      ...publicBody,
      proposal: {
        id: proposal.id,
        title: proposal.title,
        voting_started_at_iso: proposal.voting_started_at_iso,
        voting_ends_at_iso: proposal.voting_ends_at_iso,
        quorum_pct: proposal.quorum_pct,
        threshold_pct: proposal.threshold_pct,
      },
    },
  };
}
