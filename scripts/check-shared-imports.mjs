#!/usr/bin/env node
/**
 * Static check: flag bare references to symbols that MUST come from
 * imports. Catches the class of bug that took prod down on 2026-06-15
 * — a bare `PROGRAM_ID_V4` reference inside executeRepay() that wasn't
 * in the file's imports block. `node --check` doesn't catch this
 * because it only validates syntax; the missing-binding throws as
 * ReferenceError at runtime when the function body executes.
 *
 * Run locally: node scripts/check-shared-imports.mjs
 * Run in CI:    same — exits non-zero on any violation.
 *
 * Logic:
 *   1. For each tracked symbol (PROGRAM_ID, PROGRAM_ID_V2, V3, V4):
 *      - Find every .js/.mjs file under src/ that contains the symbol
 *        AS A BARE IDENTIFIER (not "process.env.PROGRAM_ID_V4", not
 *        a string literal, not a comment).
 *      - For each match, verify the file also has an `import { ... }
 *        from "../solana/program.js"` that includes the symbol.
 *   2. Emit a clear file:line error for any miss + exit 1.
 *
 * Extend by adding symbols to TRACKED_SYMBOLS. Keep this list narrow
 * — false positives waste developer time on rebuilds.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC_ROOT = join(REPO_ROOT, "src");

const TRACKED_SYMBOLS = [
  "PROGRAM_ID",
  "PROGRAM_ID_V2",
  "PROGRAM_ID_V3",
  "PROGRAM_ID_V4",
];

// Matches any relative import that ends in /program.js or /program.
// Different files reach src/solana/program.js via different relative
// paths (./, ../, ../../). We just check the trailing filename.
const PROGRAM_MODULE_RE = /from\s*["'][^"']*\/program(?:\.js)?["']/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith(".js") || full.endsWith(".mjs")) yield full;
  }
}

function stripCommentsAndStrings(src) {
  // Remove block comments, line comments, single+double+template string
  // contents. Crude but enough to avoid false positives on commented-out
  // identifiers or symbol names embedded in user-facing strings.
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findBareRefs(src, symbol) {
  const stripped = stripCommentsAndStrings(src);
  // \b boundary on both sides; reject `process.env.SYMBOL` by requiring
  // the char before not to be `.`.
  const re = new RegExp(`(?<![.\\w])${symbol}\\b`, "g");
  const lines = stripped.split("\n");
  const hits = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (re.test(line)) {
      hits.push({ line: lineIdx + 1, text: line.trim().slice(0, 200) });
      re.lastIndex = 0;
    }
  }
  return hits;
}

function fileImportsSymbol(src, symbol) {
  // Look for the symbol in any import-from-program.js statement.
  // Static: import { ... SYMBOL ... } from ".../program.js"
  const staticRe = new RegExp(
    `import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*${PROGRAM_MODULE_RE.source}`,
    "s",
  );
  if (staticRe.test(src)) return true;
  // Dynamic: const { ... SYMBOL ... } = await import(".../program.js")
  const dynRe = new RegExp(
    `\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(["'][^"']*\\/program(?:\\.js)?["']\\)`,
    "s",
  );
  return dynRe.test(src);
}

let violations = 0;
for (const file of walk(SRC_ROOT)) {
  // Exempt the program.js source file itself (defines the symbols).
  const rel = relative(REPO_ROOT, file);
  if (rel.endsWith("src/solana/program.js")) continue;
  // Exempt IDLs and JSON.
  if (file.endsWith(".json")) continue;

  const src = readFileSync(file, "utf8");

  for (const symbol of TRACKED_SYMBOLS) {
    const hits = findBareRefs(src, symbol);
    if (hits.length === 0) continue;
    if (fileImportsSymbol(src, symbol)) continue;
    for (const h of hits) {
      console.error(
        `::error file=${rel},line=${h.line}::bare reference to '${symbol}' without importing from '${PROGRAM_MODULE}': ${h.text}`,
      );
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(
    `\nFound ${violations} bare-identifier violation(s). Each file that references PROGRAM_ID / PROGRAM_ID_V2 / V3 / V4 outside of \`process.env.\`, comments, or strings MUST import the symbol from ${PROGRAM_MODULE}. This check catches the class of bug that took prod down on 2026-06-15 (PR #265's bare PROGRAM_ID_V4 reference in loans.js executeRepay).`,
  );
  process.exit(1);
}
console.log("shared-imports check passed");
