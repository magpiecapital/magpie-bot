#!/usr/bin/env node
/**
 * governance-live-snapshot.js — generate a FULL-HOLDER eligibility snapshot for
 * an active proposal and write it straight to the DB, so the LIVE results bars +
 * voting-power work during voting (every potential voter is pre-weighted).
 *
 * Why this exists: the activation-snapshot path (scripts/governance-snapshot.js)
 * only writes a FILE; the close-time path (close-time-snapshot.js) writes the DB
 * but only for wallets that have ALREADY voted. Neither gives a live full-holder
 * snapshot in the DB. MGP-003 (current-holders/close-time model, operator
 * decision 2026-06-25) needs one NOW for live results; the pipeline re-snapshots
 * holders at close for the binding tally (snapshot_id '<id>_close').
 *
 * The DB-write is byte-for-byte the same shape + weight math as
 * close-time-snapshot.js (held_raw + collateralized_raw, lp_shares=0,
 * total_eligible_weight = sum of eligible voting weight) — only the wallet SET
 * differs (all eligible holders here, vs voters there). Idempotent UPSERT.
 *
 * Usage (in the bot's environment, e.g. `railway run`):
 *   node scripts/governance-live-snapshot.js MGP-003
 */
import crypto from "node:crypto";
import { query } from "../src/db/pool.js";
import { snapshotForGovernance } from "../src/services/governance-snapshot.js";

const proposalId = process.argv[2];
if (!proposalId || !/^MGP-\d{3}$/.test(proposalId)) {
  console.error("Usage: node scripts/governance-live-snapshot.js <PROPOSAL_ID> (e.g. MGP-003)");
  process.exit(1);
}
// The live snapshot id the registry's snapshot_id points at.
const snapshotId = process.argv[3] || proposalId;

async function main() {
  console.log(`[live-snapshot] ${proposalId}: enumerating eligible holders…`);
  const snap = await snapshotForGovernance();

  // Voting weight = held + collateralized (the borrower is the beneficial owner
  // of locked collateral). LP shares do NOT count toward voting weight — matches
  // close-time-snapshot.js (lp_shares = 0). Skip wallets with zero of both.
  const rows = [];
  let totalEligible = 0n;
  for (const e of snap.combined_eligible_set) {
    const held = BigInt(e.magpie_balance_raw ?? "0");
    const collateralized = BigInt(e.magpie_collateralized_raw ?? "0");
    if (held === 0n && collateralized === 0n) continue;
    rows.push({ wallet: e.wallet, held, collateralized });
    totalEligible += held + collateralized;
  }
  if (totalEligible === 0n) totalEligible = 1n; // avoid div-by-zero at tally time

  const hashSource = JSON.stringify({
    proposalId,
    rows: rows
      .map((r) => [r.wallet, r.held.toString(), r.collateralized.toString()])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    totalEligible: totalEligible.toString(),
  });
  const hash = crypto.createHash("sha256").update(hashSource).digest("hex");

  await query("BEGIN");
  try {
    await query(
      `INSERT INTO governance_snapshots
         (snapshot_id, proposal_id, taken_at_utc, hash_sha256, scope_version,
          totals, total_eligible_weight, unique_eligible_count)
       VALUES ($1, $2, NOW(), $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (snapshot_id) DO UPDATE
         SET taken_at_utc = NOW(), hash_sha256 = EXCLUDED.hash_sha256,
             scope_version = EXCLUDED.scope_version, totals = EXCLUDED.totals,
             total_eligible_weight = EXCLUDED.total_eligible_weight,
             unique_eligible_count = EXCLUDED.unique_eligible_count`,
      [
        snapshotId,
        proposalId,
        hash,
        "live-holder-v1",
        JSON.stringify({
          eligible_wallets: rows.length,
          holders_count: snap.totals.holders_count,
          collateralized_count: snap.totals.collateralized_count,
        }),
        totalEligible.toString(),
        rows.length,
      ],
    );
    await query(`DELETE FROM governance_snapshot_weights WHERE snapshot_id = $1`, [snapshotId]);
    for (const r of rows) {
      await query(
        `INSERT INTO governance_snapshot_weights
           (snapshot_id, wallet, held_raw, collateralized_raw, lp_shares)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (snapshot_id, wallet) DO UPDATE
           SET held_raw = EXCLUDED.held_raw, collateralized_raw = EXCLUDED.collateralized_raw`,
        [snapshotId, r.wallet, r.held.toString(), r.collateralized.toString()],
      );
    }
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  console.log(
    `[live-snapshot] ${proposalId}: wrote snapshot_id='${snapshotId}' — ` +
      `${rows.length} eligible wallets, total_eligible_weight=${(Number(totalEligible) / 1e6).toFixed(0)} $MAGPIE, hash ${hash.slice(0, 12)}…`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[live-snapshot] FAILED:", e?.message ?? e);
  process.exit(1);
});
