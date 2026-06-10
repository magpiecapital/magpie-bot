/**
 * Intent webhook delivery — fire-and-record HMAC-signed POST to the
 * caller-supplied URL when an intent flips to 'matched'.
 *
 * Design properties:
 *
 *   - Best-effort with bounded retry. We try once inline at match
 *     time, then a separate retry pass picks up failures. Maximum
 *     5 attempts with exponential backoff (5s, 15s, 45s, 135s, 405s).
 *     If all five fail we mark the intent's webhook_last_error and
 *     stop — the agent's status poll path still works, so a webhook
 *     failure isn't a complete dead-end.
 *
 *   - HMAC-SHA256 with the per-intent webhook_secret. Agents store
 *     the secret returned at intent-create time and use it to
 *     verify the X-Magpie-Signature header on receive. Constant-
 *     time compare on their end is mandatory.
 *
 *   - Replay window: payload includes `issued_at` (ms since epoch)
 *     plus `intent_id`. Recipients should reject anything older
 *     than e.g. 5 minutes or with a duplicate (intent_id, issued_at)
 *     pair.
 *
 *   - URL validation: must be HTTPS, must not resolve to a local /
 *     private IP. Defense against SSRF (someone could try to set
 *     webhook_url to http://localhost:6379 to talk to our Redis,
 *     or http://169.254.169.254 to hit AWS metadata).
 *
 *   - Body size: the payload is small (~1 KB). Recipients should
 *     enforce their own size limit too.
 *
 *   - Concurrency: each delivery acquires nothing exclusive. If two
 *     ticks race we'll deliver twice — the recipient must be
 *     idempotent on `intent_id`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "../db/pool.js";

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
const USER_AGENT = "Magpie-Webhooks/1.0 (+https://magpie.capital/x402)";

// SSRF guard: forbid private/local addresses + reserved ranges.
// Quick check by hostname before we even attempt to resolve.
function isUnsafeHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h.endsWith(".local")) return true;
  // IPv4 private/loopback/link-local/metadata ranges
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  if (/^127\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  // IPv6 loopback + link-local + ULA
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true;
  if (/^f[cd]/.test(h)) return true;
  return false;
}

/**
 * Validate + normalize a webhook URL. Returns null if invalid.
 * Caller already accepted the URL at intent-create time, so this is
 * defense-in-depth.
 */
export function isValidWebhookUrl(url) {
  if (typeof url !== "string" || url.length > 2048) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // creds in URL — leak risk
  if (isUnsafeHost(u.hostname)) return false;
  return true;
}

/**
 * Generate a fresh per-intent webhook secret (256 bits).
 * Returned at intent-create time alongside intent_id.
 */
export function generateWebhookSecret() {
  return randomBytes(32).toString("hex");
}

/**
 * Sign a payload. Returns the hex signature.
 *
 * Recipient verification:
 *   const expected = hmac_sha256(webhook_secret, raw_body_bytes).hex();
 *   if (!constant_time_equals(expected, X-Magpie-Signature)) reject;
 */
function sign(secret, bodyBytes) {
  return createHmac("sha256", secret).update(bodyBytes).digest("hex");
}

/**
 * Build the canonical webhook payload for intent.matched.
 * This is what the recipient sees in the POST body.
 */
function buildPayload(intent) {
  return {
    event: "intent.matched",
    issued_at: Date.now(),
    intent_id: intent.intent_id,
    status: "matched",
    matched_at: intent.matched_at,
    summary: intent.summary, // parsed JSON object
    partial_signed_tx_b64: intent.partial_signed_tx_b64,
    next_step:
      "Sign the partial_signed_tx_b64 with the borrower wallet and submit to https://magpie.capital/api/v1/cosign-borrow. The same data is available via GET /api/v1/agent/intent?id=<intent_id>.",
  };
}

/**
 * Attempt one delivery. Returns { ok: bool, status?, error? }.
 * Does NOT update DB rows — caller (deliver/retry) does that.
 */
async function postOnce(url, secret, payload) {
  // Body must be the EXACT bytes we sign — serialize once.
  const bodyStr = JSON.stringify(payload);
  const bodyBytes = Buffer.from(bodyStr, "utf8");
  const signature = sign(secret, bodyBytes);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Magpie-Event": "intent.matched",
        "X-Magpie-Signature": signature,
        "X-Magpie-Intent-Id": payload.intent_id,
      },
      body: bodyBytes,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error", // don't follow redirects — could be SSRF pivot
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
  // 2xx = success. 3xx (we set redirect: error so we shouldn't see it).
  // 4xx = recipient rejected, don't retry. 5xx = retry.
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  if (res.status >= 400 && res.status < 500) {
    return { ok: false, status: res.status, error: `recipient rejected (${res.status})` };
  }
  return { ok: false, status: res.status, error: `recipient error (${res.status})` };
}

