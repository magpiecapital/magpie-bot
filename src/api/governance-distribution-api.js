/**
 * GET /api/v1/governance/distribution?wallet=<pubkey>&proposal_id=<id>
 *
 * Returns the caller's distribution allocation for a given proposal.
 * Powers the dashboard's "Expected SOL" / "Sent — view tx" surfaces.
 *
 * Public read — no auth. Per-wallet allocation is operator-internal
 * info that we're DELIBERATELY publishing to the wallet's owner via
 * the dashboard, so they can see what they're going to receive.
 * Other wallets' allocations are not surfaced by this endpoint
 * (only the queried wallet's row).
 */

import { query } from "../db/pool.js";

export async function handleDistributionQuery(req, url) {
  const wallet = url.searchParams.get("wallet");
  const proposalId = url.searchParams.get("proposal_id");

  if (!wallet || !proposalId) {
    return {
      status: 400,
      body: { error: "missing_params", required: ["wallet", "proposal_id"] },
    };
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return { status: 400, body: { error: "invalid_wallet_format" } };
  }
  if (!/^MGP-\d{3}$/.test(proposalId)) {
    return { status: 400, body: { error: "invalid_proposal_id" } };
  }

  const { rows } = await query(
    `SELECT proposal_id, wallet, weight_raw::text AS weight_raw,
            allocated_lamports::text AS allocated_lamports,
            tx_signature, sent_at, status, failure_reason, plan_hash, snapshot_hash
       FROM governance_distributions
       WHERE proposal_id = $1 AND wallet = $2`,
    [proposalId, wallet],
  );

  if (rows.length === 0) {
    // Pull totals for context — was the wallet eligible at all?
    const total = await query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(allocated_lamports)::numeric, 0)::text AS total_lamports
         FROM governance_distributions WHERE proposal_id = $1`,
      [proposalId],
    );
    return {
      status: 200,
      headers: { "Cache-Control": "public, max-age=15, s-maxage=15" },
      body: {
        in_distribution: false,
        wallet,
        proposal_id: proposalId,
        reason: "wallet_not_in_distribution_or_floored_out",
        distribution_total_recipients: total.rows[0].n,
        distribution_total_sol: Number(total.rows[0].total_lamports) / 1e9,
      },
    };
  }

  const row = rows[0];
  // Pull pool totals for context
  const tot = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(allocated_lamports)::numeric, 0)::text AS total_lamports
       FROM governance_distributions WHERE proposal_id = $1`,
    [proposalId],
  );
  const totalLamports = Number(tot.rows[0].total_lamports);
  const allocatedLamports = Number(row.allocated_lamports);

  return {
    status: 200,
    headers: { "Cache-Control": "public, max-age=15, s-maxage=15" },
    body: {
      in_distribution: true,
      wallet: row.wallet,
      proposal_id: row.proposal_id,
      weight_raw: row.weight_raw,
      allocated_lamports: row.allocated_lamports,
      allocated_sol: allocatedLamports / 1e9,
      pct_of_distribution: totalLamports > 0 ? (allocatedLamports / totalLamports) * 100 : 0,
      status: row.status,                  // 'pending' | 'sent' | 'failed'
      tx_signature: row.tx_signature,
      sent_at: row.sent_at,
      failure_reason: row.failure_reason,
      plan_hash: row.plan_hash,
      snapshot_hash: row.snapshot_hash,
      distribution_total_recipients: tot.rows[0].n,
      distribution_total_sol: totalLamports / 1e9,
    },
  };
}
