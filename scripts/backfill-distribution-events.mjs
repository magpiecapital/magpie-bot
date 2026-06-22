/**
 * Backfill distribution_events for every historical distribution we
 * can reconstruct from existing per-kind detail tables.
 *
 * Sources scanned:
 *   1. governance_distributions          — one row per (proposal_id) event
 *   2. magpie_holder_distributions       — one row per snapshot
 *   3. lp_loyalty_distributions          — one row per snapshot
 *   4. (yield_distributions schema TBD; add when defined)
 *   5. (loan_remediation_payouts schema TBD; add when defined)
 *
 * Idempotent: re-running upserts on (kind, external_ref). Safe to run
 * repeatedly during development + after each new distribution.
 *
 *   node scripts/backfill-distribution-events.mjs [--dry]
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";
import { upsertDistributionEvent } from "../src/services/distribution-events.js";

const DRY = process.argv.includes("--dry");

function median(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 === 0
    ? (BigInt(sortedNums[mid - 1]) + BigInt(sortedNums[mid])) / 2n
    : BigInt(sortedNums[mid]);
}

async function backfillGovernance() {
  console.log("\n== governance_distributions → kind=governance ==");
  const props = await query(
    `SELECT proposal_id,
            COUNT(*)::int                                            AS eligible_count,
            COUNT(*) FILTER (WHERE status='sent')::int               AS paid_count,
            COUNT(*) FILTER (WHERE status<>'sent')::int              AS unpayable_count,
            COALESCE(SUM(allocated_lamports) FILTER (WHERE status='sent'),0)::text  AS paid_lamports,
            COALESCE(SUM(allocated_lamports) FILTER (WHERE status<>'sent'),0)::text AS unpaid_lamports,
            COALESCE(SUM(weight_raw),0)::text                        AS total_weight,
            MIN(sent_at) FILTER (WHERE status='sent')                AS paid_first_at,
            MAX(sent_at) FILTER (WHERE status='sent')                AS paid_last_at,
            MIN(created_at)                                          AS snapshot_at,
            MAX(plan_hash)                                           AS plan_hash,
            MAX(snapshot_hash)                                       AS snapshot_hash
       FROM governance_distributions
      GROUP BY proposal_id
      ORDER BY MIN(created_at)`,
  );
  for (const p of props.rows) {
    const amts = await query(
      `SELECT allocated_lamports::text AS a
         FROM governance_distributions
        WHERE proposal_id = $1 AND status = 'sent'
        ORDER BY allocated_lamports ASC`,
      [p.proposal_id],
    );
    const sortedAmounts = amts.rows.map((r) => r.a);
    const minA = sortedAmounts[0] ?? null;
    const maxA = sortedAmounts[sortedAmounts.length - 1] ?? null;
    const medA = median(sortedAmounts);
    const sigSample = await query(
      `SELECT DISTINCT tx_signature
         FROM governance_distributions
        WHERE proposal_id = $1 AND status='sent' AND tx_signature IS NOT NULL
        LIMIT 5`,
      [p.proposal_id],
    );

    const eventDef = {
      kind: "governance",
      external_ref: p.proposal_id,
      snapshot_at: p.snapshot_at,
      paid_first_at: p.paid_first_at,
      paid_last_at: p.paid_last_at,
      pool_lamports: p.paid_lamports,
      distributed_lamports: p.paid_lamports,
      unpaid_lamports: p.unpaid_lamports,
      eligible_wallet_count: p.eligible_count,
      paid_wallet_count: p.paid_count,
      unpayable_wallet_count: p.unpayable_count,
      denominator_kind: "weight_raw",
      denominator_value: p.total_weight,
      min_payout_lamports: minA,
      max_payout_lamports: maxA,
      median_payout_lamports: medA?.toString(),
      source_other_lamports: p.paid_lamports, // governance ratification doesn't fit borrow/liquidation source buckets
      plan_hash: p.plan_hash,
      snapshot_hash: p.snapshot_hash,
      sample_tx_signatures: sigSample.rows.map((r) => r.tx_signature),
      notes: `Governance ratification distribution for proposal ${p.proposal_id}. ${p.paid_count} paid, ${p.unpayable_count} skipped (allocation below rent-exempt minimum).`,
      status: p.unpayable_count > 0 ? "partial" : "complete",
      metadata: { proposal_id: p.proposal_id },
    };
    console.log(
      `  ${p.proposal_id}: paid=${p.paid_count}/${p.eligible_count} wallets, ${(Number(p.paid_lamports) / 1e9).toFixed(4)} SOL`,
    );
    if (!DRY) {
      const id = await upsertDistributionEvent(eventDef);
      console.log(`    → distribution_events #${id}`);
    }
  }
}

async function backfillHolderRewards() {
  console.log("\n== magpie_holder_distributions → kind=holder_reward ==");
  const snaps = await query(
    `SELECT id, snapshot_at, pool_lamports::text AS pool_lamports,
            total_balance::text AS total_balance,
            holder_count, eligible_count
       FROM magpie_holder_distributions ORDER BY snapshot_at`,
  );
  if (snaps.rows.length === 0) {
    console.log("  (no rows — first distribution hasn't run)");
    return;
  }
  for (const s of snaps.rows) {
    const r = await query(
      `SELECT COUNT(*)::int AS eligible_count,
              COUNT(*) FILTER (WHERE status='paid')::int AS paid_count,
              COALESCE(SUM(reward_lamports) FILTER (WHERE status='paid'),0)::text AS paid_lamports
         FROM magpie_holder_rewards WHERE distribution_id = $1`,
      [s.id],
    );
    const det = r.rows[0];
    const eventDef = {
      kind: "holder_reward",
      external_ref: `holder-${s.id}`,
      snapshot_at: s.snapshot_at,
      pool_lamports: s.pool_lamports,
      distributed_lamports: det.paid_lamports,
      eligible_wallet_count: det.eligible_count,
      paid_wallet_count: det.paid_count,
      denominator_kind: "magpie_balance",
      denominator_value: s.total_balance,
      notes: `$MAGPIE holder distribution snapshot id=${s.id}.`,
      status: "complete",
    };
    console.log(`  snapshot #${s.id}: ${(Number(det.paid_lamports) / 1e9).toFixed(4)} SOL`);
    if (!DRY) await upsertDistributionEvent(eventDef);
  }
}

async function backfillLpLoyalty() {
  console.log("\n== lp_loyalty_distributions → kind=lp_loyalty ==");
  const snaps = await query(
    `SELECT id, snapshot_at, pool_lamports::text AS pool_lamports,
            total_weight::text AS total_weight, eligible_count
       FROM lp_loyalty_distributions ORDER BY snapshot_at`,
  );
  if (snaps.rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  for (const s of snaps.rows) {
    const r = await query(
      `SELECT COUNT(*)::int AS paid_count,
              COALESCE(SUM(reward_lamports),0)::text AS paid_lamports
         FROM lp_loyalty_rewards WHERE distribution_id = $1`,
      [s.id],
    );
    const det = r.rows[0];
    const eventDef = {
      kind: "lp_loyalty",
      external_ref: `lp-${s.id}`,
      snapshot_at: s.snapshot_at,
      pool_lamports: s.pool_lamports,
      distributed_lamports: det.paid_lamports,
      eligible_wallet_count: s.eligible_count,
      paid_wallet_count: det.paid_count,
      denominator_kind: "share_seconds",
      denominator_value: s.total_weight,
      notes: `LP loyalty distribution snapshot id=${s.id}.`,
      status: "complete",
    };
    console.log(`  snapshot #${s.id}: ${(Number(det.paid_lamports) / 1e9).toFixed(4)} SOL`);
    if (!DRY) await upsertDistributionEvent(eventDef);
  }
}

console.log(`distribution_events backfill ${DRY ? "(dry run)" : "(writing)"}`);
await backfillGovernance();
await backfillHolderRewards();
await backfillLpLoyalty();

console.log("\n== current distribution_events ==");
const all = await query(
  `SELECT kind, external_ref, status,
          (distributed_lamports::numeric / 1e9)::numeric(20,4) AS sol_distributed,
          eligible_wallet_count, paid_wallet_count, unpayable_wallet_count,
          snapshot_at
     FROM distribution_events ORDER BY snapshot_at DESC`,
);
for (const r of all.rows) {
  console.log(
    `  ${r.kind.padEnd(18)} ${r.external_ref.padEnd(20)} ${r.status.padEnd(10)} ${String(r.sol_distributed).padStart(12)} SOL  ${r.paid_wallet_count}/${r.eligible_wallet_count} paid (${r.unpayable_wallet_count} unpayable)  ${r.snapshot_at.toISOString().slice(0,19)}`,
  );
}
process.exit(0);
