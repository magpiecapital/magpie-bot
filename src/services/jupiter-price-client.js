/**
 * jupiter-price-client.js — unified, window-accurate, coalescing client for
 * Jupiter Price v3 (paid api.jup.ag + free lite-api.jup.ag).
 *
 * Why this exists (2026-08-25). The paid Price-v3 key allows 10 requests per
 * FIXED 10-SECOND window (measured live: 10 straight 200s sharing one
 * x-ratelimit-reset epoch, the 11th 429s, full recovery after reset). The
 * old jupiter-budget token bucket assumed 10 req/SEC with a 30-token burst —
 * up to 30x the real allowance — so every attestor tick blew the window in
 * its first second, then the per-mint fallback loops amplified one batch 429
 * into 75-125 individual calls, each 429ing on paid and falling to the lite
 * tier. Fixing the model here removes the whole storm class.
 *
 * What it does:
 *   1. WINDOW-ACCURATE BUDGETS. Paid: 10/10s fixed window, self-synced from
 *      x-ratelimit-remaining / x-ratelimit-reset response headers, global
 *      cooldown until reset on 429 (a 429 is a WINDOW signal, not a mint
 *      signal — it must never bump per-mint backoff). Lite: separate
 *      conservative window (no headers documented; ~60/min per IP).
 *   2. MICRO-BATCH COALESCER. Every per-mint lookup enqueues; the queue
 *      flushes after JUP_COALESCE_MS (or immediately at JUP_MAX_IDS_PER_CALL
 *      pending) as ONE ids=a,b,c call. 125 mints = 3 HTTP requests.
 *   3. OMISSION IS LOUD (see jupiter-batch-silent-omission-pitfall memory:
 *      Token-2022 / xStock mints can be silently missing from a 200
 *      response). An omitted mint's promise REJECTS with .jupNoCoverage so
 *      per-caller Dex/Pyth fallbacks engage — never a silent skip. Bulk
 *      callers also get a short negative cache so backfill loops go straight
 *      to DexScreener instead of re-burning Jupiter budget per mint.
 *      Interactive callers bypass the negative cache (a borrow-path lookup
 *      always gets a live retry).
 *   4. PRIORITY CLASSES. cls:"interactive" (borrow valuation, cross-source
 *      primary, TG commands) vs cls:"bulk" (attestor, readiness loop,
 *      batch). JUPITER_PAID_INTERACTIVE_RESERVE paid units per window are
 *      reserved so a 125-mint attestor tick can never starve a user's
 *      borrow. Bulk overflows to the lite tier automatically.
 *
 * Kill switch: JUP_COALESCE_DISABLED=1 → isClientEnabled() false and
 * price.js reverts to its legacy direct-request paths untouched.
 *
 * This module deliberately imports nothing from jupiter-budget.js /
 * price.js (they import US) — keeps the dependency graph acyclic.
 */
import axios from "axios";
import "dotenv/config";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const cfg = {
  apiKey: process.env.JUPITER_API_KEY || null,
  paidUrl: process.env.JUPITER_API_URL || "https://api.jup.ag/price/v3",
  liteUrl: "https://lite-api.jup.ag/price/v3",
  paidLimit: Number(process.env.JUPITER_PAID_WINDOW_LIMIT) || 10,
  paidWindowMs: Number(process.env.JUPITER_PAID_WINDOW_MS) || 10_000,
  interactiveReserve: Number(process.env.JUPITER_PAID_INTERACTIVE_RESERVE) || 3,
  liteLimit: Number(process.env.JUPITER_LITE_WINDOW_LIMIT) || 10,
  liteWindowMs: Number(process.env.JUPITER_LITE_WINDOW_MS) || 10_000,
  coalesceMs: Number(process.env.JUP_COALESCE_MS) || 40,
  maxIds: Number(process.env.JUP_MAX_IDS_PER_CALL) || 50,
  solUsdTtlMs: Number(process.env.JUP_SOL_USD_TTL_MS) || 5_000,
  omittedNegTtlMs: Number(process.env.JUP_OMITTED_NEG_TTL_MS) || 60_000,
  // How long a caller is willing to sit in the queue for budget to free up
  // before failing over to its own Dex/Pyth fallback. Cross-source callers
  // run Jupiter and DexScreener in PARALLEL, so an interactive wait here
  // does not stack on top of the Dex fetch.
  maxWaitInteractiveMs: Number(process.env.JUP_MAX_WAIT_INTERACTIVE_MS) || 2_500,
  maxWaitBulkMs: Number(process.env.JUP_MAX_WAIT_BULK_MS) || 8_000,
};

