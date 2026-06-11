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

async function appliedLedger() {
  const { rows } = await query(`SELECT filename, checksum_sha256 FROM schema_migrations`);
  const map = new Map();
  for (const r of rows) map.set(r.filename, r.checksum_sha256);
  return map;
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

// Postgres advisory-lock key dedicated to the migration runner. Stable
// 32-bit int so concurrent bot instances (during Railway redeploys when
// old + new run briefly together) serialize through the same lock and
// only one applies pending migrations at a time. The lock is auto-released
// on session end so a crashing bot doesn't strand the lock.
const MIGRATIONS_ADVISORY_LOCK_KEY = 0x6D470A11; // "mGr\n!" magic — arbitrary but stable

// Migration content must not contain invisible / bidi-override characters.
// Catches a malicious PR that hides DROP / TRUNCATE / DELETE inside a
// zero-width-joiner or right-to-left-override that wouldn't surface in
// code review. Legitimate Unicode (em-dash, smart quotes, accented
// letters in comments) is allowed — only the specific code-points used
// to hide text are rejected.
//   U+200B–U+200F  zero-width space, ZWJ, ZWNJ, LRM, RLM
//   U+202A–U+202E  bidi embedding / override
//   U+2060–U+2069  word joiner, invisible plus, invisible times, invisible separators
//   U+FEFF         BOM / ZWNBSP
const DANGEROUS_UNICODE_RE = /[​-‏‪-‮⁠-⁩﻿]/;

/**
 * Apply all pending migrations. Returns { applied: string[], skipped: string[] }.
 * Throws if any migration fails — caller decides what to do.
 *
 * Multi-instance safety: takes a session-level Postgres advisory lock
 * for the duration of the apply loop. During Railway redeploys both
 * old + new bot instances briefly run together; without the lock both
 * race to apply the same files, with the second hitting a primary-key
 * conflict on schema_migrations.filename (best case) or executing
 * partially-non-idempotent SQL twice (worst case). The advisory lock
 * serializes through Postgres so only one runner applies at a time;
 * the other blocks until the first commits, then no-ops because the
 * ledger now lists all files as applied.
 */
export async function applyPendingMigrations() {
  await ensureLedger();
  const all = listMigrationFiles();
  if (all.length === 0) return { applied: [], skipped: [] };

  const client = await pool.connect();
  const applied = [];
  const skipped = [];

  try {
    // Lock for the duration of this session — released on .release().
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATIONS_ADVISORY_LOCK_KEY]);

    // Re-read ledger AFTER taking the lock (another instance may have
    // applied files while we were waiting for the lock).
    const already = await appliedLedger();

    for (const filename of all) {
      const path = join(MIGRATIONS_DIR, filename);
      const sql = readFileSync(path, "utf-8");
      const checksum = await sha256(sql);

      // Hidden-Unicode check applies only when APPLYING a migration —
      // already-applied historical files are trusted (operator review
      // surfaced no issues at the time they ran) and we don't want a
      // ZWJ-in-a-comment in a year-old migration to start blocking
      // bot startup. New migrations being applied for the first time
      // get the full check.
      if (!already.has(filename) && DANGEROUS_UNICODE_RE.test(sql)) {
        throw new Error(`[migrations] ${filename} contains hidden Unicode characters (zero-width or bidi-override) — refusing to apply. Strip them and re-stage.`);
      }

      if (already.has(filename)) {
        // Already applied. Verify the file hasn't been edited post-apply.
        const recorded = already.get(filename);
        if (recorded && recorded !== checksum) {
          throw new Error(
            `[migrations] ${filename} was edited after apply ` +
            `(recorded sha256 ${recorded.slice(0, 12)}..., current ${checksum.slice(0, 12)}...). ` +
            `Editing applied migrations is unsafe — create a new migration file instead.`,
          );
        }
        skipped.push(filename);
        continue;
      }

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
        const msg = `[migrations] FAILED ${filename}: ${err.message}`;
        console.error(msg);
        throw new Error(msg);
      }
    }
  } finally {
    // Release lock + client. Lock is also released automatically on
    // session close (advisory locks are session-scoped) so a process
    // crash mid-apply doesn't strand the lock.
    try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATIONS_ADVISORY_LOCK_KEY]); } catch {}
    client.release();
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
  const already = await appliedLedger();
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
