#!/usr/bin/env node
/**
 * One-shot: pin $WORLDCUP per-token cap to 25 SOL.
 *
 * Equivalent to /set_token_cap 33eum82LaAhtv5YkUq1BdwEviSErH5CnFxqVNLT5pump 25
 * but runs as a script so the operator doesn't have to hop into TG.
 *
 * Reads back the row after writing so we can see exactly what state
 * the row is in (including whether the token is approved/enabled).
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const MINT = "33eum82LaAhtv5YkUq1BdwEviSErH5CnFxqVNLT5pump";
const CAP_SOL = 25;
const CAP_LAMPORTS = String(Math.floor(CAP_SOL * 1e9));

const { rowCount } = await query(
  `UPDATE supported_mints SET max_open_lamports = $2 WHERE mint = $1`,
  [MINT, CAP_LAMPORTS],
);

if (!rowCount) {
  console.error(`⚠ no supported_mints row for ${MINT} — token must be approved first`);
  process.exit(1);
}

const { rows } = await query(
  `SELECT symbol, enabled, max_open_lamports, liquidity_usd, holder_count, token_age_hours,
          top10_holder_pct, has_mint_authority, has_freeze_authority, lp_burned
     FROM supported_mints WHERE mint = $1`,
  [MINT],
);
const r = rows[0];
const openRes = await query(
  `SELECT COALESCE(SUM(original_loan_amount_lamports), 0)::TEXT AS open
     FROM loans WHERE collateral_mint = $1 AND status = 'active'`,
  [MINT],
);
const openSol = (Number(openRes.rows[0]?.open || 0) / 1e9).toFixed(4);

console.log(`✓ ${r.symbol} cap pinned to ${CAP_SOL} SOL`);
console.log(`  enabled: ${r.enabled}`);
console.log(`  max_open_lamports: ${r.max_open_lamports}`);
console.log(`  currently open against this mint: ${openSol} SOL`);
console.log(`  remaining capacity: ${(CAP_SOL - Number(openSol)).toFixed(4)} SOL`);
console.log(`  tier-relevant metadata (for reference):`);
console.log(`    liquidity_usd: $${Number(r.liquidity_usd || 0).toLocaleString()}`);
console.log(`    holder_count: ${r.holder_count}`);
console.log(`    token_age_hours: ${r.token_age_hours}`);
console.log(`    top10_holder_pct: ${r.top10_holder_pct}%`);
console.log(`    has_mint_authority: ${r.has_mint_authority}`);
console.log(`    has_freeze_authority: ${r.has_freeze_authority}`);
console.log(`    lp_burned: ${r.lp_burned}`);
process.exit(0);
