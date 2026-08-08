#!/usr/bin/env node
/**
 * Guard: V4.1 accounts must never be decoded with the V4 IDL.
 *
 * V4.1 deploys at a NEW program id and its account layouts diverge from V4 —
 * Loan appends accrued_pool_fees plus five borrower-armed trigger fields, and
 * LendingPool appends pending_fees.
 *
 * Decoding a V4.1 account with the V4 IDL DOES NOT THROW. Anchor reads every
 * field past the divergence at the wrong offset, so the failure looks like
 * plausible-but-wrong collateral and debt numbers — which feed repay math.
 * That is funds-adjacent, not cosmetic, and it is silent.
 *
 * This is the same class of bug the repo already hit twice (V2 fee_wallet
 * 2026-06-12, V3 Loan size 2026-06-14), which is why the routing exists at all.
 *
 * Dependency-free on purpose, like the repo's other guards: it reads the IDL
 * JSON directly and checks the routing order in source, so it runs in CI with
 * no install step.
 *
 * Usage: node scripts/check-idl-routing.mjs   ·   exit 0 clean, 1 regressed
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const idlDir = path.join(dir, "..", "src", "solana", "idl");
const v4 = JSON.parse(readFileSync(path.join(idlDir, "magpie-v4.json"), "utf8"));
const v41 = JSON.parse(readFileSync(path.join(idlDir, "magpie-v4-1.json"), "utf8"));
const programSrc = readFileSync(path.join(dir, "..", "src", "solana", "program.js"), "utf8");

let failed = 0;
const fail = (msg) => { failed++; console.error(`✕ ${msg}`); };

const fields = (idl, name) => {
  const t = (idl.types || []).find((x) => x.name === name);
  return t ? t.type.fields.map((f) => f.name) : null;
};

// 1. The hazard must actually exist — if the layouts ever converge, this guard
//    is obsolete and should be reconsidered rather than silently passing.
for (const acct of ["Loan", "LendingPool"]) {
  const a = fields(v4, acct);
  const b = fields(v41, acct);
  if (!a || !b) { fail(`${acct} missing from one of the IDLs`); continue; }
  if (JSON.stringify(a) === JSON.stringify(b)) {
    fail(`${acct} layouts are identical across V4 and V4.1 — routing may no longer be needed; re-check before deleting it`);
    continue;
  }
  const diverge = a.findIndex((f, i) => b[i] !== f);
  const at = diverge === -1 ? a.length : diverge;
  console.log(`  ${acct}: layouts diverge at field index ${at} (V4 has ${a.length} fields, V4.1 has ${b.length}) — wrong IDL = wrong values, silently`);
}

// 2. They must be genuinely different interfaces.
const ix = (idl) => new Set(idl.instructions.map((i) => i.name));
const only41 = [...ix(v41)].filter((n) => !ix(v4).has(n));
if (!only41.includes("arm_conversion")) {
  fail("V4.1 IDL has no arm_conversion — wrong file committed?");
}
if (ix(v4).has("arm_conversion")) {
  fail("the DEPLOYED V4 IDL contains arm_conversion — it must not; that instruction is V4.1-only");
}

// 3. The V4.1 branch must be checked BEFORE V4 in every IDL-selection chain.
//    Appending it after V4 would still compile and still look right in review,
//    but V4 would win for a V4.1 program id and we'd be back to silent
//    mis-deserialization.
const chains = [...programSrc.matchAll(/let useIdl = idl;([\s\S]*?)return new Program/g)];
if (chains.length === 0) fail("could not find any IDL-selection chain in program.js");
chains.forEach((m, i) => {
  const body = m[1];
  const p41 = body.indexOf("PROGRAM_ID_V4_1");
  const p4 = body.indexOf("PROGRAM_ID_V4 ");
  if (p41 === -1) fail(`IDL-selection chain #${i + 1} does not handle PROGRAM_ID_V4_1`);
  else if (p4 !== -1 && p41 > p4) {
    fail(`IDL-selection chain #${i + 1} checks V4 before V4.1 — a V4.1 program id would decode with the V4 IDL`);
  }
});

// 4. The shipped V4.1 IDL must not carry a real address; the id comes from env.
if (v41.address !== "11111111111111111111111111111111") {
  fail(`V4.1 IDL address is ${v41.address} — it must stay the 111…111 placeholder so it can't be aimed at a live program; the real id comes from PROGRAM_ID_V4_1`);
}

if (failed) {
  console.error(`\n[idl-routing] ${failed} check(s) failed — V4.1 accounts could be decoded with the V4 layout.`);
  process.exit(1);
}
console.log(`[idl-routing] OK — V4.1 routes to its own IDL in ${chains.length} selection chain(s).`);
