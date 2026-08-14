#!/usr/bin/env node
/**
 * check:sim-compat — guard the simulateTransaction overload fix.
 *
 * The bug (bitten three times: fee-wallet-sweeper 2026-06-19, cosign-borrow
 * drain guard + agent-repay pre-sim, surfaced 2026-08-14): passing a config
 * OBJECT to `simulateTransaction` with a LEGACY Transaction makes web3.js
 * throw `Invalid arguments` client-side. The shared fix is
 * src/solana/simulate-compat.js's toVersionedForSim().
 *
 * All checks are offline — the "Invalid arguments" throw happens before any
 * network I/O, and the fixed path is verified to get PAST that throw (a
 * network error against the loopback URL is the success signal).
 */
import { strict as assert } from "node:assert";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { toVersionedForSim } from "../src/solana/simulate-compat.js";

const conn = new Connection("http://127.0.0.1:1"); // unroutable — no sim ever lands
const kp = Keypair.generate();

function makeLegacyTx() {
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = "11111111111111111111111111111111";
  return tx;
}

const CONFIG = { sigVerify: false, commitment: "confirmed" };
let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. The bug is real: legacy tx + config throws "Invalid arguments" locally.
let bugThrow = null;
try {
  await conn.simulateTransaction(makeLegacyTx(), CONFIG);
} catch (e) {
  bugThrow = e;
}
check(
  "legacy tx + config object throws Invalid arguments (the bug this guards)",
  bugThrow?.message === "Invalid arguments",
  `got: ${bugThrow?.message}`,
);

// 2. toVersionedForSim returns a VersionedTransaction for legacy input.
const promoted = toVersionedForSim(makeLegacyTx());
check("legacy tx promotes to VersionedTransaction", promoted instanceof VersionedTransaction);

// 3. A VersionedTransaction passes through unchanged (no double-wrap).
const already = toVersionedForSim(promoted);
check("versioned tx passes through unchanged", already === promoted);

// 4. The promoted tx gets PAST the overload check — the failure becomes a
//    network error against the unroutable URL, never "Invalid arguments".
let fixedThrow = null;
try {
  await conn.simulateTransaction(promoted, CONFIG);
} catch (e) {
  fixedThrow = e;
}
check(
  "promoted tx + config reaches the network layer (overload accepted)",
  fixedThrow !== null && fixedThrow.message !== "Invalid arguments",
  `got: ${fixedThrow?.message}`,
);

// 5. Signatures are carried over so the wire shape survives promotion.
const signedLegacy = makeLegacyTx();
signedLegacy.sign(kp);
const promotedSigned = toVersionedForSim(signedLegacy);
check(
  "existing signatures carry over on promotion",
  Buffer.compare(promotedSigned.signatures[0], signedLegacy.signatures[0].signature) === 0,
);

// 6. Both production call sites import the helper (regression tripwire).
const { readFileSync } = await import("node:fs");
for (const f of ["src/api/cosign-borrow.js", "src/api/agent-repay.js"]) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  check(`${f} uses toVersionedForSim`, src.includes("toVersionedForSim("));
}

if (failures > 0) {
  console.error(`\ncheck:sim-compat FAILED — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncheck:sim-compat OK");
