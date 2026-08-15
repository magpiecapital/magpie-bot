#!/usr/bin/env node
/**
 * Regression guard for the farm-guard pure classifier (no DB needed).
 * Run: npm run check:farm-guard
 */
import { classifyFarmSignals, normalizeName } from "../src/services/farm-guard.js";

let failures = 0;
function expect(label, cond) {
  if (cond) { console.log(`  ok  ${label}`); } else { failures++; console.error(`FAIL  ${label}`); }
}

// normalizeName
expect("normalize strips punctuation/case", normalizeName("United  Oil Trust-Fund!") === "unitedoiltrustfund");
expect("normalize handles garbage", normalizeName(null) === "" && normalizeName(42) === "");

// Hard signatures
expect("name clone is hard", classifyFarmSignals({ nameCloneCount: 1, normalizedName: "unitedoiltrustfund" }).hard.length === 1);
expect("image reuse is hard", classifyFarmSignals({ imageReuseCount: 2 }).hard.length === 1);
expect("creator cluster ≥2 is hard", classifyFarmSignals({ creatorScreens7d: 2 }).hard.length === 1);
expect("creator single prior is NOT hard", classifyFarmSignals({ creatorScreens7d: 1 }).hard.length === 0);

// Soft signals
{
  const r = classifyFarmSignals({ autoApprovals24h: 10 });
  expect("approval wave at cap is soft", r.soft.length === 1 && r.hard.length === 0);
}
{
  const r = classifyFarmSignals({ volume24h: 3_000_000, liquidity: 100_000 });
  expect("wash-trade shape is soft", r.soft.length === 1 && r.hard.length === 0);
}
expect("healthy vol/liq is clean", classifyFarmSignals({ volume24h: 500_000, liquidity: 100_000 }).soft.length === 0);

// Unevaluated context never signals
{
  const r = classifyFarmSignals({});
  expect("empty ctx is clean", r.hard.length === 0 && r.soft.length === 0);
}
{
  const r = classifyFarmSignals({ nameCloneCount: NaN, creatorScreens7d: undefined, autoApprovals24h: null, volume24h: NaN, liquidity: 0 });
  expect("garbage ctx is clean (skip, not signal)", r.hard.length === 0 && r.soft.length === 0);
}

// Compound: farm wave — every signature at once
{
  const r = classifyFarmSignals({
    nameCloneCount: 4, imageReuseCount: 1, creatorScreens7d: 4,
    autoApprovals24h: 15, volume24h: 5_000_000, liquidity: 150_000,
    normalizedName: "unitedoiltrustfund",
  });
  expect("full farm signature: 3 hard + 2 soft", r.hard.length === 3 && r.soft.length === 2);
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nfarm-guard: all checks passed");
