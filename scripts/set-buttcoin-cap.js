#!/usr/bin/env node
/**
 * One-shot: pin $Buttcoin per-token cap to 20 SOL.
 *
 * Buttcoin was hitting the "small" tier default of 10 SOL — explicit
 * override on supported_mints.max_open_lamports replaces the tier
 * calculation entirely. See anti-exploit.js per-token cap path.
 *
 * Mirrors scripts/set-jotchua-cap.js + scripts/set-worldcup-cap.js.
 * Equivalent to running /set_token_cap Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump 20
 * from the operator TG command.
 *
 * Reads back the row after writing so the cap, screener metadata,
 * and currently-open SOL are visible in one place.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const MINT = "Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump";
const CAP_SOL = 20;
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

process.exit(0);
