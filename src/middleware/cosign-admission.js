/**
 * Admission control for /api/v1/cosign-borrow — the privileged, unauthenticated,
 * expensive path that leads to the lender signer.
 *
 * WHY. The endpoint's SECURITY is already strong: the handler enforces a strict
 * instruction-discriminator allowlist, so it will only ever sign
 * `request_and_fund_loan` and rejects anything else. There is deliberately no
 * API-key gate, because any user's browser has to be able to call it.
 *
 * What is NOT protected is AVAILABILITY. The endpoint is unauthenticated,
 * unthrottled, and a single request can occupy up to ~95 seconds while a cold
 * V4 feed TWAP-warms. Nothing stops anyone opening many concurrent requests and
 * saturating the service — and when this endpoint is saturated, REAL BORROWS
 * FAIL. That is the protocol's first mandate, so the availability of this path
 * matters more than almost anything else on the service.
 *
 * WHY CONCURRENCY, NOT JUST RATE. Rate limiting alone does not fix this: a cap
 * of 20/min still permits 20 simultaneous 95-second requests. The scarce
 * resource here is in-flight slots, so that is what is bounded.
 *
 * WHY IN-MEMORY IS THE RIGHT TOOL HERE (and was not on the site). The bot is a
 * single long-running Railway process, so one in-memory counter sees every
 * request. The same approach on the Vercel site was MEASURED useless — 70
 * sequential requests passed a 60/min limit untouched, because each serverless
 * instance keeps its own counter. Put the limiter where the process is durable.
 *
 * DESIGN PRIORITY — in this order:
 *   1. NEVER BLOCK A REAL BORROWER. Ceilings are far above any plausible real
 *      load, every rejection is explicitly RETRYABLE with a retry_after, and
 *      any internal error FAILS OPEN (admits the request).
 *   2. Bound the damage a flood can do.
 *
 * Env overrides (operator can widen instantly without a code change):
 *   COSIGN_MAX_INFLIGHT   default 12
 *   COSIGN_BURST          default 10
 *   COSIGN_REFILL_PER_SEC default 0.5
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const MAX_INFLIGHT = num(process.env.COSIGN_MAX_INFLIGHT, 12);
const BURST = num(process.env.COSIGN_BURST, 10);
const REFILL_PER_SEC = num(process.env.COSIGN_REFILL_PER_SEC, 0.5);

/** Per-IP token buckets. Same shape as src/middleware/rate-limit.js. */
const buckets = new Map();
const MAX_KEYS = 20_000;

let inflight = 0;

/** Observability — surfaced by getCosignAdmissionStats() for /health. */
const stats = { admitted: 0, rejectedInflight: 0, rejectedRate: 0, peakInflight: 0 };

function clientIp(req) {
  try {
    const xff = req.headers?.get?.("x-forwarded-for") || req.headers?.["x-forwarded-for"];
    if (xff) {
      const first = String(xff).split(",")[0]?.trim();
      if (first) return first;
    }
    const real = req.headers?.get?.("x-real-ip") || req.headers?.["x-real-ip"];
    return real ? String(real).trim() : null;
  } catch {
    return null;
  }
}

function takeToken(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= MAX_KEYS) {
      // Drop buckets that have fully refilled — they carry no state worth keeping.
      for (const [k, v] of buckets) {
        if (v.tokens + ((now - v.last) / 1000) * REFILL_PER_SEC >= BURST) buckets.delete(k);
      }
      if (buckets.size >= MAX_KEYS) buckets.clear();
    }
    b = { tokens: BURST, last: now };
    buckets.set(ip, b);
  } else {
    b.tokens = Math.min(BURST, b.tokens + ((now - b.last) / 1000) * REFILL_PER_SEC);
    b.last = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * Decide whether to admit a cosign request.
 *
 * @returns {{ ok: true, release: () => void } | { ok: false, response: object }}
 *   On admission the caller MUST invoke release() in a finally block.
 *   On rejection, `response` is a ready `{ status, body }` for the dispatcher.
 */
export function admitCosign(req) {
  try {
    if (inflight >= MAX_INFLIGHT) {
      stats.rejectedInflight++;
      return {
        ok: false,
        response: {
          status: 503,
          body: {
            error: "cosign_busy",
            detail:
              "The co-signer is at capacity right now. This is temporary and safe to retry — " +
              "your transaction was not submitted and nothing was signed.",
            retry_after_seconds: 5,
            retryable: true,
          },
        },
      };
    }

    const ip = clientIp(req);
    // An unattributable request is admitted: we cannot fairly throttle what we
    // cannot identify, and refusing it would punish a real borrower behind a
    // proxy that strips headers. The in-flight cap above still bounds the flood.
    if (ip && !takeToken(ip)) {
      stats.rejectedRate++;
      return {
        ok: false,
        response: {
          status: 429,
          body: {
            error: "cosign_rate_limited",
            detail:
              "Too many co-sign attempts from this address in a short window. " +
              "Wait a few seconds and retry — nothing was signed.",
            retry_after_seconds: 6,
            retryable: true,
          },
        },
      };
    }

    inflight++;
    stats.admitted++;
    if (inflight > stats.peakInflight) stats.peakInflight = inflight;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return; // idempotent — a double-release must not corrupt the count
        released = true;
        inflight = Math.max(0, inflight - 1);
      },
    };
  } catch {
    // FAIL OPEN. A bug in admission control must never be the reason a borrow
    // fails. Returns a no-op release so the caller's finally block is safe.
    return { ok: true, release: () => {} };
  }
}

export function getCosignAdmissionStats() {
  return { ...stats, inflight, maxInflight: MAX_INFLIGHT, burst: BURST };
}
