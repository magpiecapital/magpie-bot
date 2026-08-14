/**
 * One-time backfill: credit holders the 10% referral share that was RETAINED on
 * historical non-referral loans (before the no-referrer rollover fix, PRs #591 +
 * #593). Makes MGP-001's "100% routed, 0% retained" true retroactively.
 *
 *   Dry-run (safe, default):  railway run --service magpie-bot node scripts/backfill-retained-referral.js
 *   Execute (operator):       EXECUTE=1 railway run --service magpie-bot node scripts/backfill-retained-referral.js
 *
 * Safety:
 *   - Read-only unless EXECUTE=1.
 *   - Idempotent: single credit event with a fixed source_id; creditHolderPoolDirect's
 *     ON CONFLICT (source_type, source_id, pool_kind) makes a second run a no-op.
 *   - Subtracts any amount the LIVE rollover already credited (referral_rollover_no_referrer)
 *     so post-fix loans can never be double-counted.
 *   - The credit only ADDS to the holder accrual pool; distribution to holders is a
 *     separate, existing operator step.
 */
import pkg from "pg";
const { Pool } = pkg;
import "dotenv/config";

const EXECUTE = process.env.EXECUTE === "1";
const S = (l) => (Number(l) / 1e9).toFixed(6);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Loan-fee source types that flowed through the conditional 70/10/10/10 split.
// (x402_fee = pay-per-CALL API revenue → holders only, no referrer → excluded.)
const LOAN_FEE_TYPES = ["borrow_fee", "extend_fee", "backfill_borrow_fee", "limit_close_fee", "backfill_limit_close_fee"];

const totalFeesQ = await pool.query(
  `SELECT COALESCE(SUM((metadata->>'fee_lamports')::numeric),0)::text tot, count(*) FILTER (WHERE metadata ? 'fee_lamports')::int n
     FROM pool_credit_events WHERE pool_kind='holder' AND source_type = ANY($1)`,
  [LOAN_FEE_TYPES],
);
const referredFeesQ = await pool.query(`SELECT COALESCE(SUM(fee_lamports::numeric),0)::text tot, count(*)::int n FROM referral_earnings`);
const alreadyRolledQ = await pool.query(
  `SELECT COALESCE(SUM(lamports::numeric),0)::text tot FROM pool_credit_events WHERE pool_kind='holder' AND source_type='referral_rollover_no_referrer'`,
);

const totalFees = BigInt(totalFeesQ.rows[0].tot || "0");
const referredFees = BigInt(referredFeesQ.rows[0].tot || "0");
const nonRefFees = totalFees - referredFees;
const owed = nonRefFees / 10n;                                  // 10% of non-referral fees
const alreadyRolled = BigInt(alreadyRolledQ.rows[0].tot || "0"); // handled live post-fix
const backfill = owed - alreadyRolled > 0n ? owed - alreadyRolled : 0n;

console.log("── Retained-referral backfill ──");
console.log("  total historical loan fees:  ", S(totalFees), "SOL (" + totalFeesQ.rows[0].n + " fee events w/ amount)");
console.log("  fees that paid a referral:   ", S(referredFees), "SOL (" + referredFeesQ.rows[0].n + " loans)");
console.log("  non-referral fees:           ", S(nonRefFees), "SOL");
console.log("  owed to holders (10%):       ", S(owed), "SOL");
console.log("  already rolled live (post-fix):", S(alreadyRolled), "SOL");
console.log("  → BACKFILL to credit:        ", S(backfill), "SOL");
console.log("  (note: 339 pre-ledger backfill_borrow_fee events store no fee amount → not included; true figure may be marginally higher)");

if (!EXECUTE) {
  console.log("\nDRY-RUN — nothing credited. Re-run with EXECUTE=1 to apply.");
  await pool.end();
} else if (backfill <= 0n) {
  console.log("\nNothing to backfill.");
  await pool.end();
} else {
  const { creditHolderPoolDirect } = await import("../src/services/magpie-holder-rewards.js");
  const res = await creditHolderPoolDirect({
    sourceType: "referral_retained_backfill",
    sourceId: "mgp001_no_referrer_retained_backfill_v1",
    lamports: backfill,
    metadata: { reason: "no_referrer_retained_backfill", non_referral_fees: nonRefFees.toString(), owed: owed.toString(), already_rolled: alreadyRolled.toString() },
  });
  console.log(res ? `\n✅ CREDITED ${S(backfill)} SOL to the holder pool.` : "\nℹ️ Already credited (idempotent no-op).");
  await pool.end();
}
