#!/usr/bin/env node
/**
 * Guard for RPC failover classification.
 *
 * 2026-08-12: Helius returned HTTP 500 for ~1h. The retryable pattern listed
 * 502 and 503 but NOT 500, so every error was thrown immediately and the
 * healthy configured backup was never tried.
 *
 * TWO regressions are tested, and the second matters as much as the first:
 *   1. a provider fault NOT retrying  -> outage takes the bot down
 *   2. a REAL error retrying          -> every genuine failure gets silently
 *      retried against all providers, 3x slower, masking real bugs
 */
import { isRetryableRpcError } from "../src/solana/connection.js";

let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.error(`✕ ${name}`); } else console.log(`✓ ${name}`); };

// ── MUST retry: real provider faults, verbatim from the incident ──────────
const providerFaults = [
  "failed to get balance of account 4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx: Error: 500 : Internal server error",
  "failed to get info about account 7My1o9Jfm2D5wM2xfpfy67NPvTPVUTSzWyz7ZxjwPjT4: Error: 500 : Internal server error",
  "Error: 500 : Internal server error",
  "503 Service Unavailable",
  "502 Bad Gateway",
  "504 Gateway Timeout",
  "429 Too Many Requests",
  "request timeout",
  "fetch failed",
  "socket hang up",
  "ECONNRESET",
  "ETIMEDOUT",
  "getaddrinfo ENOTFOUND rpc.example.com",
];
for (const m of providerFaults) check(`retries provider fault: "${m.slice(0, 52)}"`, isRetryableRpcError(new Error(m)) === true);

// ── MUST NOT retry: genuine errors. Retrying these hides bugs. ────────────
const realErrors = [
  "insufficient funds: need 500000 lamports",          // contains "500" — the trap
  "Attempt to debit an account but found no record of a prior credit",
  "custom program error: 0x1771",
  "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
  "Blockhash not found",
  "Account does not exist 7My1o9Jfm2D5wM2xfpfy67NPvTPVUTSzWyz7ZxjwPjT4",
  "invalid account discriminator",
  "Transfer: insufficient lamports 502000, need 1000000",  // 502 as an AMOUNT
  "Program log: Error: MathOverflow 6004",
];
for (const m of realErrors) check(`does NOT retry real error: "${m.slice(0, 52)}"`, isRetryableRpcError(new Error(m)) === false);

// ── never throws ─────────────────────────────────────────────────────────
for (const bad of [undefined, null, {}, "", 0, { message: null }, new Error()]) {
  let threw = false;
  try { isRetryableRpcError(bad); } catch { threw = true; }
  check(`no throw on ${JSON.stringify(bad?.message ?? bad)}`, !threw);
}
check("accepts a bare string as well as an Error", isRetryableRpcError("Error: 500 : Internal server error") === true);

if (failed) { console.error(`\n[rpc-failover] ${failed} check(s) failed.`); process.exit(1); }
console.log("\n[rpc-failover] OK — provider faults reroute, genuine errors surface immediately.");
