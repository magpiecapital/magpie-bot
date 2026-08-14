#!/usr/bin/env node
/**
 * Guard: never edit a migration that has already been applied.
 *
 * WHY THIS EXISTS — a real incident, 2026-08-12.
 *
 * There are two ledgers. `schema_migrations` is written by
 * src/db/migrations-runner.js, runs on EVERY BOOT, and stores a sha256 per
 * file. `_migrations` is written by scripts/migrate.js, is manual-only, and has
 * no checksums.
 *
 * I read `_migrations`, concluded migration 047 had never been applied, and
 * rewrote it as a no-op. The authoritative ledger said otherwise: 047 was
 * applied on 2026-06-13. On the next boot the runner would have hit its tamper
 * check —
 *
 *   "047... was edited after apply (recorded sha256 294a6001..., current ...)"
 *
 * — thrown, dropped the bot into DEGRADED mode, paged the operator, and, because
 * the apply loop aborts on the first failure, blocked every later migration
 * from ever running. The runner's own comments record a previous ledger desync
 * doing exactly this: a crashloop that took the site and Pip down for ~30
 * minutes.
 *
 * The failure mode is nasty because it is INVISIBLE AT REVIEW TIME. The diff
 * looks like a harmless comment change; nothing fails until a deploy, and what
 * fails then is unrelated to the change.
 *
 * This runs the same comparison the boot runner does, so the answer arrives in
 * CI instead of at 3am.
 *
 * Needs DATABASE_URL:
 *   railway run --service magpie-bot node scripts/check-migration-checksums.mjs
 *
 * Without a database it SKIPS rather than fails — a guard that cannot run must
 * not block unrelated work, and the boot runner is still the real backstop.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

if (!process.env.DATABASE_URL) {
  console.log("⏭  DATABASE_URL not set — skipping (run via `railway run`).");
  process.exit(0);
}

const pg = (await import("pg")).default;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

let failures = 0;
try {
  const { rows } = await c.query(
    `SELECT filename, checksum_sha256 FROM schema_migrations`,
  );
  const ledger = new Map(rows.map((r) => [r.filename, r.checksum_sha256]));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  const edited = [];
  const pending = [];

  for (const f of files) {
    const sql = readFileSync(path.join(migrationsDir, f), "utf-8");
    const sum = createHash("sha256").update(sql).digest("hex");
    if (!ledger.has(f)) { pending.push(f); continue; }
    const recorded = ledger.get(f);
    // A NULL recorded checksum predates checksum tracking — nothing to compare.
    if (recorded && recorded !== sum) {
      edited.push({ f, recorded: recorded.slice(0, 12), current: sum.slice(0, 12) });
    }
  }

  console.log(`\nschema_migrations: ${ledger.size} applied · ${files.length} files on disk\n`);

  if (edited.length) {
    failures += edited.length;
    console.error("❌ APPLIED MIGRATIONS WERE EDITED — the next boot will throw:\n");
    for (const e of edited) {
      console.error(`   ${e.f}`);
      console.error(`      recorded ${e.recorded}…  current ${e.current}…`);
    }
    console.error(
      "\n   Restore the exact original bytes (`git checkout <commit> -- <file>`)\n" +
      "   and put the change in a NEW migration file instead.\n",
    );
  } else {
    console.log("✅ every applied migration still matches its recorded checksum");
  }

  if (pending.length) {
    // Not a failure: a new migration is pending until it is applied.
    console.log(`\nℹ️  pending (will apply on next boot): ${pending.join(", ")}`);
  }
} catch (err) {
  console.error("❌ checksum guard errored:", err.message);
  failures++;
} finally {
  await c.end().catch(() => {});
}

console.log(failures === 0 ? "\n✅ migration checksum guard passed\n" : `\n❌ ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