export function isClientEnabled() {
  return process.env.JUP_COALESCE_DISABLED !== "1";
}

// Injectable for the check:jup-client guard — real code never touches this.
let deps = { get: (...args) => axios.get(...args), now: () => Date.now() };
export function __setTestDeps(d) { deps = { ...deps, ...d }; }
export function __setTestConfig(partial) { Object.assign(cfg, partial); }

if (isClientEnabled()) {
  console.log(
    `[jup-client] coalescing client active: paid=${cfg.apiKey ? `${cfg.paidLimit}/${cfg.paidWindowMs}ms (reserve ${cfg.interactiveReserve})` : "no-key"} ` +
    `lite=${cfg.liteLimit}/${cfg.liteWindowMs}ms maxIds=${cfg.maxIds} coalesce=${cfg.coalesceMs}ms`,
  );
} else {
  console.log("[jup-client] DISABLED via JUP_COALESCE_DISABLED — legacy direct request paths in force");
}

// ─── Tier windows ────────────────────────────────────────────────────
const windows = {
  paid: { used: 0, windowStart: 0, cooldownUntil: 0 },
  lite: { used: 0, windowStart: 0, cooldownUntil: 0 },
};

function tierParams(tier) {
  return tier === "paid"
    ? { limit: cfg.paidLimit, ms: cfg.paidWindowMs }
    : { limit: cfg.liteLimit, ms: cfg.liteWindowMs };
}

function tryTake(tier, isInteractive, now) {
  const w = windows[tier];
  const { limit, ms } = tierParams(tier);
  if (now < w.cooldownUntil) return false;
  if (now - w.windowStart >= ms) { w.windowStart = now; w.used = 0; }
  const floor = tier === "paid" && !isInteractive ? cfg.interactiveReserve : 0;
  if (w.used >= limit - floor) return false;
  w.used += 1;
  return true;
}

/** ms until ANY tier could serve a request (0 = a unit is free right now). */
function nextAvailabilityMs(now) {
  const waits = [];
  for (const tier of cfg.apiKey ? ["paid", "lite"] : ["lite"]) {
    const w = windows[tier];
    const { limit, ms } = tierParams(tier);
    if (now < w.cooldownUntil) { waits.push(w.cooldownUntil - now); continue; }
    if (now - w.windowStart >= ms) { waits.push(0); continue; }
    waits.push(w.used < limit ? 0 : w.windowStart + ms - now);
  }
  return Math.min(...waits);
}

/**
 * Used by jupiter-budget's routeFor/tryAcquireJupiterToken in client mode:
 * "is Jupiter worth routing to right now?" — yes if a unit is free or will
 * free within the interactive patience window. No token is spent here; the
 * client enforces spend at flush time.
 */
export function clientAvailability() {
  const wait = nextAvailabilityMs(deps.now());
  return { available: wait <= cfg.maxWaitInteractiveMs, waitMs: wait };
}

function syncPaidFromHeaders(headers, now) {
  const rem = Number(headers?.["x-ratelimit-remaining"]);
  const reset = Number(headers?.["x-ratelimit-reset"]);
  if (Number.isFinite(rem)) {
    // Server is authoritative — never let local accounting UNDER-count.
    windows.paid.used = Math.max(windows.paid.used, cfg.paidLimit - rem);
  }
  if (Number.isFinite(reset)) {
    const resetMs = reset * 1000;
    if (resetMs > now && resetMs - now <= cfg.paidWindowMs + 2_000) {
      windows.paid.windowStart = resetMs - cfg.paidWindowMs;
    }
  }
}

function onRateLimited(tier, headers, now) {
  const w = windows[tier];
  const { ms } = tierParams(tier);
  const reset = Number(headers?.["x-ratelimit-reset"]);
  const resetMs = Number.isFinite(reset) ? reset * 1000 : 0;
  w.cooldownUntil = resetMs > now && resetMs - now <= ms + 2_000 ? resetMs : now + ms;
  w.used = tierParams(tier).limit;
}

// ─── Errors ──────────────────────────────────────────────────────────
// .jupNoCoverage is deliberately NOT a .code: price.js's
// isTransientPriceError treats any {code, no response} error as transient,
// and an omission must be NON-transient (fall to DexScreener immediately,
// matching the legacy "No price data for mint" behavior).
function noCoverageError(mint, via) {
  const e = new Error(`No price data for mint ${mint} (Jupiter omitted it, via=${via})`);
  e.jupNoCoverage = true;
  return e;
}
function rateLimitedError(detail) {
  const e = new Error(`Jupiter rate-limited (${detail})`);
  e.code = "JUP_RATE_LIMITED"; // {code, no response} → transient in price.js
  return e;
}

