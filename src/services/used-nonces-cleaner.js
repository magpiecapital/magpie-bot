/**
 * Periodic cleanup of bounded-lifetime tables.
 *
 *   used_nonces       — retain 24h. Replay window is ±5min, so anything
 *                       older provably can't be reused.
 *   site_lock_events  — retain 90 days. Useful history for users
 *                       reviewing their own activity, but no value in
 *                       keeping indefinitely.
 *   account_link_codes — already TTL-bounded to 15 min, but expired-
 *                       unclaimed rows accumulate forever. Purge after 7d.
 *
 * Run hourly; each delete is batched (LIMIT) so a backlog can't hold
 * a transaction open.
 */
import { query } from "../db/pool.js";

const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_LIMIT = 10_000;

async function purgeNonces() {
  const { rowCount } = await query(
    `DELETE FROM used_nonces
      WHERE nonce IN (
        SELECT nonce FROM used_nonces
          WHERE created_at < NOW() - INTERVAL '24 hours'
          LIMIT $1
      )`,
    [BATCH_LIMIT],
  );
  return rowCount || 0;
}

async function purgeLockEvents() {
  const { rowCount } = await query(
    `DELETE FROM site_lock_events
      WHERE id IN (
        SELECT id FROM site_lock_events
          WHERE created_at < NOW() - INTERVAL '90 days'
          LIMIT $1
      )`,
    [BATCH_LIMIT],
  );
  return rowCount || 0;
}

async function purgeLinkCodes() {
  const { rowCount } = await query(
    `DELETE FROM account_link_codes
      WHERE code IN (
        SELECT code FROM account_link_codes
          WHERE expires_at < NOW() - INTERVAL '7 days'
          LIMIT $1
      )`,
    [BATCH_LIMIT],
  );
  return rowCount || 0;
}

async function cleanup() {
  try {
    const [nonces, locks, codes] = await Promise.all([
      purgeNonces().catch((e) => { console.warn("[cleaner] nonces failed:", e.message); return 0; }),
      purgeLockEvents().catch((e) => { console.warn("[cleaner] lock_events failed:", e.message); return 0; }),
      purgeLinkCodes().catch((e) => { console.warn("[cleaner] link_codes failed:", e.message); return 0; }),
    ]);
    if (nonces + locks + codes > 0) {
      console.log(`[cleaner] purged ${nonces} nonces, ${locks} lock events, ${codes} link codes`);
    }
  } catch (err) {
    console.warn("[cleaner] tick failed:", err.message);
  }
}

export function startUsedNoncesCleaner() {
  console.log("[cleaner] starting — purges expired used_nonces (24h), site_lock_events (90d), account_link_codes (7d after expiry)");
  // First run after 10 min to let other startup tasks finish.
  setTimeout(cleanup, 10 * 60 * 1000);
  return setInterval(cleanup, RUN_INTERVAL_MS);
}
