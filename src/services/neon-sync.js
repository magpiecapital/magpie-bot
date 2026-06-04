/**
 * Neon sync — periodic backup of critical tables from Railway (primary)
 * to Neon (cold standby).
 *
 * Why: the wallet-overwrite incident showed we had no off-Railway copy
 * of encrypted_secret bytes. If Railway's DB is corrupted, lost, or
 * rotated, recovery is impossible without an external copy.
 *
 * This service:
 *   1. Connects to Neon (DATABASE_URL_SECONDARY) if configured
 *   2. Ensures the critical tables exist on Neon (creates if missing)
 *   3. Mirrors specific high-value tables on a schedule:
 *      - wallets (current state)
 *      - wallet_snapshots (immutable history — append-only)
 *      - users (who's on the platform)
 *      - loans (active + history — needed for any state reconciliation)
 *      - referral_codes (so user codes survive a primary loss)
 *
 * Strategy: UPSERT-by-id for mutable tables, append-only for snapshots.
 * Runs every 30 min. Skips silently if Neon isn't configured.
 *
 * Cost: O(rows) writes per cycle. Cheap at current scale (~2k users,
 * ~120 loans). Will need batching if we hit 100k+ rows but that's a
 * future problem.
 */
import pg from "pg";
import { query as primaryQuery } from "../db/pool.js";

const POLL_INTERVAL_MS = Number(process.env.NEON_SYNC_POLL_MS) || 30 * 60 * 1000; // 30 min
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // 5 min after boot
const BATCH_SIZE = 500;

let neonPool = null;

function getNeonPool() {
  if (neonPool) return neonPool;
  const url = process.env.DATABASE_URL_SECONDARY;
  if (!url) return null;
  neonPool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
  });
  neonPool.on("error", (err) => {
    console.warn("[neon-sync] pool error (will reconnect):", err.message);
  });
  return neonPool;
}

async function neonQuery(text, params) {
  const pool = getNeonPool();
  if (!pool) return null;
  return pool.query(text, params);
}

/**
 * Ensure the Neon-side schema exists. Creates the critical tables if
 * they're missing. Idempotent — safe to run every cycle.
 */
