#!/usr/bin/env node
/**
 * Guard: holder reward carry-forward accounting.
 *
 * WHY. Distribution #9 (2026-08-13) wrote off 319 holders whose rewards Solana
 * could not deliver — a transfer would have left their empty account below the
 * rent-exempt minimum. Writing off means they never receive it AND the same
 * wallets fail again every cycle, because the amount is always too small.
 * Migration 102 accumulates it instead, until it clears the floor or their
 * wallet gets funded.
 *
 * THE INVARIANT THIS PROTECTS. A carried balance is NOT new money. The pool was
 * already decremented for those lamports when they were first allocated, and
 * the SOL has been sitting in CHCAM ever since. So carry is added to the
 * holder's `reward_lamports` but MUST NOT be added to `allocatedSum`, which is
 * what decrements `magpie_holder_pool`. Getting that wrong charges the pool
 * twice for the same SOL and silently over-draws it every cycle.
 *
 * The second failure mode is carry that never clears: if a successful payout
 * doesn't zero it, the holder is paid the same lamports again next cycle.
 *
 * Run: npm run check:holder-carryforward
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, "../src/services/magpie-holder-rewards.js"), "utf8");
const mark = readFileSync(path.join(dir, "distributions/mark-unpayable-rent-exempt.mjs"), "utf8");

let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { failures++; console.error(`  ❌ ${n}${d ? ` — ${d}` : ""}`); };
const expect = (n, a, w) => (a === w ? ok(n) : bad(n, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(w)}`));

console.log("\n== the allocation math (modelled exactly as shipped) ==");
{
  // Mirrors the loop in snapshotAndDistribute.
  const allocate = (pool, holders, carry) => {
    let allocatedSum = 0n;
    const rows = [];
    for (const h of holders) {
      const base = (pool * h.balance) / holders.reduce((a, x) => a + x.balance, 0n);
      const owed = carry.get(h.owner) || 0n;
      const reward = base + owed;
      if (reward <= 0n) continue;
      rows.push({ owner: h.owner, reward });
      allocatedSum += base; // pool portion ONLY
    }
    return { rows, allocatedSum };
  };

  const holders = [
    { owner: "A", balance: 50n },
    { owner: "B", balance: 50n },
  ];
  const pool = 1000n;

  const noCarry = allocate(pool, holders, new Map());
  expect("without carry, allocatedSum equals the pool", noCarry.allocatedSum, 1000n);

  const withCarry = allocate(pool, holders, new Map([["A", 777n]]));
  expect("carry does NOT inflate allocatedSum (pool charged once)", withCarry.allocatedSum, 1000n);
  expect("carried holder's reward includes the carry", withCarry.rows.find((r) => r.owner === "A").reward, 500n + 777n);
  expect("uncarried holder is unaffected", withCarry.rows.find((r) => r.owner === "B").reward, 500n);

  // The whole point: someone with no new share still gets paid what they are owed.
  const dust = allocate(0n, holders, new Map([["A", 900n]]));
  expect("zero pool + carry still produces a row", dust.rows.length, 1);
  expect("  ...for the carried holder only", dust.rows[0].owner, "A");
  expect("  ...and charges the pool nothing", dust.allocatedSum, 0n);
}

console.log("\n== accumulation must ADD UP, never compound ==");
{
  // capture folds carry INTO reward_lamports, so writing reward_lamports back
  // as the new carry accumulates correctly. Compounding would mean the holder's
  // owed balance grows without any new allocation.
  let carry = 100n;
  for (let cycle = 0; cycle < 3; cycle++) {
    const base = 50n;             // their share that cycle
    const reward = base + carry;  // what capture writes
    carry = reward;               // written off again → becomes the new carry
  }
  expect("3 cycles of 50 on top of 100 = 250", carry, 250n);
}

console.log("\n== source: the accounting rule is actually in the code ==");
expect("allocatedSum adds base, not reward", /allocatedSum \+= base;/.test(src), true);
expect("  ...and never adds the carried amount", /allocatedSum \+= (reward|owed)\b/.test(src), false);
expect("reward = base + carried", /const reward = base \+ owed;/.test(src), true);
expect("carry is read from the carryforward table", /FROM magpie_holder_carryforward WHERE lamports > 0/.test(src), true);
expect("a carry-table failure cannot block a distribution", /carryforward read failed \(continuing without\)/.test(src), true);

console.log("\n== source: carry is cleared when actually paid ==");
{
  const clears = [...src.matchAll(/UPDATE magpie_holder_carryforward\s+SET lamports = 0/g)].length;
  expect("both payout paths clear it", clears, 2);
  // The claim path selects only (id, reward_lamports) — mapping rows for a
  // wallet_address there yields [undefined], silently clears nothing, and the
  // holder is paid the same lamports again next cycle.
  expect("claim path clears by its walletAddress param", /wallet_address = \$1 AND lamports > 0/.test(src), true);
  expect("batch path clears by the batch's wallet_address", /wallet_address = ANY\(\$1::text\[\]\) AND lamports > 0/.test(src), true);
}

console.log("\n== source: write-off records the carry ==");
expect("marking script inserts into carryforward", /INSERT INTO magpie_holder_carryforward/.test(mark), true);
expect("  ...accumulating via ON CONFLICT", /ON CONFLICT \(wallet_address\) DO UPDATE/.test(mark), true);
expect("  ...and counts cycles waited", /cycles     = magpie_holder_carryforward\.cycles \+ 1/.test(mark), true);

console.log(
  failures === 0 ? "\n✅ carry-forward guard passed\n" : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
