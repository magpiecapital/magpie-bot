#!/usr/bin/env node
/**
 * Disable a collateral token — for tokens that have turned out to be
 * scammy, malicious, or otherwise unsafe to keep accepting.
 *
 * Existing loans against the token can still be repaid; no NEW borrows
 * will be accepted. The mint is also added to token_screen_seen so the
 * auto-screener doesn't try to re-approve it later.
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   railway run node scripts/disable-token.js <mint>           # dry run
 *   railway run node scripts/disable-token.js <mint> --execute # broadcast
 *
 * Example:
 *   railway run node scripts/disable-token.js Cv5n8x6hCrTDcHcgkNziuFXY1qwXoxmuoUi6fuZN3Ge4 --execute
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const mint = process.argv.find((a) => a.length === 44 && !a.startsWith("-"));
const execute = process.argv.includes("--execute");

if (!mint) {
  console.error("Usage: railway run node scripts/disable-token.js <mint> [--execute]");
  process.exit(1);
}

console.log(`Mint: ${mint}\n`);

const { rows: [t] } = await query(
  `SELECT mint, symbol, name, enabled, protected, source, screened_at
     FROM supported_mints WHERE mint = $1`,
  [mint],
);
if (!t) {
  console.log("Not in supported_mints — nothing to disable.");
  process.exit(0);
}
if (t.protected) {
  console.error(`✗ REFUSING — ${t.symbol} is marked protected (e.g. $MAGPIE). Disabling protected tokens requires manual intervention.`);
  process.exit(1);
}
console.log(`Current state:`);
console.log(`  symbol:   ${t.symbol}`);
console.log(`  name:     ${t.name}`);
console.log(`  enabled:  ${t.enabled}`);
console.log(`  source:   ${t.source}`);
console.log(`  screened: ${t.screened_at?.toISOString()}`);

const { rows: [{ n: openLoans }] } = await query(
  `SELECT COUNT(*)::int AS n FROM loans WHERE collateral_mint = $1 AND status = 'active'`,
  [mint],
);
console.log(`  active loans using this collateral: ${openLoans}`);

if (!execute) {
  console.log("\nDRY RUN. Re-run with --execute to disable.");
  process.exit(0);
}

await query(`UPDATE supported_mints SET enabled = FALSE WHERE mint = $1`, [mint]);
await query(`INSERT INTO token_screen_seen (mint) VALUES ($1) ON CONFLICT DO NOTHING`, [mint]);
console.log(`\n✓ ${t.symbol} (${mint}) disabled.`);
console.log(`  Existing loans (${openLoans} active) can still be repaid.`);
console.log(`  No new borrows against this mint will be accepted.`);
console.log(`  Auto-screener will skip on next pass (token_screen_seen).`);
