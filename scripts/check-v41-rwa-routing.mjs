#!/usr/bin/env node
/**
 * Guard: an exit-armed RWA borrow must NEVER route to V4.1.
 *
 * WHY. V4.1 ships Sec3's [H-01] fix, which rejects any Token-2022 collateral
 * carrying `PermanentDelegate`. Scanned mainnet 2026-08-13:
 *
 *   memecoins            0 of 233 blocked
 *   stocks/ETFs/metals  25 of  25 blocked  ← every single one
 *
 * Regulated issuers use PermanentDelegate for compliance clawback and
 * redemption, so it is the norm for real-world assets. Operator decision
 * 2026-08-13 was to ship Sec3's recommendation unmodified and keep RWAs on V4
 * rather than carve an exemption into audited custody logic.
 *
 * That decision is only safe if ROUTING enforces it. Without the guard,
 * flipping ROUTE_EXITS_TO_V4_1=true sends an exit-armed RWA borrow to a program
 * that refuses the mint, and the borrower gets an opaque
 * `UnsupportedCollateralExtension` failure at signing time.
 *
 * This is a live path, not hypothetical: 34 RWA take-profit/stop-loss orders
 * have been armed to date and 5 are still armed.
 *
 * The failure mode is invisible until the flag flips — which is exactly when
 * nobody is looking for it. Hence a guard rather than a comment.
 *
 * Run: npm run check:v41-rwa-routing
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, "../src/solana/program.js"), "utf8");

let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { failures++; console.error(`  ❌ ${n}${d ? ` — ${d}` : ""}`); };
const expect = (n, a, w) => (a === w ? ok(n) : bad(n, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(w)}`));

console.log("\n== the routing decision, modelled exactly as shipped ==");
{
  const RWA = new Set(["stock", "etf", "metal"]);
  // Mirrors chooseProgramId's exit-arming branch.
  const pick = ({ category, hasV41, routeFlag }) => {
    const rwaMustStayOnV4 = RWA.has(category);
    return hasV41 && routeFlag && !rwaMustStayOnV4 ? "V4.1" : "V4";
  };

  // The dangerous configuration: V4.1 deployed AND the flag flipped on.
  const live = { hasV41: true, routeFlag: true };
  expect("memecoin exit-armed  → V4.1", pick({ ...live, category: "memecoin" }), "V4.1");
  expect("stock exit-armed     → V4 (NOT V4.1)", pick({ ...live, category: "stock" }), "V4");
  expect("etf exit-armed       → V4 (NOT V4.1)", pick({ ...live, category: "etf" }), "V4");
  expect("metal exit-armed     → V4 (NOT V4.1)", pick({ ...live, category: "metal" }), "V4");
  // GLDx and SILV are both 'metal' — the tokens this actually protects.
  expect("undefined category   → V4.1 (treated as memecoin, existing behaviour)",
    pick({ ...live, category: undefined }), "V4.1");

  // Flag off: byte-identical to today, nothing reaches V4.1.
  const off = { hasV41: true, routeFlag: false };
  for (const c of ["memecoin", "stock", "etf", "metal"]) {
    if (pick({ ...off, category: c }) !== "V4") bad(`flag OFF: ${c} should stay on V4`);
  }
  ok("flag OFF → everything stays on V4 (routing identical to today)");

  // V4.1 not deployed: same.
  const nodeploy = { hasV41: false, routeFlag: true };
  for (const c of ["memecoin", "stock", "etf", "metal"]) {
    if (pick({ ...nodeploy, category: c }) !== "V4") bad(`V4.1 absent: ${c} should stay on V4`);
  }
  ok("V4.1 not configured → everything stays on V4");
}

console.log("\n== the guard is actually in the shipped source ==");
expect("RWA guard present", /const rwaMustStayOnV4 = isRwaCategory\(category\);/.test(src), true);
expect("  ...and gates the V4.1 selection", /ROUTE_EXITS_TO_V4_1 && !rwaMustStayOnV4/.test(src), true);
expect("RWA category set is the canonical one",
  /RWA_CATEGORIES = new Set\(\["stock", "etf", "metal"\]\)/.test(src), true);
expect("the reason is documented at the call site", /PermanentDelegate/.test(src), true);

console.log(
  failures === 0 ? "\n✅ V4.1 RWA routing guard passed\n" : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
