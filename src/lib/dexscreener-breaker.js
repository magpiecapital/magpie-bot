/**
 * DexScreener circuit breaker (2026-08-30 incident: DexScreener API went
 * unreachable — every call sat on a 10-15s timeout, so screener /
 * snapshotter / token-health cycles ran 20+ minutes and the site banner
 * flipped to "degraded"). Root cause = no fail-fast when an upstream is
 * dead. This module gives every DexScreener caller one shared breaker:
 *
 *   - CLOSED  : calls pass through. Each failure (timeout / network /
 *               5xx / 429) increments a consecutive-failure counter.
 *   - OPEN    : after OPEN_AFTER consecutive failures the breaker opens
 *               for OPEN_MS. Callers get an immediate "breaker open"
 *               error instead of burning a timeout. Cycles complete in
 *               seconds and fall back to their alternate source.
 *   - HALF-OPEN: after OPEN_MS one probe call is allowed through. Success
 *               closes the breaker; failure re-opens it.
 *
 * Usage: `const data = await dexCall(() => fetch(...))` — or, for code
 * that manages its own fetch, `dexGuard()` before and `dexReport(ok)` after.
 * State is exposed via `dexBreakerState()` for /health.
 */
const OPEN_AFTER = Number(process.env.DEX_BREAKER_OPEN_AFTER || 3);
const OPEN_MS = Number(process.env.DEX_BREAKER_OPEN_MS || 90_000);

let consecutiveFailures = 0;
let openedAt = 0;          // 0 = closed
let probeInFlight = false;
let openCount = 0;
let lastError = null;

function isOpen() { return openedAt > 0; }

export function dexBreakerState() {
  const now = Date.now();
  return {
    state: !isOpen() ? "closed" : (now - openedAt >= OPEN_MS ? "half-open" : "open"),
    consecutiveFailures, openedAt: openedAt ? new Date(openedAt).toISOString() : null,
    openCount, lastError,
  };
}

/** Throws immediately if the breaker is open (and not due for a probe). */
export function dexGuard() {
  if (!isOpen()) return;
  const now = Date.now();
  if (now - openedAt >= OPEN_MS && !probeInFlight) { probeInFlight = true; return; } // half-open probe
  const err = new Error(`DexScreener breaker open (${consecutiveFailures} consecutive failures; retry in ${Math.max(0, Math.round((OPEN_MS - (now - openedAt)) / 1000))}s)`);
  err.code = "DEX_BREAKER_OPEN";
  throw err;
}

export function dexReport(ok, err) {
  probeInFlight = false;
  if (ok) {
    if (isOpen()) console.warn("[dex-breaker] CLOSED — DexScreener responding again");
    consecutiveFailures = 0; openedAt = 0; lastError = null;
    return;
  }
  consecutiveFailures++;
  lastError = err?.message?.slice(0, 120) ?? "unknown";
  if (isOpen()) { openedAt = Date.now(); return; }          // probe failed → stay open, restart window
  if (consecutiveFailures >= OPEN_AFTER) {
    openedAt = Date.now(); openCount++;
    console.warn(`[dex-breaker] OPEN for ${OPEN_MS / 1000}s after ${consecutiveFailures} consecutive failures (last: ${lastError}). Callers fail fast + use alternate sources.`);
  }
}

/** Wrap a DexScreener call: fail fast when open, report outcome otherwise. */
export async function dexCall(fn) {
  dexGuard();
  try { const v = await fn(); dexReport(true); return v; }
  catch (e) { dexReport(false, e); throw e; }
}

export const isDexBreakerOpen = () => dexBreakerState().state === "open";
