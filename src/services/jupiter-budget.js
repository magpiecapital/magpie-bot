/**
 * Jupiter request-budgeting layer.
 *
 * Operator-mandated 2026-06-18 PM after the lite-api endpoint switch
 * pushed the Jupiter 429 ratio from 5× to 12×. The fundamental issue
 * is that we hammer Jupiter at full speed for every price fetch, with
 * no mint-class differentiation and no global throttle. This module
 * adds three guardrails:
 *
 *   1. Token-bucket rate limiter — caps total Jupiter calls to
 *      JUPITER_BUDGET_PER_SEC requests/sec across all callers.
 *      Refills at the same rate, with a small headroom bucket so
 *      genuine bursts (e.g. attestor tick start) aren't blocked.
 *
 *   2. Per-mint 429 backoff — when a mint returns 429 from Jupiter,
 *      we suppress further Jupiter calls for that specific mint for
 *      30s / 60s / 120s / 240s (exponential, capped at 5 min). A
 *      success clears the backoff. This stops one badly-routed mint
 *      from chewing the global budget.
 *
 *   3. RWA-first DexScreener routing — for category in (stock, etf,
 *      metal), DexScreener is the primary source. Jupiter is only
 *      consulted as a fallback if Dex fails AND we have budget. xStocks
 *      have stable per-share prices that DexScreener tracks well and
 *      Jupiter's route quality for thin RWA pairs is poor anyway —
 *      we already saw the 1000× decimals mismatch driving the canary
 *      alerts. Memecoins stay Jupiter-first because route quality
 *      matters more for swap execution there.
 *
 * Observability: a rolling 60s window counts how many Jupiter requests
 * we attempted, how many were 429, how many were budget-deferred to
 * Dex. Exposed via getJupiterBudgetStats() for the health-watcher to
 * surface in admin alerts.
 *
 * Configuration (all env-tunable, sensible defaults):
 *   JUPITER_BUDGET_PER_SEC = 10  (10 req/sec sustained)
 *   JUPITER_BUDGET_MAX     = 30  (3-second burst)
 *   JUPITER_BACKOFF_BASE_MS= 30000  (30s first 429)
 *   JUPITER_BACKOFF_CAP_MS = 300000 (5min max)
 *
 * See project_jupiter_request_budgeting_p0.md for the design history.
 */
import { query } from "../db/pool.js";

const BUDGET_PER_SEC = Number(process.env.JUPITER_BUDGET_PER_SEC) || 10;
const BUDGET_MAX = Number(process.env.JUPITER_BUDGET_MAX) || 30;
const BACKOFF_BASE_MS = Number(process.env.JUPITER_BACKOFF_BASE_MS) || 30_000;
const BACKOFF_CAP_MS = Number(process.env.JUPITER_BACKOFF_CAP_MS) || 300_000;

const RWA_CATEGORIES = new Set(["stock", "etf", "metal"]);

// ─── Token bucket ────────────────────────────────────────────────────
let tokens = BUDGET_MAX;
let lastRefillAt = Date.now();

function refillTokens() {
  const now = Date.now();
  const elapsedSec = (now - lastRefillAt) / 1000;
  tokens = Math.min(BUDGET_MAX, tokens + elapsedSec * BUDGET_PER_SEC);
  lastRefillAt = now;
}

/**
 * Try to take 1 token (= 1 Jupiter request). Returns true if we got it.
 * A batch call counts as 1 token even if it covers N mints — the bucket
 * sizes the HTTP-request rate, not the mint-coverage rate.
 */
export function tryAcquireJupiterToken() {
  refillTokens();
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

export function jupiterBudgetSnapshot() {
  refillTokens();
  return { tokens_available: tokens, budget_per_sec: BUDGET_PER_SEC, budget_max: BUDGET_MAX };
}

// ─── Per-mint 429 backoff ────────────────────────────────────────────
const backoffByMint = new Map(); // mint → { until_ms, attempts }

export function isMintInJupiterBackoff(mint) {
  const e = backoffByMint.get(mint);
  if (!e) return false;
  if (e.until_ms <= Date.now()) {
    backoffByMint.delete(mint);
    return false;
  }
  return true;
}

export function bumpMintJupiterBackoff(mint) {
  const existing = backoffByMint.get(mint);
  const attempts = (existing?.attempts || 0) + 1;
  const delayMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempts - 1));
  backoffByMint.set(mint, { until_ms: Date.now() + delayMs, attempts });
  return { attempts, delayMs };
}

