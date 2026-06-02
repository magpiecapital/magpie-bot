/**
 * Postgres connection with automatic failover to a secondary DB.
 *
 * Primary: DATABASE_URL (Railway Postgres).
 * Secondary: DATABASE_URL_SECONDARY (Neon cold standby).
 *
 * Queries try primary first; on connection-level errors fall through to
 * secondary. Mirrors the failover behavior the site already has so the
 * bot survives a Railway DB outage gracefully.
 */
import pg from "pg";
import "dotenv/config";

const useSSL = process.env.DB_SSL !== "false";

function createPool(connectionString) {
  if (!connectionString) return null;
  const p = new pg.Pool({
    connectionString,
    max: 10,
    ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  p.on("error", (err) => {
    console.error("[db] Pool error (will reconnect):", err.message);
  });
  return p;
}

export const pool = createPool(process.env.DATABASE_URL);
const secondaryPool = createPool(process.env.DATABASE_URL_SECONDARY);

const CONN_ERR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "57P01"]);

/**
 * Query with retry + failover. Tries primary, retries once on transient
 * connection errors, then falls through to secondary if configured.
 */
export async function query(text, params) {
  if (pool) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (CONN_ERR_CODES.has(err.code)) {
        console.warn("[db] Primary failed, retrying:", err.code);
        try {
          return await pool.query(text, params);
        } catch (err2) {
          if (CONN_ERR_CODES.has(err2.code) && secondaryPool) {
            console.warn("[db] Failing over to secondary DB");
            return secondaryPool.query(text, params);
          }
          throw err2;
        }
      }
      throw err;
    }
  }
  if (secondaryPool) {
    return secondaryPool.query(text, params);
  }
  throw new Error("No database connection available");
}

/**
 * One-shot schema patches run on bot startup. Each statement must be
 * idempotent — safe to re-run on every boot. Use sparingly; prefer
 * proper migration files for non-urgent changes.
 *
 * Currently applies:
 *   - Drops UNIQUE constraint on wallets.public_key so the same wallet
 *     can be imported under multiple Telegram accounts (common when
 *     users share a wallet across devices / accounts). This was the
 *     hidden cause of repeated "Failed to import wallet" errors.
 *   - Inserts/refreshes the official $MAGPIE token as an approved,
 *     protected collateral mint. protected=TRUE exempts it from the
 *     hourly token-health watcher's auto-disable logic. Liquidity/
 *     market-cap fields are refreshed by the screener/health sweeps.
 */
export async function applyStartupPatches() {
  const patches = [
    `ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_public_key_key`,

    // $MAGPIE — protocol token, always approved, exempt from auto-disqualification.
    // Decimals=6 verified on-chain. ON CONFLICT keeps the row idempotent across boots.
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url,
        liquidity_usd, holder_count, market_cap_usd,
        has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected)
     VALUES ('9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump',
             'MAGPIE', 'Magpie', 6, 'memecoin', NULL,
             0, 0, 0,
             FALSE, FALSE, FALSE,
             0, FALSE, NOW(), 'protocol_token',
             TRUE, TRUE)
     ON CONFLICT (mint) DO UPDATE SET
       enabled = TRUE,
       protected = TRUE,
       source = 'protocol_token'`,

    // Make sure the screener doesn't re-process $MAGPIE through the audit pipeline.
    `INSERT INTO token_screen_seen (mint)
     VALUES ('9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump')
     ON CONFLICT DO NOTHING`,
  ];
  for (const sql of patches) {
    try {
      await query(sql);
      console.log("[db] startup patch applied:", sql.slice(0, 80));
    } catch (err) {
      console.warn("[db] startup patch failed (continuing):", err.message);
    }
  }
}

/**
 * Probe the secondary DB directly. Used by the weekly health check to
 * verify the failover path actually works before we need it.
 */
export async function pingSecondary() {
  if (!secondaryPool) return { ok: false, configured: false };
  try {
    const start = Date.now();
    await secondaryPool.query("SELECT 1");
    return { ok: true, configured: true, latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, configured: true, error: err.message };
  }
}
