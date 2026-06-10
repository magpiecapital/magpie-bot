/**
 * GET /api/v1/governance/voting-power?wallet=<pubkey>&proposal_id=<id>
 *
 * Returns the caller's voting weight for a given proposal. Used by the
 * dashboard to display "your weight" on the governance tab.
 *
 * Public read — no auth required. The wallet is the query param; nothing
 * sensitive is returned. (Per-wallet $MAGPIE balance is already public via
 * on-chain token account scan, so surfacing it here is no new exposure.)
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

  const power = getVotingPower({
    wallet,
    proposalId,
    snapshotId: proposal.snapshot_id,
  });

  return {
    status: 200,
    headers: { "Cache-Control": "public, max-age=15, s-maxage=15" },
    body: {
      ...power,
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
