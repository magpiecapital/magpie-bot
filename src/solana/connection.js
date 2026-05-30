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
export async function withFailover(fn) {
  const all = [connection, ...backupConnections];
  let lastErr;
  for (const conn of all) {
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || "";
      const retryable = /429|timeout|fetch|network|503|502|connection|ETIMEDOUT|ECONN/i.test(msg);
      if (!retryable) throw err; // surface validation errors immediately
    }
  }
  throw lastErr || new Error("All RPC endpoints failed");
}

if (BACKUPS.length > 0) {
  console.log(`[rpc] Primary: ${PRIMARY.slice(0, 40)}…`);
  console.log(`[rpc] Backups configured: ${BACKUPS.length}`);
} else {
  console.warn("[rpc] WARNING: No SOLANA_RPC_URL_BACKUP configured — single point of failure");
}
