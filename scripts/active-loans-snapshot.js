#!/usr/bin/env node
/**
 * Active loans snapshot — operator overview.
 *
 * Prints every active loan with:
 *   - Token (symbol)
 *   - Owed (SOL, the loan amount to repay)
 *   - Due (hours from now; negative = past due)
 *   - Collateral amount (in token units, formatted)
 *
 * Sorted by due date ascending — closest to expiry at the top.
 *
 * Usage:
 *   railway run node scripts/active-loans-snapshot.js
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

function fmtTokenAmount(rawAmount, decimals) {
  if (rawAmount == null || decimals == null) return "—";
  const n = Number(rawAmount) / Math.pow(10, decimals);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

const { rows } = await query(`
  SELECT l.collateral_mint, l.collateral_amount, l.original_loan_amount_lamports,
         l.due_timestamp, sm.symbol, sm.decimals
    FROM loans l
    LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
   WHERE l.status = 'active'
   ORDER BY l.due_timestamp ASC
`);

if (rows.length === 0) {
  console.log("No active loans.");
  process.exit(0);
}

const now = Date.now();

// Header
console.log("Token       Owed (SOL)   Due (hrs)    Collateral");
console.log("──────────  ───────────  ───────────  ─────────────────");

for (const l of rows) {
  const symbol = (l.symbol || "?").padEnd(10);
  const owedSol = (Number(l.original_loan_amount_lamports) / 1e9).toFixed(4).padStart(11);
  const dueMs = new Date(l.due_timestamp).getTime() - now;
  const dueHrs = (dueMs / 3_600_000).toFixed(1).padStart(11);
  const tokens = fmtTokenAmount(l.collateral_amount, l.decimals);
  const tokensWithSymbol = `${tokens} ${l.symbol || "?"}`;
  console.log(`${symbol}  ${owedSol}  ${dueHrs}  ${tokensWithSymbol}`);
}

console.log("");
console.log(`Total active loans: ${rows.length}`);
process.exit(0);
