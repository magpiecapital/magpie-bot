#!/usr/bin/env node
/**
 * PRE-DISTRIBUTION SAFETY CHECK.
 *
 * Refuses (exit 1) if the holder-enumeration code that a distribution or
 * governance snapshot would run still contains the 0-SOL exclusion bug —
 * a null account (a real wallet holding 0 native SOL) dropped by the
 * anti-PDA filter without the on-curve discriminator. That bug silently
 * excluded legitimate holders from rewards + governance weight; fixed in
 * PRs #603 (magpie-holder-rewards.js) and #604 (governance-snapshot.js).
 * See memory feedback_holder_rewards_zero_sol_exclusion_bug.
 *
 * WHY CONTENT-BASED, NOT GIT-BASED: distributions are operator-initiated
 * LOCAL runs that execute whatever files are in the current checkout. A
 * git/branch check can be fooled (detached HEAD, dirty tree, cherry-picks);
 * scanning the actual source that will run is the only reliable gate. If
 * you distribute from a stale branch (e.g. one behind the merged fix),
 * this catches it.
 *
 * Run it immediately before any distribution:
 *   node scripts/predistribution-safety-check.mjs && <your distribution command>
 *
 * Exit 0 = safe to distribute. Exit 1 = DO NOT distribute (details printed).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const root = join(dirname(SELF), "..");

// The vulnerable one-liner: a null account is dropped in the SAME
// conditional as the owner check, with no on-curve discrimination. The
// fixed form splits it (`if (!info) { …isOnCurve… } else if (owner…)`),
// so this pattern only matches the buggy combined form. Tolerant of the
// variable name (info / accountInfo / acctInfo) to catch copy-paste variants.
const VULN = /!\s*\w*[Ii]nfo\s*\|\|\s*\w*[Ii]nfo\.owner\s*\?\.\s*toBase58\(\)\s*!==/;

// Enumeration paths that MUST carry the on-curve guard. If a new
// distribution/snapshot enumeration is added, add it here too.
const MUST_HAVE_ONCURVE = [
  "src/services/magpie-holder-rewards.js",
  "src/services/governance-snapshot.js",
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(e) && basename(p) !== basename(SELF)) out.push(p);
  }
  return out;
}

const failures = [];

// 1. Scan every source file for a re-introduced vulnerable pattern.
for (const f of [...walk(join(root, "src")), ...walk(join(root, "scripts"))]) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((ln, i) => {
    if (VULN.test(ln)) failures.push(`VULN  ${f.replace(root + "/", "")}:${i + 1}  ${ln.trim()}`);
  });
}

// 2. Positive check: each enumeration path must have the on-curve guard.
for (const rel of MUST_HAVE_ONCURVE) {
  let txt;
  try { txt = readFileSync(join(root, rel), "utf8"); } catch { failures.push(`MISSING FILE  ${rel}`); continue; }
  if (!/PublicKey\.isOnCurve/.test(txt)) failures.push(`NO-GUARD  ${rel} — missing PublicKey.isOnCurve (0-SOL holders would be excluded)`);
}

if (failures.length) {
  console.error("✗ PRE-DISTRIBUTION CHECK FAILED — the 0-SOL exclusion bug is present in this checkout.");
  console.error("  DO NOT run a distribution or governance snapshot from here.\n");
  for (const f of failures) console.error("  " + f);
  console.error("\n  The fix is on `main` (PRs #603 + #604). Fix: git checkout main && git pull, then retry.");
  process.exit(1);
}

console.log("✓ Pre-distribution check PASSED — on-curve 0-SOL guard present in all enumeration paths; no vulnerable pattern found. Safe to distribute.");
process.exit(0);
