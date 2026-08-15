#!/usr/bin/env node
/**
 * Ops check: no two ENABLED supported_mints rows may share a ticker
 * (case-insensitive). Exits 1 and lists offenders if any exist.
 * Run: railway run node scripts/check-symbol-collisions.mjs
 * Resolution precedent: see the 2026-08-15 cleanup (28 rows, incl. the
 * UOTF/SAOF/USWR/TNOS serial-launch farm) — operator/registry/older row
 * keeps the ticker; farm clusters with no authoritative row are fully
 * disabled. Approval-time guard lives in token-screener.js
 * (enabledSymbolHolder).
 */
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  WITH dupes AS (
    SELECT UPPER(symbol) us FROM supported_mints WHERE enabled = true
    GROUP BY UPPER(symbol) HAVING COUNT(*) > 1
  )
  SELECT sm.symbol, sm.mint, sm.source, sm.protected, sm.created_at::date AS added
  FROM supported_mints sm JOIN dupes d ON UPPER(sm.symbol) = d.us
  WHERE sm.enabled = true ORDER BY UPPER(sm.symbol), sm.created_at`);
await c.end();
if (rows.length === 0) { console.log("OK: no enabled symbol collisions"); process.exit(0); }
console.error(`FAIL: ${rows.length} enabled rows share tickers:`);
for (const r of rows) console.error(`  ${r.symbol.padEnd(10)} ${r.mint} ${r.source} protected=${r.protected} added=${r.added.toISOString().slice(0, 10)}`);
process.exit(1);