// ─── Caches ──────────────────────────────────────────────────────────
let solUsdCache = { price: null, at: 0 };
const omittedAt = new Map(); // mint → ts of last observed omission (bulk-only read)

// ─── Stats (cumulative + 60s summary log) ────────────────────────────
const stats = {
  requests: 0, cacheHits: 0, negCacheRejects: 0,
  paidCalls: 0, liteCalls: 0, paid429s: 0, lite429s: 0,
  omissions: 0, netErrors: 0, budgetRejects: 0,
};
let statsAtLastLog = { ...stats };
const statsTimer = setInterval(() => {
  const d = {};
  let any = false;
  for (const k of Object.keys(stats)) {
    d[k] = stats[k] - statsAtLastLog[k];
    if (d[k] > 0) any = true;
  }
  statsAtLastLog = { ...stats };
  if (!any) return;
  console.log(
    `[jup-client] 60s: reqs=${d.requests} (cache=${d.cacheHits} negcache=${d.negCacheRejects}) ` +
    `calls: paid=${d.paidCalls} lite=${d.liteCalls} | 429: paid=${d.paid429s} lite=${d.lite429s} ` +
    `| omissions=${d.omissions} netErr=${d.netErrors} budgetRej=${d.budgetRejects}`,
  );
}, 60_000);
statsTimer.unref?.();

export function getJupiterClientStats() {
  const now = deps.now();
  return {
    enabled: isClientEnabled(),
    ...stats,
    pending: pending.size,
    next_available_ms: nextAvailabilityMs(now),
    paid: { ...windows.paid },
    lite: { ...windows.lite },
  };
}

// ─── Coalescing queue ────────────────────────────────────────────────
const pending = new Map(); // mint → { cls, resolvers: [{resolve, reject}] }
let flushTimer = null;
let flushTimerFiresAt = 0;
let flushing = false;

/**
 * Resolve the USD price for one mint. Coalesced under the hood.
 *   cls: "interactive" (default — user-facing / high-stakes paths) or
 *        "bulk" (attestor / readiness / batch sweeps).
 * Rejects with .jupNoCoverage (non-transient → caller goes to Dex) when
 * Jupiter omits the mint, or .code="JUP_RATE_LIMITED" (transient) when
 * both tiers are out of budget beyond the class's patience.
 */
export function requestUsdPrice(mint, { cls = "interactive" } = {}) {
  const now = deps.now();
  stats.requests += 1;
  if (mint === SOL_MINT && solUsdCache.price != null && now - solUsdCache.at <= cfg.solUsdTtlMs) {
    stats.cacheHits += 1;
    return Promise.resolve(solUsdCache.price);
  }
  if (cls === "bulk") {
    const om = omittedAt.get(mint);
    if (om != null && now - om <= cfg.omittedNegTtlMs) {
      stats.negCacheRejects += 1;
      return Promise.reject(noCoverageError(mint, "neg-cache"));
    }
  }
  return new Promise((resolve, reject) => {
    let entry = pending.get(mint);
    if (!entry) {
      entry = { cls, resolvers: [] };
      pending.set(mint, entry);
    }
    if (cls === "interactive") entry.cls = "interactive";
    entry.resolvers.push({ resolve, reject });
    scheduleFlush(pending.size >= cfg.maxIds ? 0 : cfg.coalesceMs);
  });
}

function scheduleFlush(delayMs) {
  if (flushing) return;
  const firesAt = deps.now() + delayMs;
  // PREEMPTION: a long budget-wait timer (a bulk chunk sleeping out its
  // window, up to maxWaitBulkMs) must never delay a NEW request — an
  // interactive lookup arriving mid-wait may have reserved paid budget
  // available RIGHT NOW. If this request could flush sooner than the
  // armed timer, re-arm to the sooner deadline; flushNow re-sorts
  // interactive to the front and the bulk chunk simply re-waits.
  if (flushTimer) {
    if (firesAt >= flushTimerFiresAt) return;
    clearTimeout(flushTimer);
  }
  flushTimerFiresAt = firesAt;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, delayMs);
}

function settle(chunk, fn) {
  for (const [, entry] of chunk) {
    for (const r of entry.resolvers) {
      try { fn(r); } catch { /* resolver threw — never break the loop */ }
    }
  }
}

