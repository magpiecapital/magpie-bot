#!/usr/bin/env node
/**
 * Guard for the Jupiter coalescing price client + its price.js wiring.
 *
 * 2026-08-25: the paid Jupiter Price-v3 key allows 10 requests per FIXED
 * 10-second window (measured live), but the legacy budget assumed 10/sec
 * with a 30-token burst. Every attestor tick blew the window instantly and
 * one batch 429 amplified into a 75-125 per-mint fallback storm riding the
 * free lite tier. The client fixes the model; these checks pin the load-
 * bearing behaviors so they can't silently regress:
 *
 *   1. COALESCING     N per-mint lookups → ceil(N/maxIds) HTTP calls.
 *   2. OMISSION LOUD  a 200 that's missing a mint REJECTS that mint's
 *                     promise (jupiter-batch-silent-omission pitfall —
 *                     SPCX went 11h unattested from a silent skip), is
 *                     NON-transient (falls to Dex immediately), and is
 *                     negative-cached for bulk callers only.
 *   3. 429 = WINDOW   a paid 429 retries the chunk ONCE on the lite tier
 *                     (separate quota) and cools the paid tier down; it
 *                     never bumps per-mint backoff.
 *   4. RESERVE        bulk sweeps can never spend the last
 *                     JUPITER_PAID_INTERACTIVE_RESERVE paid units — a
 *                     borrow-path lookup always has budget.
 *   5. SOL CACHE      SOL/USD rides along on every call and is cached, so
 *                     derived in-SOL prices never double-spend budget.
 *
 * Functional tests run against the real module with mocked HTTP + tiny
 * env-configured windows (set BEFORE import). No DB, no network.
 */

// ── env BEFORE import (module reads env at load) ──────────────────────────
process.env.JUPITER_API_KEY = "test-key-not-real";
// Pin the paid URL: a developer-machine .env may set JUPITER_API_URL (the
// module loads dotenv), which would silently repoint the "paid" tier and
// break the tier-classification assertions below.
process.env.JUPITER_API_URL = "https://api.jup.ag/price/v3";
process.env.JUPITER_PAID_WINDOW_LIMIT = "4";
process.env.JUPITER_PAID_WINDOW_MS = "500";
process.env.JUPITER_PAID_INTERACTIVE_RESERVE = "2";
process.env.JUPITER_LITE_WINDOW_LIMIT = "2";
process.env.JUPITER_LITE_WINDOW_MS = "500";
process.env.JUP_COALESCE_MS = "10";
process.env.JUP_MAX_IDS_PER_CALL = "5";
process.env.JUP_SOL_USD_TTL_MS = "200";
process.env.JUP_OMITTED_NEG_TTL_MS = "60000";
process.env.JUP_MAX_WAIT_INTERACTIVE_MS = "150";
process.env.JUP_MAX_WAIT_BULK_MS = "250";
delete process.env.JUP_COALESCE_DISABLED;

const {
  requestUsdPrice,
  isClientEnabled,
  clientAvailability,
  getJupiterClientStats,
  __setTestDeps,
  __setTestConfig,
  __resetForTests,
  SOL_MINT,
} = await import("../src/services/jupiter-price-client.js");

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error(`✕ ${name}`); } else console.log(`✓ ${name}`);
};

// ── HTTP mock ─────────────────────────────────────────────────────────────
const calls = []; // { url, ids, tier }
let mockBehavior = null; // (url, ids) => { data } | throws
function tierOf(url) { return url.includes("lite-api") ? "lite" : "paid"; }
function okData(ids, { omit = [] } = {}) {
  const data = {};
  for (const id of ids) {
    if (omit.includes(id)) continue;
    data[id] = { usdPrice: id === SOL_MINT ? 100 : 2.5 };
  }
  return data;
}
function err429(headers = {}) {
  const e = new Error("Request failed with status code 429");
  e.response = { status: 429, headers };
  return e;
}
__setTestDeps({
  get: async (url, opts) => {
    const ids = String(opts.params.ids).split(",");
    calls.push({ url, ids, tier: tierOf(url) });
    return mockBehavior(url, ids);
  },
});
function reset(behavior) {
  __resetForTests();
  calls.length = 0;
  mockBehavior = behavior;
}
const settleAll = (ps) => Promise.allSettled(ps);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check("client enabled by default", isClientEnabled() === true);

