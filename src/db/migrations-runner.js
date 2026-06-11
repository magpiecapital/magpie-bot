/**
 * Auto-apply pending SQL migrations at bot startup.
 *
 * History — this exists because migration 017 sat unapplied in prod for
 * several hours after its PR merged. Migrations had previously been
 * applied manually via psql + Railway run. That worked until it didn't:
 * the operator merged a PR containing a migration, Railway redeployed
 * the bot code (which references the new table at runtime), but the
 * table itself was never created. The runtime query would have errored
 * "relation does not exist" the first time it fired.
 *
 * This runner closes the gap. On startup:
 *   1. Ensure schema_migrations table exists
 *   2. Scan migrations/ dir for *.sql files, sort by filename
 *   3. For each file not in schema_migrations, apply in a transaction
 *      and record the success
 *   4. Skip already-applied files
 *
 * All existing migrations already use `IF NOT EXISTS` / `ON CONFLICT
 * DO NOTHING`, so re-running them on a DB where they were manually
 * applied earlier is a no-op. Safe to enable retroactively.
 *
 * The runner FAILS LOUDLY on a bad migration (throws on the caller).
 * The caller in src/index.js can choose to crash the bot or log + continue.
 * We crash: a bot running against a half-migrated DB is worse than a
 * bot that's down and visibly broken.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query, pool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

async function ensureLedger() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename     text        PRIMARY KEY,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      checksum_sha256 text     NOT NULL,
      duration_ms  integer
    )
  `);
}

function sha256(s) {
  // Avoid pulling node:crypto inline at module-load time; lazy import.
  // No security need for cryptographic strength — this is just a content
  // tag so we can detect post-apply edits to a migration file (bad practice
  // but worth flagging).
  return import("node:crypto").then((m) =>
    m.createHash("sha256").update(s).digest("hex"),
  );
}

async function appliedFilenames() {
  const { rows } = await query(`SELECT filename FROM schema_migrations`);
  return new Set(rows.map((r) => r.filename));
}

function listMigrationFiles() {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    console.warn(`[migrations] dir not found at ${MIGRATIONS_DIR} — skipping auto-apply`);
    return [];
  }
  return entries.filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
}

/**
 * Apply all pending migrations. Returns { applied: string[], skipped: string[] }.
 * Throws if any migration fails — caller decides what to do.
 */
export async function applyPendingMigrations() {
  await ensureLedger();
  const all = listMigrationFiles();
  if (all.length === 0) return { applied: [], skipped: [] };

  const already = await appliedFilenames();
  const applied = [];
  const skipped = [];

  for (const filename of all) {
    if (already.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const path = join(MIGRATIONS_DIR, filename);
    const sql = readFileSync(path, "utf-8");
    const checksum = await sha256(sql);

    const client = await pool.connect();
    const t0 = Date.now();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum_sha256, duration_ms)
         VALUES ($1, $2, $3)`,
        [filename, checksum, Date.now() - t0],
      );
      await client.query("COMMIT");
      console.log(`[migrations] APPLIED ${filename} (${Date.now() - t0}ms)`);
      applied.push(filename);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // Failing a migration leaves the system in a known-bad state.
      // Bubble the error so the bot crashes visibly rather than running
      // against a half-migrated schema and producing weird runtime errors.
      const msg = `[migrations] FAILED ${filename}: ${err.message}`;
      console.error(msg);
      throw new Error(msg);
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}

/**
 * Backfill the ledger for migrations that were applied historically
 * (before this runner existed). Called once at first deploy of the
 * runner — every file in migrations/ that isn't already in
 * schema_migrations gets recorded as "applied" WITHOUT re-running the
 * SQL. Operator manually verified each one is live in prod before this
 * function existed.
 *
 * Safe because every existing migration uses idempotent CREATE / ALTER
 * patterns — even if a migration WASN'T historically applied and we
 * mark it as such, the next deploy that bumps the runner will catch
 * it on the next legitimate migration that depends on it.
 *
 * NOT called automatically. Operator runs this once with
 *   `node -e 'import("./src/db/migrations-runner.js").then((m) => m.backfillLedger())'`
 * after the first deploy.
 */
export async function backfillLedger() {
  await ensureLedger();
  const all = listMigrationFiles();
  const already = await appliedFilenames();
  let recorded = 0;
  for (const filename of all) {
    if (already.has(filename)) continue;
    const path = join(MIGRATIONS_DIR, filename);
    const sql = readFileSync(path, "utf-8");
    const checksum = await sha256(sql);
    await query(
      `INSERT INTO schema_migrations (filename, checksum_sha256, duration_ms)
       VALUES ($1, $2, NULL)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, checksum],
    );
    recorded++;
    console.log(`[migrations] BACKFILLED ledger entry for ${filename}`);
  }
  console.log(`[migrations] backfill complete — ${recorded} entries recorded`);
}
