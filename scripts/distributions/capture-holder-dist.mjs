// CAPTURE-ONLY holder distribution snapshot. Creates a magpie_holder_distributions
// row + magpie_holder_rewards rows at 'snapshot_pending'. NO SOL MOVES.
// The flag forces snapshot-only mode inside snapshotAndDistribute().
import { query } from "../../src/db/pool.js";

// Arm snapshot-only, then capture in the same process (no window for auto-pay).
await query("UPDATE magpie_holder_pool SET next_run_snapshot_only = TRUE, updated_at = NOW() WHERE id = 1");
const armed = await query("SELECT next_run_snapshot_only FROM magpie_holder_pool WHERE id = 1");
if (armed.rows[0].next_run_snapshot_only !== true) {
  console.error("ABORT: snapshot-only flag not armed"); process.exit(1);
}
console.log("snapshot-only armed:", armed.rows[0].next_run_snapshot_only);

const { snapshotAndDistribute } = await import("../../src/services/magpie-holder-rewards.js");
const res = await snapshotAndDistribute();
if (!res) { console.error("ABORT: snapshotAndDistribute returned null (pool below min / no holders)"); process.exit(1); }
if (res.mode !== "snapshot_only") { console.error("ABORT: mode was", res.mode, "— expected snapshot_only"); process.exit(1); }

console.log("\n── CAPTURE RESULT ──");
console.log("distribution_id:", res.distribution_id);
console.log("pool_lamports:  ", (Number(res.pool_lamports) / 1e9).toFixed(6), "SOL");
console.log("holder_count:   ", res.holder_count);
console.log("eligible_count: ", res.eligible_count);
console.log("allocated:      ", (Number(res.allocated_lamports) / 1e9).toFixed(6), "SOL");
console.log("mode:           ", res.mode, "(NO SOL SENT)");

// Verify the rows landed at snapshot_pending
const v = await query(
  "SELECT COUNT(*)::int n, COALESCE(SUM(reward_lamports),0)::text s FROM magpie_holder_rewards WHERE distribution_id=$1 AND status='snapshot_pending'",
  [res.distribution_id],
);
console.log("\nverified snapshot_pending rows:", v.rows[0].n, "sum:", (Number(v.rows[0].s) / 1e9).toFixed(6), "SOL");
process.exit(0);
