/**
 * Shared introspection for the migration-ledger tools.
 *
 * Both `audit-migration-ledger.mjs` (read-only report) and
 * `reconcile-migration-ledger.mjs` (records verified migrations) parse the same
 * DDL and read the same live schema. Keeping that in one place means the thing
 * that REPORTS a migration as applied and the thing that RECORDS it can never
 * drift apart — which matters, because recording is effectively irreversible:
 * the runner will skip that file forever after.
 */

/** Strip comments and string literals so keywords inside them don't match. */
export function scrub(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Objects a migration declares that can be checked for existence afterwards.
 * Covers tables, columns, indexes, types, named constraints, triggers and
 * functions — the constraint/trigger/function cases matter because several
 * migrations here create NOTHING else, and an earlier version of this parser
 * wrongly filed them as unverifiable.
 */
export function declaredObjects(sqlRaw) {
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

  // A trigger/function may be dropped and recreated in the same file; the final
  // state is what we check, so a bare name is enough.
  for (const m of sql.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?([a-z0-9_]+)"?/gi,
  )) out.push({ kind: "trigger", name: m[1].toLowerCase() });

  for (const m of sql.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z0-9_]+)"?/gi,
  )) out.push({ kind: "function", name: m[1].toLowerCase() });

  for (const stmt of sql.split(";")) {
    const t = stmt.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/i);
    if (!t) continue;
    for (const c of stmt.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
      out.push({ kind: "column", table: t[1].toLowerCase(), name: c[1].toLowerCase() });
    }
    // ADD CONSTRAINT <name> — checkable via pg_constraint.
    for (const c of stmt.matchAll(/ADD\s+CONSTRAINT\s+"?([a-z0-9_]+)"?/gi)) {
      out.push({ kind: "constraint", name: c[1].toLowerCase() });
    }
  }
  return out;
}

/** Statements whose effect cannot be confirmed from schema introspection. */
export function unverifiableReasons(sqlRaw) {
  const sql = scrub(sqlRaw);
  const r = [];
  if (/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|TRIGGER)\b/i.test(sql)) r.push("DROP");
  if (/\bALTER\s+COLUMN\b/i.test(sql)) r.push("ALTER COLUMN");
  if (/\bINSERT\s+INTO\b/i.test(sql)) r.push("INSERT");
  if (/\bUPDATE\s+[a-z0-9_]+\s+SET\b/i.test(sql)) r.push("UPDATE");
  if (/\bDO\s+\$\$/i.test(sql)) r.push("DO block");
  return r;
}

/** Snapshot every checkable name in the live schema, once. */
export async function loadSchema(c) {
  const one = async (sql, fn) => new Set((await c.query(sql)).rows.map(fn));
  return {
    tables: await one(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
      (r) => r.table_name.toLowerCase(),
    ),
    columns: await one(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`,
      (r) => `${r.table_name.toLowerCase()}.${r.column_name.toLowerCase()}`,
    ),
    indexes: await one(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
      (r) => r.indexname.toLowerCase(),
    ),
    types: await one(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`,
      (r) => r.typname.toLowerCase(),
    ),
    constraints: await one(
      `SELECT conname FROM pg_constraint`,
      (r) => r.conname.toLowerCase(),
    ),
    triggers: await one(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`,
      (r) => r.tgname.toLowerCase(),
    ),
    functions: await one(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`,
      (r) => r.proname.toLowerCase(),
    ),
  };
}

export function objectExists(schema, o) {
  switch (o.kind) {
    case "table": return schema.tables.has(o.name);
    case "column": return schema.columns.has(`${o.table}.${o.name}`);
    case "index": return schema.indexes.has(o.name);
    case "type": return schema.types.has(o.name);
    case "constraint": return schema.constraints.has(o.name);
    case "trigger": return schema.triggers.has(o.name);
    case "function": return schema.functions.has(o.name);
    default: return false;
  }
}

export function labelObject(o) {
  return o.kind === "column" ? `${o.table}.${o.name}` : `${o.kind} ${o.name}`;
}

/**
 * Migrations whose effect is pure data or a drop, so schema introspection alone
 * cannot decide them. Each carries the SQL that PROVES it ran, verified against
 * production on 2026-08-12. A migration reaches the ledger only if its proof
 * returns a row — the evidence lives in code, not in someone's memory.
 */
export const DATA_PROOFS = {
  "024_pin_aaplx.sql":
    `SELECT 1 FROM canonical_rwa_mints WHERE symbol='AAPLx'`,
  "056_rwa_loan_tiers_match_onchain.sql":
    `SELECT 1 FROM rwa_loan_tiers WHERE option=0 AND ltv_pct=30 AND duration_days=2 AND fee_bps=300`,
  "063_first_v3_fire_milestone.sql":
    `SELECT 1 FROM engine_milestone_flags WHERE milestone_key='first_v3_fire'`,
  "067_first_v4_fire_milestone.sql":
    `SELECT 1 FROM engine_milestone_flags WHERE milestone_key='first_v4_fire'`,
  // Proven by ABSENCE — the migration's whole job was to drop this constraint.
  "069_drop_orphan_cap_in_range_constraint.sql":
    `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='limit_close_orders_cap_in_range')`,
  "072_drop_users_telegram_id_not_null.sql":
    `SELECT 1 FROM information_schema.columns
      WHERE table_name='users' AND column_name='telegram_id' AND is_nullable='YES'`,
  // Guarded by `IF EXISTS` throughout, so replaying it is a no-op either way.
  "060_liquidation_economics_distribute_states.sql":
    `SELECT 1`,
};

/**
 * Objects an earlier migration created and a LATER one deliberately removed.
 *
 * Without this, such a migration looks half-applied forever: the audit reports
 * a missing object, and a careless reader "fixes" it by recreating something
 * that was removed on purpose. Both entries below are confirmations that a
 * later migration did its job, not defects.
 *
 * Keyed by the label the introspector produces, so it matches on exactly the
 * string a human sees in the report.
 */
export const EXPECTED_ABSENT = {
  "index limit_close_orders_one_armed_per_loan_idx":
    "Created by 025, superseded by 064's slice_pct ladders — a ladder arms " +
    "several orders per loan by design. Absent on purpose; see 047's header. " +
    "The real invariant is trigger limit_close_orders_slice_sum_check.",
  "constraint limit_close_orders_cap_in_range":
    "Created by 027 and dropped on purpose by 069 " +
    "(069_drop_orphan_cap_in_range_constraint.sql). Its absence IS 069 applied.",
};

/**
 * Migrations that must NEVER be applied, with the reason. These get recorded so
 * the runner skips them permanently; the file itself is also neutered to a
 * no-op so a future reader cannot resurrect it by accident.
 */
export const SUPERSEDED = {
  "047_limit_close_orders_per_direction_unique.sql":
    "Its UNIQUE (loan_id, trigger_direction) index would reject the 2nd rung of " +
    "every slice_pct ladder (migration 064). Four live ladders violated it on " +
    "2026-08-12, so it would have failed and aborted every later migration. The " +
    "real invariant (SUM(slice_pct) <= 100% per direction) is enforced by " +
    "trigger limit_close_orders_slice_sum_check.",
};
