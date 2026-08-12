#!/usr/bin/env node
/**
 * READ-ONLY audit of the `_migrations` ledger against the live schema.
 *
 * THE PROBLEM. The ledger records only 001-016 plus 082, but objects from
 * migrations all across 017-098 verifiably exist. Migrations were applied
 * out-of-band and never recorded. That makes `npm run db:migrate` dangerous:
 * it would try to replay ~80 files, including destructive DDL
 * (069_drop_orphan_cap_in_range_constraint, 072_drop_users_telegram_id_not_null).
 *
 * WHAT THIS DOES. For every unrecorded migration, parse the DDL to work out
 * which objects it should have created, then check whether each exists now.
 *
 *   APPLIED       every creatable object it declares is present
 *   NOT_APPLIED   none of them are present
 *   PARTIAL       some present, some missing  <- never auto-record these
 *   UNVERIFIABLE  contains DROP / INSERT / UPDATE / DO blocks whose effect
 *                 cannot be proven from the schema alone
 *
 * WHY IT ONLY REPORTS. Recording a migration as applied is irreversible in
 * effect: the runner will skip it forever. Doing that on a bad inference would
 * silently skip a real schema change. So this script writes nothing — a human
 * reads the output and decides. `--write` is deliberately NOT an option here.
 *
 * Usage:  railway run --service magpie-bot node scripts/audit-migration-ledger.mjs
 */
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

/** Strip comments and string literals so keywords inside them don't match. */
function scrub(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Objects a migration declares, as {kind, name} / {kind, table, column}. */
function declaredObjects(sqlRaw) {
  const sql = scrub(sqlRaw);
  const out = [];

  for (const m of sql.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
  )) out.push({ kind: "table", name: m[1].toLowerCase() });

  for (const m of sql.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi,
  )) out.push({ kind: "index", name: m[1].toLowerCase() });

  for (const m of sql.matchAll(/CREATE\s+TYPE\s+(?:public\.)?"?([a-z0-9_]+)"?/gi))
    out.push({ kind: "type", name: m[1].toLowerCase() });

  // ALTER TABLE <t> ... ADD COLUMN [IF NOT EXISTS] <c>  (one statement may add several)
  for (const stmt of sql.split(";")) {
    const t = stmt.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/i);
    if (!t) continue;
    for (const c of stmt.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
      out.push({ kind: "column", table: t[1].toLowerCase(), name: c[1].toLowerCase() });
    }
  }
  return out;
}

/** Statements whose effect cannot be confirmed from schema introspection. */
function unverifiableReasons(sqlRaw) {
  const sql = scrub(sqlRaw);
  const r = [];
  if (/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i.test(sql)) r.push("DROP");
  if (/\bALTER\s+COLUMN\b/i.test(sql)) r.push("ALTER COLUMN");
  if (/\bADD\s+CONSTRAINT\b/i.test(sql)) r.push("ADD CONSTRAINT");
  if (/\bINSERT\s+INTO\b/i.test(sql)) r.push("INSERT");
  if (/\bUPDATE\s+[a-z0-9_]+\s+SET\b/i.test(sql)) r.push("UPDATE");
  if (/\bDO\s+\$\$/i.test(sql)) r.push("DO block");
  if (/CREATE\s+OR\s+REPLACE/i.test(sql)) r.push("CREATE OR REPLACE");
  return r;
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows: appliedRows } = await c.query("SELECT name FROM _migrations");
const applied = new Set(appliedRows.map((r) => r.name));

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
const pending = files.filter((f) => !applied.has(f));

// Snapshot the live schema once.
const { rows: tRows } = await c.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
);
const tables = new Set(tRows.map((r) => r.table_name.toLowerCase()));

const { rows: cRows } = await c.query(
  `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`,
);
const columns = new Set(cRows.map((r) => `${r.table_name.toLowerCase()}.${r.column_name.toLowerCase()}`));

const { rows: iRows } = await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`);
const indexes = new Set(iRows.map((r) => r.indexname.toLowerCase()));

const { rows: yRows } = await c.query(
  `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`,
);
const types = new Set(yRows.map((r) => r.typname.toLowerCase()));

const exists = (o) =>
  o.kind === "table" ? tables.has(o.name)
  : o.kind === "column" ? columns.has(`${o.table}.${o.name}`)
  : o.kind === "index" ? indexes.has(o.name)
  : o.kind === "type" ? types.has(o.name)
  : false;

const buckets = { APPLIED: [], NOT_APPLIED: [], PARTIAL: [], UNVERIFIABLE: [], NO_OBJECTS: [] };

for (const f of pending) {
  const sql = await readFile(path.join(migrationsDir, f), "utf8");
  const objs = declaredObjects(sql);
  const unver = unverifiableReasons(sql);
  const present = objs.filter(exists);
  const missing = objs.filter((o) => !exists(o));

  const label = (o) =>
    o.kind === "column" ? `${o.table}.${o.name}` : `${o.kind} ${o.name}`;

  if (objs.length === 0) {
    buckets.NO_OBJECTS.push({ f, unver, note: "declares no creatable objects" });
  } else if (missing.length === 0) {
    // Everything creatable is present. If it ALSO has unverifiable statements,
    // it is still not safe to auto-record — say so rather than round up.
    (unver.length ? buckets.UNVERIFIABLE : buckets.APPLIED).push({
      f, unver, present: present.map(label), missing: [],
    });
  } else if (present.length === 0) {
    buckets.NOT_APPLIED.push({ f, unver, present: [], missing: missing.map(label) });
  } else {
    buckets.PARTIAL.push({ f, unver, present: present.map(label), missing: missing.map(label) });
  }
}

const line = (e) =>
  `  ${e.f}` +
  (e.missing?.length ? `\n      MISSING: ${e.missing.join(", ")}` : "") +
  (e.unver?.length ? `\n      unverifiable: ${e.unver.join(", ")}` : "") +
  (e.note ? `\n      ${e.note}` : "");

console.log(`\nledger records ${applied.size} of ${files.length} migration files`);
console.log(`unrecorded: ${pending.length}\n`);

console.log(`=== APPLIED — every declared object present, safe to record (${buckets.APPLIED.length}) ===`);
buckets.APPLIED.forEach((e) => console.log(line(e)));

console.log(`\n=== PARTIAL — SOME objects missing, DO NOT record (${buckets.PARTIAL.length}) ===`);
buckets.PARTIAL.forEach((e) => console.log(line(e)));

console.log(`\n=== NOT_APPLIED — nothing present, genuinely outstanding (${buckets.NOT_APPLIED.length}) ===`);
buckets.NOT_APPLIED.forEach((e) => console.log(line(e)));

console.log(`\n=== UNVERIFIABLE — objects present but has DROP/INSERT/etc, needs eyes (${buckets.UNVERIFIABLE.length}) ===`);
buckets.UNVERIFIABLE.forEach((e) => console.log(line(e)));

console.log(`\n=== NO_OBJECTS — pure data/constraint migrations, needs eyes (${buckets.NO_OBJECTS.length}) ===`);
buckets.NO_OBJECTS.forEach((e) => console.log(line(e)));

console.log(
  `\nSUMMARY applied=${buckets.APPLIED.length} partial=${buckets.PARTIAL.length} ` +
  `not_applied=${buckets.NOT_APPLIED.length} unverifiable=${buckets.UNVERIFIABLE.length} ` +
  `no_objects=${buckets.NO_OBJECTS.length}`,
);
console.log("\nThis script wrote NOTHING. Recording is a separate, deliberate step.\n");

await c.end();