export function clearMintJupiterBackoff(mint) {
  backoffByMint.delete(mint);
}

// ─── Category lookup (cached) ────────────────────────────────────────
const categoryCache = new Map(); // mint → { category, fetched_at_ms }
const CATEGORY_TTL_MS = 5 * 60_000; // 5min — categories rarely change

async function getMintCategory(mint) {
  const cached = categoryCache.get(mint);
  if (cached && Date.now() - cached.fetched_at_ms < CATEGORY_TTL_MS) {
    return cached.category;
  }
  let category = null;
  try {
    const { rows } = await query(
      `SELECT category FROM supported_mints WHERE mint = $1 LIMIT 1`,
      [mint],
    );
    category = rows[0]?.category ?? null;
  } catch {
    // Fail SAFE — unknown category, treat as memecoin (Jupiter-first).
  }
  categoryCache.set(mint, { category, fetched_at_ms: Date.now() });
  return category;
}

/**
 * Decide the routing for a given mint.
 *
 * Returns one of:
 *   - "jupiter_first"   — try Jupiter primary, Dex fallback (default for
 *                         memecoins with budget and no backoff)
 *   - "dexscreener_first" — try Dex primary, Jupiter fallback only if
 *                         budget allows (RWA mints or memecoins in
 *                         backoff/no-budget)
 *   - "dexscreener_only"  — Dex only, Jupiter skipped entirely (mint is
 *                         deep in backoff AND budget is exhausted; or
 *                         operator-flagged Jupiter-down state)
 */
export async function routeFor(mint) {
  const category = await getMintCategory(mint);

  // RWA: always Dex-first; Jupiter only as fallback if budget allows.
  if (RWA_CATEGORIES.has(category)) {
    return { route: "dexscreener_first", reason: `rwa-category=${category}` };
  }

  // Memecoin in active backoff: respect the backoff.
  if (isMintInJupiterBackoff(mint)) {
    refillTokens();
    if (tokens < 1) {
      return { route: "dexscreener_only", reason: "in-backoff+no-budget" };
    }
    return { route: "dexscreener_first", reason: "in-backoff" };
  }

  // No budget right now: defer to Dex.
  refillTokens();
  if (tokens < 1) {
    return { route: "dexscreener_first", reason: "no-budget" };
  }

  return { route: "jupiter_first", reason: "ok" };
}

// ─── Metrics (rolling 60s) ───────────────────────────────────────────
const WINDOW_MS = 60_000;
const events = []; // { ts, kind }   kind ∈ {"jup_ok","jup_429","jup_err","budget_defer","backoff_skip"}

function record(kind) {
  const now = Date.now();
  events.push({ ts: now, kind });
  // Drop anything older than WINDOW_MS, lazily on read.
}
function pruneOld() {
  const cutoff = Date.now() - WINDOW_MS;
  while (events.length && events[0].ts < cutoff) events.shift();
}

export function recordJupiterOk() { record("jup_ok"); }
export function recordJupiter429(mint) {
  record("jup_429");
  bumpMintJupiterBackoff(mint);
}
export function recordJupiterErr() { record("jup_err"); }
export function recordBudgetDefer() { record("budget_defer"); }
export function recordBackoffSkip() { record("backoff_skip"); }

export function getJupiterBudgetStats() {
  pruneOld();
  const counts = events.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
  const total_jup_attempts = (counts.jup_ok || 0) + (counts.jup_429 || 0) + (counts.jup_err || 0);
  const ratio_429 = total_jup_attempts > 0
    ? ((counts.jup_429 || 0) / total_jup_attempts).toFixed(3)
    : "0.000";
  return {
    window_sec: WINDOW_MS / 1000,
    jup_ok: counts.jup_ok || 0,
    jup_429: counts.jup_429 || 0,
    jup_err: counts.jup_err || 0,
    budget_defer: counts.budget_defer || 0,
    backoff_skip: counts.backoff_skip || 0,
    ratio_429,
    bucket: jupiterBudgetSnapshot(),
    mints_in_backoff: backoffByMint.size,
  };
}
