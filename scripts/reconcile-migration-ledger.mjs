#!/usr/bin/env node
/**
 * Reconcile the `_migrations` ledger with the schema that actually exists.
 *
 * THE PROBLEM. The ledger recorded 18 of 97 migration files. Everything else
 * had been applied out-of-band and never written down, which made
 * `npm run db:migrate` a loaded gun: it would have replayed ~79 files against a
 * schema that already had them. Worse, migration 047 would have FAILED outright
 * (its unique index is violated by four live ladders), and since migrate.js
 * exits on first failure, every migration after it would have been skipped.
 *
 * WHAT THIS DOES. For every unrecorded migration it re-derives a verdict from
 * live evidence — never from a stored list — and records only what it can prove:
 *
 *   - every table / column / index / type / constraint / trigger / function the
 *     file declares must exist; or
 *   - for pure-data or pure-drop migrations, the proof query in DATA_PROOFS
 *     must return a row; or
 *   - the file is listed in SUPERSEDED, meaning it must never run.
 *
 * Anything that fails is left unrecorded and printed. Recording is effectively
 * irreversible — the runner skips that file forever — so the bar is evidence,
 * not inference.
 *
 * Idempotent: re-running it records nothing new.
 *
 *   railway run --service magpie-bot node scripts/reconcile-migration-ledger.mjs
 *   railway run --service magpie-bot node scripts/reconcile-migration-ledger.mjs --write
 *
 * Without --write it only reports. Nothing is ever dropped or altered; the sole
 * mutation is INSERT INTO _migrations.
 */
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  declaredObjects,
  loadSchema,
  objectExists,
  labelObject,
  EXPECTED_ABSENT,
  DATA_PROOFS,
  SUPERSEDED,
} from "./lib/migration-introspect.mjs";

const WRITE = process.argv.includes("--write");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows: appliedRows } = await c.query("SELECT name FROM _migrations");
const applied = new Set(appliedRows.map((r) => r.name));
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
const pending = files.filter((f) => !applied.has(f));

const schema = await loadSchema(c);

const willRecord = [];
const cannot = [];

for (const f of pending) {
  if (SUPERSEDED[f]) {
    willRecord.push({ f, why: "SUPERSEDED — must never run", detail: SUPERSEDED[f] });
    continue;
  }

  const objs = declaredObjects(await readFile(path.join(migrationsDir, f), "utf8"));
  const allMissing = objs.filter((o) => !objectExists(schema, o));

  // An object a LATER migration deliberately removed is not evidence that this
  // one failed — it is evidence the later one worked. Split those out rather
  // than letting them mask a genuine gap.
  const removedLater = allMissing.filter((o) => EXPECTED_ABSENT[labelObject(o)]);
  const missing = allMissing.filter((o) => !EXPECTED_ABSENT[labelObject(o)]);

  if (objs.length > 0 && missing.length === 0) {
    willRecord.push({
      f,
      why:
        `all ${objs.length} declared object(s) accounted for` +
        (removedLater.length
          ? ` (${removedLater.map(labelObject).join(", ")} removed later, on purpose)`
          : ""),
      detail: removedLater.length ? EXPECTED_ABSENT[labelObject(removedLater[0])] : undefined,
    });
    continue;
  }

  const proof = DATA_PROOFS[f];
  if (proof) {
    let proven = false;
    try {
      proven = (await c.query(proof)).rows.length > 0;
    } catch (e) {
      cannot.push({ f, why: `proof query errored: ${e.message.slice(0, 80)}` });
      continue;
    }
    if (proven) willRecord.push({ f, why: "data proof satisfied" });
    else cannot.push({ f, why: "data proof returned no rows — NOT applied" });
    continue;
  }

  cannot.push({
    f,
    why: missing.length
      ? `missing: ${missing.map(labelObject).join(", ")}`
      : "declares nothing checkable and has no proof entry",
  });
}

console.log(`\nledger: ${applied.size} of ${files.length} recorded · ${pending.length} unrecorded\n`);
console.log(`=== WILL RECORD (${willRecord.length}) ===`);
for (const e of willRecord) {
  console.log(`  ${e.f}\n      ${e.why}`);
  if (e.detail) console.log(`      ${e.detail.replace(/\s+/g, " ").slice(0, 300)}`);
}
console.log(`\n=== CANNOT VERIFY — left unrecorded (${cannot.length}) ===`);
if (!cannot.length) console.log("  (none)");
for (const e of cannot) console.log(`  ${e.f}\n      ${e.why}`);

if (!WRITE) {
  console.log(`\nDRY RUN — nothing written. Re-run with --write to record the ${willRecord.length} above.\n`);
  await c.end();
  process.exit(0);
}

let recorded = 0;
for (const e of willRecord) {
  // ON CONFLICT keeps this safe under concurrent runs and makes re-running a
  // no-op rather than an error.
  const r = await c.query(
    "INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
    [e.f],
  );
  recorded += r.rowCount;
}
console.log(`\n✓ recorded ${recorded} migration(s)`);

const { rows: after } = await c.query("SELECT COUNT(*)::int AS n FROM _migrations");
console.log(`ledger now: ${after[0].n} of ${files.length}`);
console.log(
  cannot.length
    ? `⚠️  ${cannot.length} still unrecorded — db:migrate would attempt these.`
    : "✓ ledger complete — `npm run db:migrate` is safe again.",
);
await c.end();
