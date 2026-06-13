/**
 * Synthetic invariant check for the loan-tier-resolver — the single
 * source of truth for borrow LTV across cosign-borrow, the TG bot, the
 * x402 agent, and the dashboard quote.
 *
 * Pure static-file analysis — no npm deps, no DB, runs in any clean
 * Node environment. Asserts:
 *
 *   1. services/loan-tier-resolver.js exports getTierByOption,
 *      getEligibleTiers, and MEMECOIN_TIERS — the API every borrow
 *      callsite is expected to use.
 *
 *   2. MEMECOIN_TIERS still seeds 30/25/20% LTV. If a future PR
 *      changes the memecoin economics, the change is intentional;
 *      this test then needs updating in lockstep — that lockstep is
 *      the point.
 *
 *   3. Every borrow-path callsite imports loan-tier-resolver. If
 *      someone adds a new borrow surface, they must wire it through
 *      the resolver — not roll their own tier table.
 *
 *   4. None of those callsites contain a hardcoded LTV-map assignment
 *      ("= { 0: 30, 1: 25, 2: 20 }"). The 2026-06-13 bug class:
 *      cosign-borrow.js had exactly this literal, applied to RWA
 *      collateral, silently downgrading 12 loans worth 23 SOL.
 *
 * Runs in .github/workflows/ltv-guard.yml alongside the grep guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: actual=${actual} expected=${expected}`);
  if (!ok) failures++;
}

function readFile(rel) {
  try { return readFileSync(path.join(repoRoot, rel), "utf8"); }
  catch { return null; }
}

// Strip line comments so literals in comments don't false-positive the
// "no hardcoded LTV" check. Multi-line /* */ comments containing the
// pattern are exotic enough to accept that small risk.
function stripLineComments(src) {
  return src.split("\n").map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");
}

// ── resolver shape ────────────────────────────────────────────────
console.log("[verify-tier-resolution] checking loan-tier-resolver shape…");
const resolverSrc = readFile("src/services/loan-tier-resolver.js");
check("loan-tier-resolver.js present", resolverSrc !== null, true);
if (resolverSrc !== null) {
  check("exports getTierByOption",
    /export\s+(async\s+)?function\s+getTierByOption\b/.test(resolverSrc), true);
  check("exports getEligibleTiers",
    /export\s+(async\s+)?function\s+getEligibleTiers\b/.test(resolverSrc), true);
  check("exports MEMECOIN_TIERS",
    /export\s+const\s+MEMECOIN_TIERS\b/.test(resolverSrc), true);
  // The literal 30/25/20 ladder should be present in MEMECOIN_TIERS — if a
  // future change moves memecoin economics, this test needs updating in
  // lockstep (intentional).
  check("MEMECOIN_TIERS still seeds 30/25/20 LTV",
    /ltv:\s*30[\s\S]*?ltv:\s*25[\s\S]*?ltv:\s*20/.test(resolverSrc), true);
}

// ── borrow-path callsites ─────────────────────────────────────────
console.log("");
console.log("[verify-tier-resolution] checking borrow-path callsites use the resolver…");
const borrowFiles = [
  "src/api/cosign-borrow.js",
  "src/api/agent.js",
  "src/commands/simulate.js",
  "src/commands/reborrow.js",
];
for (const f of borrowFiles) {
  const src = readFile(f);
  if (src === null) { console.log(`  - ${f} not present (skip)`); continue; }
  const usesResolver = /from\s+["'][^"']*loan-tier-resolver[^"']*["']/.test(src);
  const codeOnly = stripLineComments(src);
  const hasHardcodedMap = /=\s*\{\s*0:\s*30\s*,\s*1:\s*25\s*,\s*2:\s*20\s*\}/.test(codeOnly);
  check(`${f} imports loan-tier-resolver`, usesResolver, true);
  check(`${f} has no hardcoded memecoin LTV assignment`, hasHardcodedMap, false);
}

console.log("");
if (failures > 0) {
  console.error(`[verify-tier-resolution] FAILED — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("[verify-tier-resolution] OK — all invariants hold");
