#!/usr/bin/env node
/**
 * Guard for the borrow conversion metric.
 *
 * The failure this prevents is silent and total: before 2026-08-11 the wrapper
 * recorded a "customer borrow failure" for every request to this public,
 * unauthenticated endpoint — including a 5-minute poller sending an invalid
 * body. 14,842 events had been recorded and ZERO had a wallet attached, so the
 * metric read 0.0% forever and could never report a real degradation.
 *
 * Two ways to regress it, both tested:
 *   - start counting non-attempts again (metric goes permanently red)
 *   - start DROPPING real failed attempts (metric goes falsely green — worse)
 */
import { isNonBorrowAttempt } from "../src/api/conversion-attempt.js";

let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.error(`✕ ${name}`); } else console.log(`✓ ${name}`); };

// ── must be EXCLUDED: no transaction was ever supplied ────────────────────
check("no tx supplied (the 5-min poller) is NOT an attempt",
  isNonBorrowAttempt({ status: 400, body: { error: "Missing partialSignedTxBase64" } }) === true);
check("unparseable JSON body is NOT an attempt",
  isNonBorrowAttempt({ status: 400, body: { error: "Invalid JSON body" } }) === true);
check("a GET/HEAD probe (405) is NOT an attempt",
  isNonBorrowAttempt({ status: 405, body: { error: "POST only" } }) === true);

// ── must still be RECORDED: a real caller supplied a tx and it failed ─────
check("a tx that fails to deserialize IS a real attempt (must be recorded)",
  isNonBorrowAttempt({ status: 400, body: { error: "Failed to deserialize transaction" } }) === false);
check("an unsupported versioned tx IS a real attempt",
  isNonBorrowAttempt({ status: 400, body: { error: "Versioned txs not supported by this endpoint yet" } }) === false);
check("a security rejection (category_byte_mismatch) IS a real attempt",
  isNonBorrowAttempt({ status: 400, body: { error: "category_byte_mismatch" } }) === false);
check("a malformed_borrow_tx rejection IS a real attempt",
  isNonBorrowAttempt({ status: 400, body: { error: "malformed_borrow_tx" } }) === false);
check("oracle_warming IS a real attempt",
  isNonBorrowAttempt({ status: 503, body: { oracle_warming: true } }) === false);
check("a killswitch pause IS a real attempt",
  isNonBorrowAttempt({ status: 503, body: { paused: true } }) === false);
check("a SUCCESS is never excluded",
  isNonBorrowAttempt({ status: 200, body: { ok: true } }) === false);
check("a 500 server error IS a real attempt",
  isNonBorrowAttempt({ status: 500, body: {} }) === false);

// ── never throws on junk ─────────────────────────────────────────────────
for (const bad of [undefined, null, {}, { status: 400 }, { body: null }, { status: "400", body: { error: 1 } }]) {
  let threw = false;
  try { isNonBorrowAttempt(bad); } catch { threw = true; }
  check(`no throw on ${JSON.stringify(bad)}`, !threw);
}

if (failed) { console.error(`\n[conversion-metric] ${failed} check(s) failed.`); process.exit(1); }
console.log("\n[conversion-metric] OK — non-attempts excluded, every real attempt still recorded.");
