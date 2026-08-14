/**
 * Solana RPC connection with multi-provider failover.
 *
 * Tries SOLANA_RPC_URL (Helius) first; on any error or 429 falls through
 * to SOLANA_RPC_URL_BACKUP (comma-separated list, defaults to public
 * mainnet). This makes the bot resilient to Helius outages, rate limits,
 * or credit exhaustion — everything degrades to slower public RPC rather
 * than dying.
 */
import { Connection } from "@solana/web3.js";
import "dotenv/config";

const PRIMARY = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const BACKUPS = (process.env.SOLANA_RPC_URL_BACKUP || "https://api.mainnet-beta.solana.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((u) => u !== PRIMARY);

export const connection = new Connection(PRIMARY, "confirmed");
export const backupConnections = BACKUPS.map((url) => new Connection(url, "confirmed"));

/**
 * Run an RPC op against the primary; on retryable failure, try each backup.
 * Use for read-heavy operations where a public-RPC fallback is preferable
 * to outright failure.
 *
 *   const bal = await withFailover((conn) => conn.getBalance(pk));
 */
/**
 * Is this error worth retrying on another provider?
 *
 * 2026-08-12 INCIDENT: Helius returned HTTP **500** ("Internal server error")
 * on getAccountInfo/getBalance/getVersion for ~1 hour. The previous pattern
 * listed 502 and 503 but NOT 500, so every one of those errors was classified
 * non-retryable and thrown immediately — the configured backup was never tried,
 * despite being healthy the whole time. We paid for redundancy and it sat idle.
 *
 * ⚠️ WHY THIS IS NOT JUST /5\d\d/: a bare three-digit match would fire on
 * ordinary amounts. "insufficient funds: need 500000 lamports" contains "500",
 * and treating that as retryable would silently retry a genuine, deterministic
 * failure against every provider and slow every real error down 3x. So 5xx is
 * matched only in HTTP-shaped contexts — web3.js's "Error: 500 : ..." form, or
 * the standard status phrases.
 *
 * The rule stays: transport/provider faults retry, program and validation
 * errors surface immediately.
 */
export function isRetryableRpcError(err) {
  const msg = typeof err === "string" ? err : err?.message || "";
  if (!msg) return false;
  return (
    /\b429\b/.test(msg) ||
    /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg) ||
    /failed to fetch|fetch failed|network error|network request failed/i.test(msg) ||
    /internal server error|bad gateway|service unavailable|gateway time-?out|origin is unreachable|connection timed out/i.test(msg) ||
    // web3.js surfaces HTTP failures as "Error: <status> : <body>" — 5xx only.
    /Error:\s*5\d{2}\b/.test(msg) ||
    // bare status codes, but only where they read as a status, not an amount
    /\b5(00|02|03|04|20|21|22|23|24)\s*(:|-|\b(?=[A-Za-z]))/.test(msg) ||
    /\bconnection\b/i.test(msg)
  );
}

export async function withFailover(fn) {
  // If the health watcher has flagged the primary as stale (serving frozen
  // data with HTTP 200 — see rpc-health-watcher.js), skip it entirely rather
  // than reading month-old state. A wrong answer is worse than a slow one.
  const primaryFirst = !isPrimaryDegraded();
  const all = primaryFirst
    ? [connection, ...backupConnections]
    : [...backupConnections, connection];

  let lastErr;
  for (const conn of all) {
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      if (!isRetryableRpcError(err)) throw err; // surface validation errors immediately
    }
  }
  throw lastErr || new Error("All RPC endpoints failed");
}

/* ── Primary health, owned by rpc-health-watcher.js ─────────────────────────
 * Staleness cannot be detected from an error, because the failure mode is a
 * 200 with frozen data. The watcher probes out-of-band and flips this flag;
 * withFailover reads it, so the hot path pays ZERO extra RPC calls.
 * Fails OPEN: if nothing ever sets it, the primary is used exactly as before.
 */
let degraded = { stale: false, since: 0, reason: "" };

/** @param {string} reason */
export function markPrimaryDegraded(reason) {
  if (!degraded.stale) degraded = { stale: true, since: Date.now(), reason };
}
export function markPrimaryHealthy() {
  if (degraded.stale) degraded = { stale: false, since: 0, reason: "" };
}
export function isPrimaryDegraded() {
  return degraded.stale && backupConnections.length > 0;
}
export function getPrimaryHealth() {
  return { ...degraded, backups: backupConnections.length, primary: PRIMARY.slice(0, 40) };
}

if (BACKUPS.length > 0) {
  console.log(`[rpc] Primary: ${PRIMARY.slice(0, 40)}…`);
  console.log(`[rpc] Backups configured: ${BACKUPS.length}`);
} else {
  console.warn("[rpc] WARNING: No SOLANA_RPC_URL_BACKUP configured — single point of failure");
}
