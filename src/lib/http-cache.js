/**
 * Fetch + parse JSON with in-memory cache + exponential-backoff retry.
 *
 * The big win here is retry: when DexScreener / Jupiter return 429 (rate-
 * limited) or 5xx, instead of dropping the cycle silently we wait briefly
 * and retry. This is what kept the screener stalled for hours in the past.
 *
 * Returns the parsed JSON on success, or `null` on terminal failure (so
 * callers can stay structurally identical to `await fetch().then(r => r.json())`).
 */

const cache = new Map();              // url -> { value, expiresAt }
const inflight = new Map();           // url -> Promise (dedupes concurrent identical requests)

const DEFAULT_TTL_MS = 60_000;
const RETRY_DELAYS_MS = [1000, 2500, 6000]; // 4 total attempts including first
const MAX_RETRY_AFTER_HONORED_MS = 30_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, fetchOpts) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);

      if (res.ok) {
        return await res.json();
      }

      // Retryable: 429, 502, 503, 504
      const status = res.status;
      const retryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        let delay = RETRY_DELAYS_MS[attempt];
        const retryAfterSec = parseInt(res.headers.get("retry-after") || "0", 10);
        if (retryAfterSec > 0) {
          const ms = retryAfterSec * 1000;
          delay = Math.min(Math.max(delay, ms), MAX_RETRY_AFTER_HONORED_MS);
        }
        await sleep(delay);
        continue;
      }

      // Non-retryable failure
      return null;
    } catch {
      // Network error — retry
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Fetch a URL and return parsed JSON.
 * - Cache hit returns immediately
 * - In-flight requests are deduplicated (only one fetch per unique URL at a time)
 * - On 429/5xx/network errors, retries with exponential backoff
 * - Returns null on terminal failure
 */
export async function cachedJson(url, { ttlMs = DEFAULT_TTL_MS, ...fetchOpts } = {}) {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // Coalesce concurrent identical requests
  const existing = inflight.get(url);
  if (existing) return existing;

  const p = (async () => {
    try {
      const value = await fetchWithRetry(url, fetchOpts);
      if (value !== null) {
        cache.set(url, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, p);
  return p;
}

// Periodically evict expired entries to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 60_000).unref();