// ── 1. Coalescing: 12 bulk mints → 3 HTTP calls (paid, paid, lite) ────────
{
  reset((url, ids) => ({ data: okData(ids), headers: {} }));
  const mints = Array.from({ length: 12 }, (_, i) => `MINT${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
  const results = await settleAll(mints.map((m) => requestUsdPrice(m, { cls: "bulk" })));
  check("coalesce: all 12 lookups resolve", results.every((r) => r.status === "fulfilled" && r.value === 2.5));
  check(`coalesce: 12 mints → 3 HTTP calls (got ${calls.length})`, calls.length === 3);
  check("coalesce: chunk size ≤ maxIds + SOL rider", calls.every((c) => c.ids.length <= 6));
  check("coalesce: SOL rides along on every call", calls.every((c) => c.ids.includes(SOL_MINT)));
  const tiers = calls.map((c) => c.tier).join(",");
  check(`reserve: bulk spends paid only to the reserve floor, then lite (got ${tiers})`, tiers === "paid,paid,lite");
  // 5. SOL cache: an immediate SOL lookup is served without HTTP.
  const before = calls.length;
  const sol = await requestUsdPrice(SOL_MINT, { cls: "bulk" });
  check("sol-cache: SOL/USD served from cache, no extra HTTP", sol === 100 && calls.length === before);
}

// ── 2. Omission: loud, non-transient, negative-cached for bulk only ───────
{
  reset((url, ids) => ({ data: okData(ids, { omit: ids.filter((i) => i.startsWith("OMITTED")) }), headers: {} }));
  const omitted = "OMITTEDMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const [r] = await settleAll([requestUsdPrice(omitted, { cls: "bulk" })]);
  check("omission: promise REJECTS (never silently resolves)", r.status === "rejected");
  check("omission: flagged .jupNoCoverage", r.reason?.jupNoCoverage === true);
  check("omission: NON-transient contract (no .code, no .response)", !r.reason?.code && !r.reason?.response);
  const httpBefore = calls.length;
  const [r2] = await settleAll([requestUsdPrice(omitted, { cls: "bulk" })]);
  check("omission: bulk re-lookup hits negative cache, zero HTTP", r2.status === "rejected" && calls.length === httpBefore);
  const [r3] = await settleAll([requestUsdPrice(omitted, { cls: "interactive" })]);
  check("omission: interactive lookup bypasses negative cache (live retry)", calls.length === httpBefore + 1 && r3.status === "rejected");
}

// ── 3. Paid 429 → one lite retry for the chunk + paid cooldown ────────────
{
  reset((url, ids) => {
    if (tierOf(url) === "paid") throw err429();
    return { data: okData(ids), headers: {} };
  });
  const m = "STORMMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const [r] = await settleAll([requestUsdPrice(m, { cls: "interactive" })]);
  check("429: chunk rescued by ONE lite retry", r.status === "fulfilled" && r.value === 2.5);
  const paidCalls = calls.filter((c) => c.tier === "paid").length;
  const liteCalls = calls.filter((c) => c.tier === "lite").length;
  check(`429: exactly one paid attempt + one lite retry (got p=${paidCalls} l=${liteCalls})`, paidCalls === 1 && liteCalls === 1);
  // Cooldown: the next request must not touch the paid tier at all.
  const [r4] = await settleAll([requestUsdPrice("AFTERMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "interactive" })]);
  const paidAfter = calls.filter((c) => c.tier === "paid").length;
  check("429: paid tier in cooldown — next lookup goes straight to lite", r4.status === "fulfilled" && paidAfter === 1);
}

// ── both tiers 429 → transient rejection (falls to caller's Dex path) ─────
{
  reset(() => { throw err429(); });
  const [r] = await settleAll([requestUsdPrice("DOOMEDMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "bulk" })]);
  check("both-tiers-429: rejects transient (.code, no .response)", r.status === "rejected" && r.reason?.code === "JUP_RATE_LIMITED" && !r.reason?.response);
}

// ── 4. Interactive reserve: last paid units unavailable to bulk ───────────
{
  reset((url, ids) => ({ data: okData(ids), headers: {} }));
  // Two sequential bulk lookups spend paid to the bulk floor (limit 4, reserve 2).
  await settleAll([requestUsdPrice("B1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "bulk" })]);
  await sleep(15);
  await settleAll([requestUsdPrice("B2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "bulk" })]);
  await sleep(15);
  // Next two bulk lookups must overflow to lite.
  await settleAll([requestUsdPrice("B3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "bulk" })]);
  await sleep(15);
  await settleAll([requestUsdPrice("B4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "bulk" })]);
  await sleep(15);
  const paidSoFar = calls.filter((c) => c.tier === "paid").length;
  const liteSoFar = calls.filter((c) => c.tier === "lite").length;
  check(`reserve: bulk stopped at floor (paid=${paidSoFar}, lite=${liteSoFar})`, paidSoFar === 2 && liteSoFar === 2);
  // An interactive lookup still gets the reserved paid units.
  const [ri] = await settleAll([requestUsdPrice("I1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "interactive" })]);
  const paidAfter = calls.filter((c) => c.tier === "paid").length;
  check("reserve: interactive lookup spends a RESERVED paid unit", ri.status === "fulfilled" && paidAfter === 3);
}

// ── preemption: a waiting bulk chunk never delays an interactive lookup ───
{
  reset((url, ids) => ({ data: okData(ids), headers: {} }));
  __setTestConfig({ maxWaitBulkMs: 2_000 }); // let bulk WAIT (not reject) on exhaustion
  // Exhaust the bulk allowance on both tiers (2 paid to floor + 2 lite).
  for (const b of ["P1", "P2", "L1", "L2"]) {
    await settleAll([requestUsdPrice(`${b}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, { cls: "bulk" })]);
    await sleep(15);
  }
  // This bulk lookup has no budget → it arms a budget-wait timer (~500ms).
  const bulkPending = requestUsdPrice("WAITERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "bulk" });
  bulkPending.catch(() => {});
  await sleep(50);
  // An interactive lookup must preempt that wait and spend a RESERVED paid
  // unit immediately — not sit behind the bulk timer.
  const t0 = Date.now();
  const [ri] = await settleAll([requestUsdPrice("URGENTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "interactive" })]);
  const elapsed = Date.now() - t0;
  check(`preempt: interactive served in ${elapsed}ms despite waiting bulk chunk`, ri.status === "fulfilled" && elapsed < 300);
  await settleAll([bulkPending]); // drain — resolves after window rollover
  __setTestConfig({ maxWaitBulkMs: 250 });
}

// ── header sync: server says window is spent → client believes it ─────────
{
  reset((url, ids) => ({
    data: okData(ids),
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 1) },
  }));
  await settleAll([requestUsdPrice("H1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "interactive" })]);
  await sleep(15);
  await settleAll([requestUsdPrice("H2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { cls: "interactive" })]);
  const paid = calls.filter((c) => c.tier === "paid").length;
  const lite = calls.filter((c) => c.tier === "lite").length;
  check(`header-sync: remaining=0 diverts next call to lite (paid=${paid}, lite=${lite})`, paid === 1 && lite === 1);
}

check("stats: exposed for v4-status", typeof getJupiterClientStats().paidCalls === "number");
check("availability: exposed for jupiter-budget routing", typeof clientAvailability().available === "boolean");

// ── static pins: the wiring can't silently detach ─────────────────────────
const priceSrc = src("src/services/price.js");
check("price.js: getPricesInSolBatch has the client-mode branch", /getPricesInSolBatch[\s\S]{0,900}jupClientEnabled\(\)/.test(priceSrc));
check("price.js: batch omits (never null/0) — fulfilled+positive filter", priceSrc.includes('settled[i].status === "fulfilled" && settled[i].value > 0'));
check("price.js: USD cross-source rescue uses the USD lite helper (SOL-vs-USD unit bug)", priceSrc.includes("jup = await jupiterLitePriceInUsd(mint);"));
check("price.js: USD lite helper exists", priceSrc.includes("async function jupiterLitePriceInUsd(mint)"));
check("price.js: SOL cross-source rescue still uses the SOL lite helper", priceSrc.includes("jup = await jupiterLitePriceInSol(mint);"));
check("price.js: getPriceInSol threads cls to Jupiter", priceSrc.includes("jupiterPriceInSol(mint, { cls: opts.cls })"));
check("price.js: client-mode 429 records global metric, never per-mint backoff", priceSrc.includes("recordJupiter429Global()"));

const budgetSrc = src("src/services/jupiter-budget.js");
check("jupiter-budget: tryAcquireJupiterToken delegates to client availability", /tryAcquireJupiterToken[\s\S]{0,700}clientAvailability\(\)\.available/.test(budgetSrc));
check("jupiter-budget: recordJupiter429Global exists and does NOT bump backoff", /export function recordJupiter429Global\(\) \{\s*record\("jup_429"\);\s*\}/.test(budgetSrc));

const attestorSrc = src("src/services/price-attestor.js");
check("attestor: batch-failure fallback loop is cls:bulk", (attestorSrc.match(/getPriceInSol\(t\.mint, \{ cls: "bulk" \}\)/g) || []).length === 2);
check("attestor: per-mint backfill for batch omissions still present", attestorSrc.includes("per-mint backfill"));

const readinessSrc = src("src/services/v4-feed-readiness.js");
check("v4-readiness: backfill loop is cls:bulk", readinessSrc.includes('getPriceInSol(m.mint, { cls: "bulk" })'));

const clientSrc = src("src/services/jupiter-price-client.js");
check("client: kill switch JUP_COALESCE_DISABLED present", clientSrc.includes('JUP_COALESCE_DISABLED'));
check("client: omission negative cache is BULK-ONLY", /cls === "bulk"[\s\S]{0,200}omittedAt\.get\(mint\)/.test(clientSrc));
check("client: paid window defaults match the measured 10-per-10s limit", clientSrc.includes("JUPITER_PAID_WINDOW_LIMIT) || 10") && clientSrc.includes("JUPITER_PAID_WINDOW_MS) || 10_000"));

if (failed) { console.error(`\n[jup-client] ${failed} check(s) failed.`); process.exit(1); }
console.log("\n[jup-client] OK — coalescing, loud omissions, window-accurate budgets, interactive reserve all hold.");
process.exit(0);
