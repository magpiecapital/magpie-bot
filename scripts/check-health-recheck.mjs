#!/usr/bin/env node
/**
 * Guard: token-health must RE-CHECK before ANY delist.
 *
 * 2026-08-25: DexScreener under per-IP rate limiting returned PARTIAL pair
 * objects — missing marketCap/fdv/liquidity/volume coerce to 0, which is
 * indistinguishable from a collapse. Seven healthy same-day promotions
 * (HAMI, HOBBES, CHARLIE, MEMEFI, GOOSE, GUNICORN, PMV) were instantly
 * delisted. The fix: every delist branch performs one targeted single-mint
 * refetch and only a CONFIRMING fresh read may delist; marketCap === 0 is
 * treated as missing data, never as a $0 collapse.
 *
 * These pins fail if any branch loses its guard.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src/services/token-health.js"), "utf8");

let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.error(`✕ ${name}`); } else console.log(`✓ ${name}`); };

check("recheckMarket helper exists", /async function recheckMarket\(mint\)/.test(src));
check("recheck does a targeted single-mint refetch", src.includes("getMarketData([mint])"));

// mcap floor: a zero reading is MISSING DATA, not a collapse
check("mcap floor requires a real (nonzero) reading", src.includes("market.marketCap > 0 && market.marketCap < MCAP_FLOOR"));
check("mcap delist is recheck-confirmed", /marketCap > 0 && market\.marketCap < MCAP_FLOOR[\s\S]{0,400}recheckMarket\(mint\)/.test(src));

// dead-token (strikes) delist: a live re-read clears strikes instead
check("2-strike dead delist is recheck-confirmed", src.includes("confirmed by targeted re-check"));
check("live re-read on strike path clears strikes", /recheckMarket\(mint\);\s*if \(fresh\) \{[\s\S]{0,400}health_strikes = 0/.test(src));

// rug / liquidity / volume branches all recheck before acting
check("rug delist is recheck-confirmed", /freshRug && !\(freshRug\.liquidity/.test(src));
check("liquidity-floor delist is recheck-confirmed", /freshLiq && !\(freshLiq\.liquidity/.test(src));
check("volume-floor delist is recheck-confirmed", /freshVol && !\(freshVol\.volume24h/.test(src));

// the >50% batch-outage skip must also survive
check("whole-cycle API-outage skip still present", src.includes("API OUTAGE DETECTED"));

// watchlist degraded-strikes delist (the branch that actually fired) rechecks too
check("watchlist final-strike delist is recheck-confirmed", /freshDeg = await recheckMarket\(mint\)/.test(src));
check("watchlist recheck clears strikes on healthy fresh read", /stillDegraded[\s\S]{0,500}health_strikes = 0/.test(src));

// every delistToken CALL in the cycle is accounted for: dead-strike, mcap,
// rug, liquidity, volume, watchlist (all Dex-sourced + recheck-guarded) and
// mint-authority (fires only on a POSITIVE fresh on-chain read — fail-safe).
const calls = (src.match(/await delistToken\(/g) || []).length;
check(`exactly 7 delist call sites (got ${calls})`, calls === 7);

if (failed) { console.error(`\n[health-recheck] ${failed} check(s) failed.`); process.exit(1); }
console.log("\n[health-recheck] OK — no delist without a confirming fresh read; zero readings are missing data, not collapses.");
