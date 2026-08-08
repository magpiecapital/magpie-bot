#!/usr/bin/env node
/**
 * Guard: the V4.1 account-list deltas we build for must match the IDL.
 *
 * A missing account surfaces on-chain as `AccountNotEnoughKeys` and takes the
 * instruction with it. That is exactly how V4 launch day went — the code
 * comments in keeper.js record it: "Without these, every V4 overdue loan fails
 * with AccountNotEnoughKeys and stays uncollected." An extra or mis-ordered
 * account fails just as hard.
 *
 * So rather than trusting that someone re-reads the IDL after each audit round,
 * this pins the delta. If Sec3's next round adds an account to any of these
 * instructions, this fails and names it — instead of the deploy discovering it.
 *
 * Dependency-free (reads the IDL JSON and the call sites as text), so it runs
 * in CI with no install step, like the repo's other guards.
 *
 * Usage: node scripts/check-v41-accounts.mjs   ·   exit 0 clean, 1 drifted
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");
const idl = (f) => JSON.parse(readFileSync(path.join(root, "src", "solana", "idl", f), "utf8"));
const v4 = idl("magpie-v4.json");
const v41 = idl("magpie-v4-1.json");

let failed = 0;
const fail = (m) => { failed++; console.error(`✕ ${m}`); };

const accounts = (i, name) => {
  const ix = i.instructions.find((x) => x.name === name);
  return ix ? ix.accounts.map((a) => a.name) : null;
};

/**
 * The deltas we have built for. Keep this in step with the call sites — it is
 * the whole point of the guard.
 */
const EXPECTED_DELTA = {
  extend_loan: ["collateral_mint", "price_history", "authority"],
  liquidate_loan: ["loan_token_vault"],
  convert_collateral_slice: ["price_history", "pool"],
};

for (const [ixName, expected] of Object.entries(EXPECTED_DELTA)) {
  const a = accounts(v4, ixName);
  const b = accounts(v41, ixName);
  if (!a || !b) { fail(`${ixName}: missing from one of the IDLs`); continue; }
  const added = b.filter((n) => !a.includes(n));
  const removed = a.filter((n) => !b.includes(n));
  if (removed.length) {
    fail(`${ixName}: V4.1 REMOVED account(s) ${removed.join(", ")} — call sites will pass a key the program no longer wants`);
  }
  if (JSON.stringify(added) !== JSON.stringify(expected)) {
    fail(`${ixName}: account delta is [${added.join(", ")}], expected [${expected.join(", ")}] — a call site needs updating, or this guard does`);
  } else {
    console.log(`  ${ixName}: +${added.join(", ")}`);
  }
}

/**
 * The call sites must actually supply the REQUIRED additions. `authority` on
 * extend_loan is optional by design (a provably-healthy loan self-extends), so
 * it is deliberately excluded from this check.
 */
const REQUIRED_AT_CALLSITE = {
  "src/services/loans.js": ["collateralMint", "priceHistory"],
  "src/api/agent-manage.js": ["collateralMint", "priceHistory"],
  "src/services/keeper.js": ["loanTokenVault"],
};

for (const [file, keys] of Object.entries(REQUIRED_AT_CALLSITE)) {
  const src = readFileSync(path.join(root, file), "utf8");
  if (!src.includes("PROGRAM_ID_V4_1")) {
    fail(`${file}: builds a V4-family instruction but never checks PROGRAM_ID_V4_1`);
    continue;
  }
  for (const k of keys) {
    // Must be ASSIGNED into the accounts object, not merely mentioned. A bare
    // substring match passes on unrelated identifiers (`loanTokenVaultPda`),
    // which made an earlier version of this guard unable to fail.
    const assigned = new RegExp(`\\.\\s*${k}\\s*=|\\b${k}\\s*:`).test(src);
    if (!assigned) fail(`${file}: never assigns '${k}' into the V4.1 account list`);
  }
}

/**
 * convert_collateral_slice is NOT built in this repo (the engine assembles it).
 * Recorded so nobody hunts for a call site that doesn't exist — and so this
 * fails loudly if one is ever added without the V4.1 accounts.
 */
const buildsConvert = ["src/services", "src/api"].some((d) => {
  try {
    return readFileSync(path.join(root, d, "keeper.js"), "utf8").includes(".convertCollateralSlice(");
  } catch { return false; }
});
if (buildsConvert) {
  fail("a call site now builds convertCollateralSlice — it needs price_history + pool for V4.1");
}

if (failed) {
  console.error(`\n[v41-accounts] ${failed} problem(s) — a V4.1 instruction would fail with AccountNotEnoughKeys.`);
  process.exit(1);
}
console.log("[v41-accounts] OK — IDL deltas match what the call sites build.");
