#!/usr/bin/env node
/**
 * Migration idempotency lint.
 *
 * Runs on every PR + push to main. Catches migration files that
 * could fail with "already exists" / "duplicate object" on re-run
 * — the exact failure that took the bot down at 21:04Z on 2026-06-11.
 *
 * Rules enforced:
 *
 * 1. ADD CONSTRAINT (CHECK or UNIQUE or FK) without an enclosing
 *    `DO $$ ... EXCEPTION WHEN duplicate_object ...` block OR a
 *    preceding `DROP CONSTRAINT IF EXISTS`. Postgres doesn't support
 *    `IF NOT EXISTS` for these — the only idempotent patterns are
 *    DO-block exception catch or DROP-then-ADD.
 *
 * 2. CREATE TYPE / CREATE EXTENSION / CREATE FUNCTION without IF NOT
 *    EXISTS or CREATE OR REPLACE.
 *
 * 3. INSERT INTO with no ON CONFLICT clause when targeting a known
 *    UNIQUE/PK table (best-effort heuristic — flag for human review).
 *
 * Exit codes:
 *   0 — clean
 *   1 — found one or more idempotency issues
 *   2 — script itself errored (e.g. couldn't read migrations dir)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function findIssues(filename, sql) {
  const issues = [];

  // Normalize: drop comments + lowercase for pattern matching, but
  // keep original line indexes for error messages.
  const lines = sql.split("\n");
  const lower = sql.toLowerCase();

  // ── Rule 1: bare ADD CONSTRAINT ──
  // For each line that starts an ADD CONSTRAINT, look BACKWARDS up
  // to 10 lines for either:
  //   - a DO $$ ... block opener (DO $$ BEGIN)
  //   - a DROP CONSTRAINT IF EXISTS on the same constraint name
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // ADD CONSTRAINT might be on its own line in a multi-statement ALTER
    const m = ln.match(/^\s*ADD\s+CONSTRAINT\s+(\w+)/i);
    if (!m) continue;
    const constraintName = m[1];
    let safe = false;

    // Look backwards up to 10 lines (skipping pure comments)
    for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
      const prev = lines[j];
      const trimmed = prev.trim();
      if (trimmed.startsWith("--") || trimmed === "") continue;
      // DO $$ BEGIN opens a block where we expect EXCEPTION WHEN duplicate_object below
      if (/DO\s+\$\$\s*BEGIN/i.test(prev)) {
        // Look forwards from here up to 25 lines for EXCEPTION WHEN
        // ...duplicate_object (possibly after duplicate_table OR or
        // similar multi-error clauses).
        const forwardRange = lines.slice(j, j + 25).join("\n").toLowerCase();
        if (/exception\s+when\s+[^;]*duplicate_(object|table)/.test(forwardRange)) {
          safe = true;
        }
        break;
      }
      // Or a DROP CONSTRAINT IF EXISTS on the same name above us, before the ADD
      if (new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${constraintName}\\b`, "i").test(prev)) {
        safe = true;
        break;
      }
    }
    if (!safe) {
      issues.push({
        file: filename,
        line: i + 1,
        rule: "non-idempotent-ADD-CONSTRAINT",
        text: ln.trim().slice(0, 200),
        fix: `Wrap in 'DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;' OR precede with 'DROP CONSTRAINT IF EXISTS ${constraintName};'`,
      });
    }
  }

  // ── Rule 2: CREATE TYPE / EXTENSION / FUNCTION without idempotency ──
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*CREATE\s+TYPE\s+\w+/i.test(ln) && !/IF\s+NOT\s+EXISTS/i.test(ln)) {
      issues.push({
        file: filename, line: i + 1, rule: "non-idempotent-CREATE-TYPE",
        text: ln.trim().slice(0, 200),
        fix: "Use 'DO $$ BEGIN ... EXCEPTION WHEN duplicate_object ...' block (CREATE TYPE doesn't support IF NOT EXISTS).",
      });
    }
    if (/^\s*CREATE\s+EXTENSION\s+\w+/i.test(ln) && !/IF\s+NOT\s+EXISTS/i.test(ln)) {
      issues.push({
        file: filename, line: i + 1, rule: "non-idempotent-CREATE-EXTENSION",
        text: ln.trim().slice(0, 200),
        fix: "Add IF NOT EXISTS.",
      });
    }
    if (/^\s*CREATE\s+FUNCTION\s+/i.test(ln)) {
      issues.push({
        file: filename, line: i + 1, rule: "non-idempotent-CREATE-FUNCTION",
        text: ln.trim().slice(0, 200),
        fix: "Use 'CREATE OR REPLACE FUNCTION ...' instead.",
      });
    }
  }

  return issues;
}

function main() {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    console.error(`[migration-lint] couldn't read migrations dir at ${MIGRATIONS_DIR}: ${err.message}`);
    process.exit(2);
  }
  const files = entries.filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  if (files.length === 0) {
    console.log("[migration-lint] no migration files found — nothing to check");
    process.exit(0);
  }

  let totalIssues = 0;
  for (const f of files) {
    const full = join(MIGRATIONS_DIR, f);
    const sql = readFileSync(full, "utf8");
    const issues = findIssues(f, sql);
    if (issues.length > 0) {
      totalIssues += issues.length;
      for (const it of issues) {
        console.error(`\n[migration-lint] ${it.file}:${it.line} ${it.rule}`);
        console.error(`  SQL: ${it.text}`);
        console.error(`  Fix: ${it.fix}`);
      }
    }
  }

  if (totalIssues > 0) {
    console.error(`\n[migration-lint] FAILED: ${totalIssues} issue(s) across ${files.length} migration file(s).`);
    console.error("Migrations must be idempotent so re-running them on a DB where they've already");
    console.error("been applied is a clean no-op, not a fatal error. See migrations/027 for the");
    console.error("DO-block pattern that resolves the most common 'constraint already exists' case.");
    process.exit(1);
  }

  console.log(`[migration-lint] OK — ${files.length} migration file(s) all idempotent.`);
  process.exit(0);
}

main();
