#!/usr/bin/env node
/**
 * Apply exactly ONE migration and record it in the `_migrations` ledger.
 *
 *   railway run --service magpie-bot node scripts/apply-one-migration.mjs 099_loan_warning_undeliverable.sql
 *
 * WHY THIS EXISTS — do not use `npm run db:migrate` on this database.
 *
 * The `_migrations` ledger is STALE. It records only 001-016 plus 082, but
 * objects from migrations 025-097 all verifiably exist in the schema
 * (collectible_submissions, conversion_events, screening_trusted_holders,
 * limit_close_orders, loans.actual_received_lamports, users.telegram_id
 * nullable — all present). Migrations were applied out-of-band and never
 * recorded.
 *
 * So the standard runner would attempt to REPLAY roughly 80 migrations against
 * a schema that already has them, including destructive DDL:
 *   069_drop_orphan_cap_in_range_constraint.sql
 *   072_drop_users_telegram_id_not_null.sql
 * Some would no-op via IF NOT EXISTS; others would fail or drop live objects.
 *
 * This script is the safe path: one named file, in a transaction, rolled back
 * on any error, then verified. It never touches any other migration.
 *
 * It deliberately does NOT backfill the ledger for the other ~80 files.
 * Marking them applied would be a real decision needing real verification, not
 * a side effect of shipping one column.
 */
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

const FILE = process.argv[2];
if (!FILE || !/^\d{3}_[\w.-]+\.sql$/.test(FILE)) {
  console.error("usage: node scripts/apply-one-migration.mjs <NNN_name.sql>");
  process.exit(1);
}

let sql;
try {
  // Resolve against the migrations dir explicitly so cwd cannot matter, and so
  // a path like "../../etc/passwd" cannot escape it.
  const full = path.join(migrationsDir, path.basename(FILE));
  sql = await readFile(full, "utf8");
} catch (e) {
  console.error(`✗ cannot read migrations/${FILE}: ${e.message}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("✗ DATABASE_URL is not set — run this via `railway run --service magpie-bot`");
  process.exit(1);
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

try {
  const { rows: already } = await c.query("SELECT name FROM _migrations WHERE name=$1", [FILE]);
  if (already.length) {
    console.log(`✓ ${FILE} already recorded as applied — nothing to do`);
    await c.end();
    process.exit(0);
  }

  await c.query("BEGIN");
  try {
    await c.query(sql);
    await c.query("INSERT INTO _migrations (name) VALUES ($1)", [FILE]);
    await c.query("COMMIT");
    console.log(`✓ ${FILE} applied and recorded`);
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(`✗ ROLLED BACK, database unchanged: ${e.message}`);
    await c.end();
    process.exit(1);
  }

  // Verify rather than assume.
  const { rows: cols } = await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='loans' AND column_name LIKE 'warn\\_%' ORDER BY 1`,
  );
  if (cols.length) console.log("verified loans warn_* columns: " + cols.map((r) => r.column_name).join(", "));

  const { rows: idx } = await c.query(
    `SELECT indexname FROM pg_indexes WHERE indexname='idx_loans_active_due_unwarned'`,
  );
  console.log("verified index: " + (idx.length ? idx[0].indexname : "(n/a for this migration)"));
} finally {
  await c.end().catch(() => {});
}