async function ensureNeonSchema() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
       id BIGINT PRIMARY KEY,
       telegram_id BIGINT NOT NULL,
       telegram_username TEXT,
       created_at TIMESTAMPTZ,
       last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS wallets (
       id BIGINT PRIMARY KEY,
       user_id BIGINT NOT NULL,
       public_key TEXT NOT NULL,
       encrypted_secret BYTEA NOT NULL,
       nonce BYTEA NOT NULL,
       auth_tag BYTEA NOT NULL,
       source TEXT,
       label TEXT,
       is_active BOOLEAN,
       created_at TIMESTAMPTZ,
       last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS wallets_pubkey_idx ON wallets(public_key)`,
    `CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets(user_id)`,
    `CREATE TABLE IF NOT EXISTS wallet_snapshots (
       id BIGINT PRIMARY KEY,
       wallet_id BIGINT,
       user_id BIGINT NOT NULL,
       public_key TEXT NOT NULL,
       encrypted_secret BYTEA NOT NULL,
       nonce BYTEA NOT NULL,
       auth_tag BYTEA NOT NULL,
       source TEXT,
       trigger TEXT,
       snapshotted_at TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS wallet_snapshots_pubkey_idx ON wallet_snapshots(public_key)`,
    `CREATE TABLE IF NOT EXISTS loans (
       id BIGINT PRIMARY KEY,
       user_id BIGINT NOT NULL,
       loan_id TEXT,
       loan_pda TEXT,
       collateral_mint TEXT,
       collateral_amount TEXT,
       loan_amount_lamports TEXT,
       original_loan_amount_lamports TEXT,
       ltv_percentage INTEGER,
       duration_days INTEGER,
       start_timestamp TIMESTAMPTZ,
       due_timestamp TIMESTAMPTZ,
       status TEXT,
       tx_signature TEXT,
       updated_at TIMESTAMPTZ,
       last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS loans_user_idx ON loans(user_id)`,
    `CREATE INDEX IF NOT EXISTS loans_status_idx ON loans(status)`,
    `CREATE TABLE IF NOT EXISTS referral_codes (
       user_id BIGINT PRIMARY KEY,
       code TEXT NOT NULL,
       created_at TIMESTAMPTZ,
       last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  ];
  for (const stmt of ddl) {
    await neonQuery(stmt);
  }
}

/**
 * Mirror a chunk of rows from primary to Neon using UPSERT.
 * Returns { count, error? }
 */
async function mirrorTable({ tableName, columns, pkColumn = "id", since = null }) {
  // Pull recent rows from primary. The `since` arg lets us do incremental
  // syncs after the first full pass — but for now we just full-sweep,
  // since the tables are small.
  let primarySql;
  if (since) {
    primarySql = `SELECT ${columns.join(",")} FROM ${tableName}
                    WHERE updated_at >= $1 OR created_at >= $1
                    ORDER BY ${pkColumn}`;
  } else {
    primarySql = `SELECT ${columns.join(",")} FROM ${tableName} ORDER BY ${pkColumn}`;
  }
  const result = await primaryQuery(primarySql, since ? [since] : []);
  const rows = result.rows;
  if (rows.length === 0) return { count: 0 };

  // UPSERT into Neon. For wallet_snapshots, ON CONFLICT DO NOTHING
  // (append-only). For all others, ON CONFLICT UPDATE (mirror).
  const appendOnly = tableName === "wallet_snapshots";
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(",");
  const updateSetters = appendOnly
    ? null
    : columns.filter((c) => c !== pkColumn).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const sql = appendOnly
    ? `INSERT INTO ${tableName} (${columns.join(",")}) VALUES (${placeholders})
       ON CONFLICT (${pkColumn}) DO NOTHING`
    : `INSERT INTO ${tableName} (${columns.join(",")}) VALUES (${placeholders})
       ON CONFLICT (${pkColumn}) DO UPDATE SET ${updateSetters}`;

  let count = 0;
  for (const row of rows) {
    try {
      const params = columns.map((c) => row[c]);
      await neonQuery(sql, params);
      count++;
    } catch (err) {
      console.warn(`[neon-sync] ${tableName} row ${row[pkColumn]} failed:`, err.message);
    }
  }
  return { count };
}

let isRunning = false;

async function tick() {
  if (!getNeonPool()) {
    // Skip silently if Neon isn't configured. Don't even log.
    return;
  }
  if (isRunning) {
    console.log("[neon-sync] previous cycle still running, skipping");
    return;
  }
  isRunning = true;
  const started = Date.now();
  try {
    await ensureNeonSchema();

    const results = {};

    results.users = await mirrorTable({
      tableName: "users",
      columns: ["id", "telegram_id", "telegram_username", "created_at"],
    });
    results.wallets = await mirrorTable({
      tableName: "wallets",
      columns: ["id", "user_id", "public_key", "encrypted_secret", "nonce", "auth_tag",
                "source", "label", "is_active", "created_at"],
    });
    results.wallet_snapshots = await mirrorTable({
      tableName: "wallet_snapshots",
      columns: ["id", "wallet_id", "user_id", "public_key",
                "encrypted_secret", "nonce", "auth_tag",
                "source", "trigger", "snapshotted_at"],
    });
    results.loans = await mirrorTable({
      tableName: "loans",
      columns: ["id", "user_id", "loan_id", "loan_pda", "collateral_mint",
                "collateral_amount", "loan_amount_lamports", "original_loan_amount_lamports",
                "ltv_percentage", "duration_days", "start_timestamp", "due_timestamp",
                "status", "tx_signature", "updated_at"],
    });
    results.referral_codes = await mirrorTable({
      tableName: "referral_codes",
      columns: ["user_id", "code", "created_at"],
      pkColumn: "user_id",
    });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const summary = Object.entries(results)
      .map(([k, v]) => `${k}=${v.count}`)
      .join(" ");
    console.log(`[neon-sync] ✓ tick complete in ${elapsed}s · ${summary}`);
  } catch (err) {
    console.error("[neon-sync] cycle error:", err.message);
  } finally {
    isRunning = false;
  }
}

export function startNeonSync() {
  if (!process.env.DATABASE_URL_SECONDARY) {
    console.log("[neon-sync] DATABASE_URL_SECONDARY not set — Neon sync disabled");
    return null;
  }
  console.log(`[neon-sync] Starting (every ${POLL_INTERVAL_MS / 60_000}min, first run in ${FIRST_RUN_DELAY_MS / 60_000}min)`);
  setTimeout(() => tick(), FIRST_RUN_DELAY_MS);
  return setInterval(() => tick(), POLL_INTERVAL_MS);
}
