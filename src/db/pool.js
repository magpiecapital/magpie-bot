import pg from "pg";
import "dotenv/config";

const useSSL = process.env.DB_SSL !== "false";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
  // Connection resilience
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

// Auto-reconnect: log pool errors but don't crash
pool.on("error", (err) => {
  console.error("[db] Pool error (will reconnect):", err.message);
});

/**
 * Query with automatic retry — retries once on connection errors.
 * Prevents transient network blips from crashing services.
 */
export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Retry once on connection-level errors
    if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "57P01") {
      console.warn("[db] Retrying query after connection error:", err.code);
      return pool.query(text, params);
    }
    throw err;
  }
}