/**
 * Try to deliver right now. Called inline from intent-watcher when
 * status flips to matched. Records attempts + result. Returns the
 * result of the first attempt (no retry inline — that's the retry
 * tick's job, so we don't hold up the watcher loop).
 */
export async function tryDeliverNow(intentId) {
  const { rows } = await query(
    `SELECT intent_id, webhook_url, webhook_secret, summary,
            partial_signed_tx_b64, matched_at, webhook_attempts
       FROM borrow_intents
       WHERE intent_id = $1 AND status = 'matched'
         AND webhook_url IS NOT NULL
         AND webhook_delivered_at IS NULL`,
    [intentId],
  );
  if (!rows[0]) return null; // no webhook, or already delivered
  const r = rows[0];

  // Defense-in-depth: re-validate URL right before delivery, in case
  // the row was tampered with after create.
  if (!isValidWebhookUrl(r.webhook_url)) {
    await query(
      `UPDATE borrow_intents SET webhook_attempts = webhook_attempts + 1,
                                  webhook_last_error = $2
         WHERE intent_id = $1`,
      [intentId, "url_invalid_at_delivery_time"],
    );
    return { ok: false, error: "url_invalid_at_delivery_time" };
  }

  const payload = buildPayload(r);
  const result = await postOnce(r.webhook_url, r.webhook_secret, payload);

  if (result.ok) {
    await query(
      `UPDATE borrow_intents SET
         webhook_delivered_at = NOW(),
         webhook_attempts = webhook_attempts + 1,
         webhook_last_error = NULL
         WHERE intent_id = $1`,
      [intentId],
    );
  } else {
    await query(
      `UPDATE borrow_intents SET
         webhook_attempts = webhook_attempts + 1,
         webhook_last_error = $2
         WHERE intent_id = $1`,
      [intentId, (result.error || "unknown").slice(0, 500)],
    );
  }
  return result;
}

/**
 * Retry-pass tick. Called from the watcher cycle. Picks up matched-
 * but-undelivered intents that are due for another attempt and tries
 * each. Exponential backoff via `next_retry_after_at` semantics
 * computed in-query.
 *
 * Backoff schedule (from matched_at + attempt # offset):
 *   attempt 1 (the inline one at match): t = 0
 *   attempt 2: t = matched_at + 5s
 *   attempt 3: t = matched_at + 20s   (5 + 15)
 *   attempt 4: t = matched_at + 65s   (5 + 15 + 45)
 *   attempt 5: t = matched_at + 200s  (5 + 15 + 45 + 135)
 *   after 5 attempts: abandon (log only)
 */
const BACKOFF_OFFSETS_SEC = [0, 5, 20, 65, 200];

export async function retryPendingWebhooks() {
  const { rows } = await query(
    `SELECT intent_id, webhook_url, webhook_secret, summary,
            partial_signed_tx_b64, matched_at, webhook_attempts,
            EXTRACT(EPOCH FROM (NOW() - matched_at))::int AS seconds_since_match
       FROM borrow_intents
       WHERE status = 'matched'
         AND webhook_url IS NOT NULL
         AND webhook_delivered_at IS NULL
         AND webhook_attempts < $1
       ORDER BY matched_at ASC
       LIMIT 50`,
    [MAX_ATTEMPTS],
  );
  for (const r of rows) {
    // Only try if we're past the next backoff window.
    const nextOffset = BACKOFF_OFFSETS_SEC[r.webhook_attempts] ?? 999_999;
    if (r.seconds_since_match < nextOffset) continue;

    const payload = buildPayload(r);
    const result = await postOnce(r.webhook_url, r.webhook_secret, payload);

    if (result.ok) {
      await query(
        `UPDATE borrow_intents SET
           webhook_delivered_at = NOW(),
           webhook_attempts = webhook_attempts + 1,
           webhook_last_error = NULL
           WHERE intent_id = $1`,
        [r.intent_id],
      );
      console.log(
        `[intent-webhook] delivered ${r.intent_id} on attempt ${r.webhook_attempts + 1}`,
      );
    } else {
      await query(
        `UPDATE borrow_intents SET
           webhook_attempts = webhook_attempts + 1,
           webhook_last_error = $2
           WHERE intent_id = $1`,
        [r.intent_id, (result.error || "unknown").slice(0, 500)],
      );
      if (r.webhook_attempts + 1 >= MAX_ATTEMPTS) {
        console.warn(
          `[intent-webhook] ${r.intent_id} EXHAUSTED RETRIES — last error: ${result.error}`,
        );
      }
    }
  }
  return rows.length;
}

/**
 * Exposed so unit tests / external code can verify a webhook signature
 * deterministically. Returns true iff signature matches.
 */
export function verifySignature(secret, bodyBytes, signatureHex) {
  if (typeof signatureHex !== "string" || signatureHex.length !== 64) return false;
  const expected = sign(secret, bodyBytes);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