async function flushNow() {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.size > 0) {
      const now = deps.now();
      // Interactive mints go in the first chunk so they're never queued
      // behind a bulk sweep.
      const entries = [...pending.entries()].sort((a, b) =>
        a[1].cls === b[1].cls ? 0 : a[1].cls === "interactive" ? -1 : 1,
      );
      const chunk = entries.slice(0, cfg.maxIds);
      const isInteractive = chunk.some(([, e]) => e.cls === "interactive");

      let tier = null;
      if (cfg.apiKey && tryTake("paid", isInteractive, now)) tier = "paid";
      else if (tryTake("lite", isInteractive, now)) tier = "lite";

      if (!tier) {
        const waitMs = nextAvailabilityMs(now);
        const maxWait = isInteractive ? cfg.maxWaitInteractiveMs : cfg.maxWaitBulkMs;
        if (waitMs <= maxWait) {
          // Budget frees up within patience — come back for the whole queue.
          // (A new request arriving mid-wait preempts this via scheduleFlush.)
          flushTimerFiresAt = now + waitMs + 25;
          flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, waitMs + 25);
          return;
        }
        // Out of budget beyond patience: fail THIS chunk fast so callers use
        // their Dex/Pyth fallbacks; loop continues in case a later chunk is
        // pure-bulk vs interactive (different patience).
        for (const [mint] of chunk) pending.delete(mint);
        stats.budgetRejects += 1;
        settle(chunk, (r) => r.reject(rateLimitedError("budget exhausted on both tiers")));
        continue;
      }

      // Claim synchronously before awaiting so a concurrent enqueue can
      // never be double-settled.
      for (const [mint] of chunk) pending.delete(mint);
      await executeChunk(tier, chunk, isInteractive);
    }
  } finally {
    flushing = false;
    // Respect an armed budget-wait timer — re-scheduling here would preempt
    // it into a 40ms spin. Only NEW requests (scheduleFlush from
    // requestUsdPrice) may preempt a wait.
    if (pending.size > 0 && !flushTimer) scheduleFlush(cfg.coalesceMs);
  }
}

async function executeChunk(tier, chunk, isInteractive) {
  const url = tier === "paid" ? cfg.paidUrl : cfg.liteUrl;
  const headers = tier === "paid" && cfg.apiKey ? { "x-api-key": cfg.apiKey } : {};
  const mints = chunk.map(([m]) => m);
  // Ride SOL along on every call — every SOL-denominated conversion needs it
  // and the extra id is free (paid bills per request, not per id).
  const ids = mints.includes(SOL_MINT) ? mints : mints.concat(SOL_MINT);
  try {
    const resp = await deps.get(url, {
      params: { ids: ids.join(",") },
      headers,
      timeout: 10_000,
    });
    const now = deps.now();
    if (tier === "paid") { syncPaidFromHeaders(resp.headers, now); stats.paidCalls += 1; }
    else stats.liteCalls += 1;
    const data = resp.data || {};
    const solUsd = data[SOL_MINT]?.usdPrice;
    if (solUsd > 0) solUsdCache = { price: solUsd, at: now };
    for (const [mint, entry] of chunk) {
      const usd = data[mint]?.usdPrice;
      if (usd > 0) {
        omittedAt.delete(mint);
        settle([[mint, entry]], (r) => r.resolve(usd));
      } else {
        // SILENT OMISSION (jupiter-batch-silent-omission-pitfall): a 200
        // response that's just missing the mint. Reject LOUDLY so the
        // caller's Dex/Pyth fallback engages, and negative-cache so bulk
        // backfill loops don't re-burn budget per mint.
        omittedAt.set(mint, now);
        stats.omissions += 1;
        settle([[mint, entry]], (r) => r.reject(noCoverageError(mint, tier)));
      }
    }
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) {
      const now = deps.now();
      onRateLimited(tier, err.response?.headers, now);
      if (tier === "paid") {
        stats.paid429s += 1;
        // The lite tier has a SEPARATE quota — one retry for the whole chunk.
        if (tryTake("lite", isInteractive, now)) {
          return executeChunk("lite", chunk, isInteractive);
        }
      } else {
        stats.lite429s += 1;
      }
      settle(chunk, (r) => r.reject(rateLimitedError(`${tier} 429`)));
      return;
    }
    stats.netErrors += 1;
    settle(chunk, (r) => r.reject(err));
  }
}

/** Test-only: reset all mutable state between guard-script cases. */
export function __resetForTests() {
  windows.paid = { used: 0, windowStart: 0, cooldownUntil: 0 };
  windows.lite = { used: 0, windowStart: 0, cooldownUntil: 0 };
  solUsdCache = { price: null, at: 0 };
  omittedAt.clear();
  pending.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  for (const k of Object.keys(stats)) stats[k] = 0;
  statsAtLastLog = { ...stats };
}

export { SOL_MINT };
