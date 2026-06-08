#!/usr/bin/env node
/**
 * Privacy lint — scans every public-route handler for paths that
 * could leak telegram_username (or other personal identifiers) in
 * an API response.
 *
 * Designed to catch regressions BEFORE they ship:
 *
 *   - Run manually: `node scripts/check-privacy.js`
 *   - Run on every push: add to a pre-push git hook
 *   - Run at bot startup: src/index.js imports + calls this as a
 *     fail-fast assertion. If a new leak appears in code, the bot
 *     refuses to start (operator gets a loud error in Railway logs).
 *
 * Heuristic: for each file in src/api/, look for `telegram_username:`
 * in a return body context (i.e. inside a `body: { ... }` block, or
 * top-level body keys of an Express-style return). Whitelist the
 * known-safe handlers (signed endpoints where the wallet owner is the
 * only reader, like /me/export).
 *
 * Returns:
 *   exit code 0 — clean
 *   exit code 1 — found one or more leaks, list printed to stderr
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filenameLocal = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filenameLocal);
const API_DIR = path.resolve(__dirname, "..", "src", "api");

// Endpoints where exposing telegram_username is acceptable because
// they require the wallet owner's own signature — only the user
// reading their own data. Add new entries only after careful review.
const SIGNED_OWNER_ONLY = new Set([
  "me-export.js",       // /api/v1/me/export — Ed25519 signed by wallet owner
]);

// Patterns we treat as "this field is in an API response body."
// Conservative: any line that names telegram_username after a colon
// is a candidate. False positives are fine — we'd rather flag too
// much than miss a leak.
const SUSPECT_PATTERNS = [
  /telegram_username\s*:/i,
  /telegramUsername\s*:/i,
];

function scanFile(filePath) {
  const src = readFileSync(filePath, "utf-8");
  const findings = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // Skip pure comments and SQL-only contexts
    const trimmed = ln.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    // Skip SQL SELECT/INSERT statements
    if (/SELECT.*telegram_username|INSERT INTO\s+users|SET\s+telegram_username/i.test(ln)) continue;
    // Skip destructuring + internal const declarations
    if (/const\s+\{[^}]*telegram_username[^}]*\}\s*=/.test(ln)) continue;
    // Skip function-arg keys (e.g. { username: x.telegram_username } passed INTERNALLY to chatWithAgent)
    if (/username\s*:\s*\w+\.telegram_username/.test(ln)) continue;
    for (const re of SUSPECT_PATTERNS) {
      if (re.test(ln)) {
        findings.push({ line: i + 1, text: ln.trim().slice(0, 200) });
        break;
      }
    }
  }
  return findings;
}

function main() {
  const files = readdirSync(API_DIR).filter((f) => f.endsWith(".js"));
  let leaks = 0;
  for (const f of files) {
    if (SIGNED_OWNER_ONLY.has(f)) continue;
    const full = path.join(API_DIR, f);
    if (!statSync(full).isFile()) continue;
    const findings = scanFile(full);
    for (const { line, text } of findings) {
      console.error(`[privacy-lint] LEAK candidate: src/api/${f}:${line}`);
      console.error(`  ${text}`);
      leaks++;
    }
  }
  if (leaks > 0) {
    console.error("");
    console.error(`[privacy-lint] ${leaks} potential telegram_username leak(s).`);
    console.error("If a flagged line is genuinely safe, add the file to");
    console.error("SIGNED_OWNER_ONLY in scripts/check-privacy.js with a comment.");
    process.exit(1);
  }
  console.log("[privacy-lint] No telegram_username leaks in public-route handlers.");
}

// Exported for in-process startup assertion (called from src/index.js).
// Throws on leaks so the bot refuses to start.
export function assertNoPrivacyLeaksOrThrow() {
  const files = readdirSync(API_DIR).filter((f) => f.endsWith(".js"));
  const allFindings = [];
  for (const f of files) {
    if (SIGNED_OWNER_ONLY.has(f)) continue;
    const full = path.join(API_DIR, f);
    if (!statSync(full).isFile()) continue;
    const findings = scanFile(full);
    for (const fnd of findings) allFindings.push({ file: f, ...fnd });
  }
  if (allFindings.length > 0) {
    const summary = allFindings
      .map((x) => `  src/api/${x.file}:${x.line} — ${x.text.slice(0, 120)}`)
      .join("\n");
    throw new Error(
      `[privacy-lint] Refusing to start — ${allFindings.length} telegram_username leak(s) in public handlers:\n${summary}`,
    );
  }
}

// CLI entry point. We can't reliably test "main module" with file://
// URLs across all Node versions, so just run the CLI when this file
// is the entry point.
if (path.resolve(process.argv[1] || "") === __filenameLocal) {
  main();
}
