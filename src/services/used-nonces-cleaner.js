/**
 * Periodic cleanup of the used_nonces table.
 *
 * The replay-protection window is ±5 minutes (set in each signed
 * endpoint). Nonces older than that can never be reused as a valid
 * replay because the freshness check would reject them first.
 *
 * We retain 24h of history anyway — comfortable safety margin + lets
 * /siteops show "signed actions by purpose (24h)" without joining
 * against deleted rows. Beyond 24h, the rows are dead weight.
 *
 * Run hourly; deletes are fast (indexed on created_at) and bounded
 * (LIMIT 10k per cycle so a worst-case backlog can't hold a tx open).
 */
import { query } from "../db/pool.js";

const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RETAIN_HOURS = 24;
const BATCH_LIMIT = 10_000;

async function cleanup() {
  try {
    const { rowCount } = await query(
      `DELETE FROM used_nonces
        WHERE nonce IN (
          SELECT nonce FROM used_nonces
            WHERE created_at < NOW() - ($1 || ' hours')::interval
            LIMIT $2
        )`,
      [String(RETAIN_HOURS), BATCH_LIMIT],
    );
    if (rowCount > 0) {
      console.log(`[nonces-cleaner] purged ${rowCount} expired nonces`);
    }
  } catch (err) {
    console.warn("[nonces-cleaner] tick failed:", err.message);
  }
}

export function startUsedNoncesCleaner() {
  console.log(`[nonces-cleaner] starting — purges nonces older than ${RETAIN_HOURS}h, every ${RUN_INTERVAL_MS / 60_000}min`);
  // First run after 10 min to let other startup tasks finish.
  setTimeout(cleanup, 10 * 60 * 1000);
  return setInterval(cleanup, RUN_INTERVAL_MS);
}
