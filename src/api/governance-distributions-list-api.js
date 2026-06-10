/**
 * GET /api/v1/governance/distributions?wallet=<pubkey>
 *
 * Returns the FULL HISTORY of distributions for a single wallet across
 * every proposal (e.g., MGP-001, MGP-002, ...). Powers the dashboard's
 * Holder Distributions card which renders a clean list of past payouts
 * with per-row tx links.
 *
 * Public read — same risk envelope as /api/v1/activity. Per-wallet
 * allocation is operator-internal info that we DELIBERATELY surface to
 * the wallet's owner. Only returns rows where the requested wallet is
 * the recipient.
 */

import { query } from "../db/pool.js";

export async function handleDistributionsListQuery(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "missing_wallet" } };
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return { status: 400, body: { error: "invalid_wallet_format" } };
  }

  const { rows } = await query(
    `SELECT proposal_id,
            allocated_lamports::text AS allocated_lamports,
            tx_signature, sent_at, status, plan_hash, snapshot_hash
       FROM governance_distributions
      WHERE wallet = $1
      ORDER BY COALESCE(sent_at, created_at) DESC NULLS LAST`,
    [wallet],
  );

  const distributions = rows.map((r) => ({
    proposal_id: r.proposal_id,
    allocated_lamports: r.allocated_lamports,
    allocated_sol: Number(r.allocated_lamports) / 1e9,
    tx_signature: r.tx_signature,
    sent_at: r.sent_at,
    status: r.status,
    plan_hash: r.plan_hash,
    snapshot_hash: r.snapshot_hash,
  }));

  const totalReceivedLamports = distributions
    .filter((d) => d.status === "sent")
    .reduce((acc, d) => acc + Number(d.allocated_lamports), 0);

  return {
    status: 200,
    headers: { "Cache-Control": "public, max-age=15, s-maxage=15" },
    body: {
      wallet,
      distribution_count: distributions.length,
      total_received_lamports: String(totalReceivedLamports),
      total_received_sol: totalReceivedLamports / 1e9,
      distributions,
    },
  };
}
