#!/usr/bin/env node
/**
 * Compute proposed retroactive LP-yield credit for a wallet that
 * was missing from lp_positions due to the indexer bug.
 *
 * Method:
 *   1. Find the user's deposit timestamp (from on-chain or first ticket date).
 *   2. Compute pro-rata share they SHOULD have had: deposit_sol / current_tvl_sol.
 *   3. Compute LP fee distributions since deposit_date.
 *   4. Multiply: share × distributions = fair credit.
 *
 * Inputs:
 *   --deposit-sol  <N>    SOL amount they deposited
 *   --since-days   <D>    days since deposit (for the window)
 *
 * Output: a proposed SOL credit number + the inputs used. NO transfer
 * is executed — this is a calculator only. Operator approves the
 * actual transfer separately.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const depositSol = Number(flag("--deposit-sol")) || 0;
const sinceDays = Number(flag("--since-days")) || 0;
if (!depositSol || !sinceDays) {
  console.error("Usage: node scripts/compute-lp-credit.js --deposit-sol <N> --since-days <D>");
  process.exit(1);
}

// Current pool TVL — same query /apy uses.
const { rows: [tvlRow] } = await query(
  `SELECT COALESCE(SUM(shares::numeric), 0)::text AS tvl_lamports
     FROM lp_positions WHERE shares > 0`,
);
const tvlSol = Number(tvlRow.tvl_lamports) / 1e9;

// LP fees distributed across the window. Approximation: 80% of all
// loan-origination fees flow to LPs. Matches the existing /apy method.
const { rows: [feeRow] } = await query(
  `SELECT COALESCE(SUM(loan_amount_lamports::numeric) * 0.02, 0)::text AS fees_to_lps
     FROM loans
    WHERE created_at > NOW() - ($1::text || ' days')::interval`,
  [String(sinceDays)],
);
const feesSol = Number(feeRow.fees_to_lps) / 1e9;

// The depositor's would-be share AT THE TIME they were in the pool.
// We don't have historical TVL, so we use current TVL as an
// approximation. That UNDER-estimates their share if pool grew
// since their deposit (their slice was bigger when TVL was smaller).
// We add a 25% upward adjustment to compensate — conservative,
// favoring the user.
const shareNow = depositSol / Math.max(tvlSol, depositSol);
const shareAdjusted = shareNow * 1.25;
const creditSol = feesSol * shareAdjusted;

console.log("─── Inputs ───");
console.log(`Deposit:         ${depositSol} SOL`);
console.log(`Days in pool:    ${sinceDays}`);
console.log(`Pool TVL now:    ${tvlSol.toFixed(4)} SOL`);
console.log(`Fees to LPs (${sinceDays}d): ${feesSol.toFixed(6)} SOL`);
console.log("");
console.log("─── Computation ───");
console.log(`Their share now: ${(shareNow * 100).toFixed(4)}%`);
console.log(`Adjusted share (+25%): ${(shareAdjusted * 100).toFixed(4)}%`);
console.log("");
console.log("─── Proposed credit ───");
console.log(`${creditSol.toFixed(6)} SOL`);
console.log("");
console.log("This is a CALCULATOR ONLY. No transfer happens here.");
console.log("Operator reviews + approves a final number before any SOL moves.");
process.exit(0);
