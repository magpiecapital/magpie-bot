#!/usr/bin/env node
/**
 * One-time backfill: credit historical loan fees to the $MAGPIE holder
 * reward pool.
 *
 * The `magpie_holder_pool` table was added to the schema after many
 * loans had already been processed. Those historical loans never
 * accrued anything to the holder pool, even though the protocol's
 * fee-split design says holders get 10% of every loan fee.
 *
 * This script:
 *   1. Reads the on-chain pool's total lifetime fees earned
 *   2. Calculates 10% of that (the holder share per protocol design)
 *   3. Subtracts whatever's already in the holder pool's accrued bucket
 *   4. Adds the gap (if positive) so the pool reflects the true owed amount
 *
 * Safe to run before the first distribution; result is the same as if
 * the holder-pool ledger had been correctly accrued on every borrow
 * since day 1. After the first distribution fires, this script becomes
 * a no-op (it never DOUBLE-credits — only fills gaps).
 *
 * Usage:
 *   railway run node scripts/backfill-holder-pool.js              # dry run
 *   railway run node scripts/backfill-holder-pool.js --execute    # apply
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { query } from "../src/db/pool.js";
import { getReadOnlyProgram } from "../src/solana/program.js";
import { lendingPoolPda } from "../src/solana/pdas.js";

const HOLDER_REWARD_BPS = 1_000; // 10% — must stay in sync with magpie-holder-rewards.js

const execute = process.argv.includes("--execute");

console.log(execute ? "LIVE — will write to magpie_holder_pool" : "DRY RUN — no DB writes\n");

// 1. On-chain lifetime fees
const program = getReadOnlyProgram();
const lender = new PublicKey(process.env.LENDER_PUBKEY);
const [poolPda] = lendingPoolPda(lender);
const onChainPool = await program.account.lendingPool.fetch(poolPda);
const lifetimeFeesLamports = BigInt(onChainPool.totalFeesEarned.toString());
console.log(`On-chain lifetime fees:           ${(Number(lifetimeFeesLamports) / 1e9).toFixed(6)} SOL`);

// 2. Holder share per protocol formula
const expectedHolderShare = (lifetimeFeesLamports * BigInt(HOLDER_REWARD_BPS)) / 10_000n;
console.log(`Holder share (${HOLDER_REWARD_BPS / 100}% of fees):        ${(Number(expectedHolderShare) / 1e9).toFixed(6)} SOL`);

// 3. Already accrued + already paid (so we don't double-credit)
const { rows: [pool] } = await query(
  `SELECT accrued_lamports::text AS accrued FROM magpie_holder_pool WHERE id = 1`,
);
const currentAccrued = BigInt(pool?.accrued || "0");
const { rows: [paidOut] } = await query(
  `SELECT COALESCE(SUM(pool_lamports::numeric), 0)::text AS total FROM magpie_holder_distributions`,
);
const distributedAlready = BigInt(paidOut?.total || "0");
const alreadyCounted = currentAccrued + distributedAlready;
console.log(`Currently accrued (not yet paid): ${(Number(currentAccrued) / 1e9).toFixed(6)} SOL`);
console.log(`Distributed historically:          ${(Number(distributedAlready) / 1e9).toFixed(6)} SOL`);
console.log(`Total already counted toward holders: ${(Number(alreadyCounted) / 1e9).toFixed(6)} SOL`);

// 4. Gap
const gap = expectedHolderShare - alreadyCounted;
console.log(`\nGap to backfill:                  ${(Number(gap) / 1e9).toFixed(6)} SOL`);

if (gap <= 0n) {
  console.log("\n✓ Already up-to-date — nothing to backfill. Exiting cleanly.");
  process.exit(0);
}

if (!execute) {
  console.log("\nDRY RUN. Re-run with --execute to apply the gap to the pool.");
  process.exit(0);
}

// 5. Apply
console.log("\nApplying backfill...");
await query(
  `UPDATE magpie_holder_pool
      SET accrued_lamports = (accrued_lamports::numeric + $1::numeric)::text,
          updated_at = NOW()
    WHERE id = 1`,
  [gap.toString()],
);
const { rows: [after] } = await query(
  `SELECT accrued_lamports::text AS accrued FROM magpie_holder_pool WHERE id = 1`,
);
console.log(`\n✓ Done. Pool accrued is now:     ${(Number(BigInt(after.accrued)) / 1e9).toFixed(6)} SOL`);
console.log(`(Will distribute pro-rata to eligible $MAGPIE holders at next snapshot.)`);
process.exit(0);
