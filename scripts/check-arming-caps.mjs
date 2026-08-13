#!/usr/bin/env node
/**
 * Guard for the V4.1 arming caps (Sec3 Q-04).
 *
 * The program enforces TWO limits on a borrower-armed conversion:
 *   max_slice_bps — the most a SINGLE fire may take
 *   total_bps     — the most ALL fires may take under one arming
 *
 * If the bot derives these wrongly the failure is nasty and quiet: a laddered
 * exit arms successfully, fires its first leg, and every later leg is refused
 * on-chain. The user sees a ladder that just stops working partway down.
 *
 * These cases pin the derivation. Zero dependencies, same pattern as the
 * repo's other guard scripts.
 *
 * Usage: node scripts/check-arming-caps.mjs   ·   exit 0 clean, 1 regressed
 */
import { deriveArmingCaps } from "../src/solana/arming-caps.js";

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) {
    failed++;
    console.error(`✕ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// The 70/20/10 take-profit ladder the product actually offers.
{
  const { maxSliceBps, totalBps } = deriveArmingCaps([
    { slicePct: 70 }, { slicePct: 20 }, { slicePct: 10 },
  ]);
  ok("ladder per-fire cap is the LARGEST leg", maxSliceBps === 7000, `got ${maxSliceBps}`);
  ok("ladder total is the SUM of legs", totalBps === 10000, `got ${totalBps}`);
  // The regression this guard exists for: if total collapsed onto the per-fire
  // cap, leg 2 would be refused on-chain.
  ok("total must exceed the largest leg for a multi-leg ladder", totalBps > maxSliceBps);
}

// A simple one-leg take-profit or stop-loss.
{
  const { maxSliceBps, totalBps } = deriveArmingCaps([{ slicePct: 50 }]);
  ok("single leg: per-fire == total", maxSliceBps === 5000 && totalBps === 5000,
     `got ${maxSliceBps}/${totalBps}`);
}

// Partial ladder that doesn't sell the whole position.
{
  const { maxSliceBps, totalBps } = deriveArmingCaps([{ slicePct: 25 }, { slicePct: 15 }]);
  ok("partial ladder totals only what was asked for", totalBps === 4000, `got ${totalBps}`);
  ok("partial ladder per-fire is the larger leg", maxSliceBps === 2500, `got ${maxSliceBps}`);
}

// Fractional percentages must not silently shrink a leg.
{
  const { totalBps } = deriveArmingCaps([{ slicePct: 33.33 }, { slicePct: 33.33 }]);
  ok("fractional legs round rather than truncate", totalBps === 6666, `got ${totalBps}`);
}

// Over-100% must be refused in the bot, with a readable message.
{
  let threw = false;
  try { deriveArmingCaps([{ slicePct: 70 }, { slicePct: 40 }]); } catch { threw = true; }
  ok("legs summing over 100% are refused", threw);
}

// Garbage in must not produce a silently-zero authorization.
for (const bad of [[], null, [{ slicePct: 0 }], [{ slicePct: -5 }], [{ slicePct: "abc" }]]) {
  let threw = false;
  try { deriveArmingCaps(bad); } catch { threw = true; }
  ok(`invalid spec refused: ${JSON.stringify(bad)}`, threw);
}

if (failed) {
  console.error(`\n[arming-caps] ${failed} check(s) failed — laddered exits would break on-chain.`);
  process.exit(1);
}
console.log("[arming-caps] OK — per-fire and total caps derive correctly.");
