/**
 * Web-push subscription endpoints.
 *
 * Lets a borrower with no Telegram account receive loan-expiry warnings in the
 * browser. See services/push-send.js for why this channel exists at all.
 *
 * ── THE ATTACK THIS IS BUILT AGAINST ──────────────────────────────────────
 *
 * A push subscription is a delivery capability. If subscribing were keyed only
 * by wallet, anyone could subscribe THEIR browser against SOMEONE ELSE'S wallet
 * and receive that person's loan notifications. So the whole thing is gated by
 * an Ed25519 signature from the wallet itself, using the same signed-envelope
 * pattern as /api/v1/withdraw and site-limit-close: action-bound header,
 * freshness window, one-shot nonce, per-signer rate limit.
 *
 * The subtle part: the signed message MUST COMMIT TO THE SUBSCRIPTION. A
 * signature that only says "let me subscribe" could be lifted from the wire and
 * replayed with the attacker's own endpoint attached. So the envelope carries a
 * SHA-256 of the endpoint, and the handler recomputes it from the submitted
 * body and rejects any mismatch. The signature therefore authorises exactly one
 * endpoint and nothing else.
 *
 * Unsubscribe is deliberately NOT signature-gated. Knowing the endpoint string
 * is already proof of possession of that browser's subscription, and making it
 * hard to STOP receiving notifications would be user-hostile. The worst an
 * attacker who somehow learns an endpoint can do is silence their own leak —
 * and the operator backstop still fires.
 */
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
// tweetnacl is CommonJS — named imports break under Node ESM in some
// environments. Default-import + destructure, same as site-limit-close.js.
import nacl from "tweetnacl";
const { sign: naclSign } = nacl;
import { query } from "../db/pool.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 5_000;
const MAGPIE_HEADER = "push-subscribe-v1";
/** Cap per user so a single wallet cannot bloat the table with endpoints. */
const MAX_SUBS_PER_USER = 10;

const lastAttemptBySigner = new Map();

function isValidPubkey(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      // Push endpoints are long but bounded; 16KB is generous.
      if (total > 16 * 1024) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function parseSignedMessage(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

export function endpointHash(endpoint) {
  return crypto.createHash("sha256").update(String(endpoint), "utf8").digest("hex");
}

/**
 * Validate a push subscription object from an untrusted body.
 * Returns {ok, sub} or {ok:false, error}.
 */
export function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") {
    return { ok: false, error: "missing_subscription" };
  }
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== "string" || endpoint.length < 20 || endpoint.length > 2048) {
    return { ok: false, error: "invalid_endpoint" };
  }
  // Only ever talk to a real push service over TLS. This is the one field that
  // makes the server issue an outbound request, so it must not be able to point
  // at an internal address (SSRF) or a non-HTTPS host.
  let u;
  try { u = new URL(endpoint); } catch { return { ok: false, error: "invalid_endpoint_url" }; }
  if (u.protocol !== "https:") return { ok: false, error: "endpoint_must_be_https" };
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(u.hostname)) {
    return { ok: false, error: "endpoint_host_not_allowed" };
  }
  if (!keys || typeof keys !== "object") return { ok: false, error: "missing_keys" };
  const { p256dh, auth } = keys;
  // Base64url public key material — bounded and character-checked so nothing
  // exotic reaches the crypto layer.
  const b64u = /^[A-Za-z0-9_-]+=*$/;
  if (typeof p256dh !== "string" || p256dh.length < 40 || p256dh.length > 200 || !b64u.test(p256dh)) {
    return { ok: false, error: "invalid_p256dh" };
  }
  if (typeof auth !== "string" || auth.length < 8 || auth.length > 100 || !b64u.test(auth)) {
    return { ok: false, error: "invalid_auth" };
  }
  return { ok: true, sub: { endpoint, p256dh, auth } };
}

/** GET /api/v1/push/vapid-public-key — public by design; it is a public key. */
export async function handleVapidPublicKey() {
  const key = process.env.VAPID_PUBLIC_KEY || "";
  return {
    status: 200,
    body: key ? { enabled: true, public_key: key } : { enabled: false },
  };
}

/** POST /api/v1/push/subscribe */
export async function handlePushSubscribe(req) {
  let body;
  try { body = await readJsonBody(req); }
  catch { return { status: 400, body: { ok: false, error: "invalid_body" } }; }

  const { signerPubkey, signature, signedMessageBase64, subscription } = body || {};

  if (!isValidPubkey(signerPubkey)) {
    return { status: 400, body: { ok: false, error: "invalid_signerPubkey" } };
  }
  const v = validateSubscription(subscription);
  if (!v.ok) return { status: 400, body: { ok: false, error: v.error } };

  let messageBytes, signatureBytes, signerPk;
  try {
    messageBytes = Buffer.from(String(signedMessageBase64 || ""), "base64");
    if (!messageBytes.length || messageBytes.length > 2048) throw new Error("size");
    signatureBytes = bs58decode(String(signature || ""));
    if (signatureBytes.length !== 64) throw new Error("siglen");
    signerPk = new PublicKey(signerPubkey);
  } catch {
    return { status: 400, body: { ok: false, error: "malformed_envelope" } };
  }

  const fields = parseSignedMessage(messageBytes.toString("utf-8"));

  if (fields.magpie !== MAGPIE_HEADER) {
    return { status: 400, body: { ok: false, error: "wrong_magpie_header" } };
  }
  if (fields.From !== signerPubkey) {
    return { status: 400, body: { ok: false, error: "from_signer_mismatch" } };
  }
  if (!fields.Nonce || !fields.IssuedAt) {
    return { status: 400, body: { ok: false, error: "missing_nonce_or_issuedat" } };
  }

  // THE BINDING. Without this the signature authorises "a subscription" rather
  // than "this subscription", and could be replayed with an attacker's endpoint.
  if (!fields.EndpointHash || fields.EndpointHash !== endpointHash(v.sub.endpoint)) {
    return { status: 400, body: { ok: false, error: "endpoint_hash_mismatch" } };
  }

  const issuedAt = Date.parse(fields.IssuedAt);
  if (!Number.isFinite(issuedAt)) {
    return { status: 400, body: { ok: false, error: "invalid_IssuedAt" } };
  }
  if (Math.abs(Date.now() - issuedAt) > FRESH_WINDOW_MS) {
    return { status: 400, body: { ok: false, error: "stale_signed_message" } };
  }

  const now = Date.now();
  const last = lastAttemptBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return { status: 429, body: { ok: false, error: "too_fast" } };
  }
  lastAttemptBySigner.set(signerPubkey, now);

  let sigOk = false;
  try { sigOk = naclSign.detached.verify(messageBytes, signatureBytes, signerPk.toBytes()); }
  catch { return { status: 400, body: { ok: false, error: "signature_verification_failed" } }; }
  if (!sigOk) return { status: 401, body: { ok: false, error: "signature_does_not_match" } };

  // One-shot nonce, same table and purpose-tagging as every other signed
  // endpoint, so a captured envelope cannot be replayed inside the window.
  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [String(fields.Nonce), `push:${MAGPIE_HEADER}`, signerPubkey],
    );
  } catch (err) {
    if (err.code === "23505") return { status: 409, body: { ok: false, error: "nonce_already_used" } };
    return { status: 500, body: { ok: false, error: "nonce_check_failed" } };
  }

  // Resolve the wallet to a user. No auto-bootstrap here: subscribing is not a
  // reason to create an account, and a wallet with no Magpie account has no
  // loans to be warned about.
  const { rows: [walletRow] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!walletRow) return { status: 404, body: { ok: false, error: "wallet_not_linked" } };

  const { rows: [{ n }] } = await query(
    `SELECT COUNT(*)::int AS n FROM push_subscriptions
      WHERE user_id = $1 AND revoked_at IS NULL AND endpoint <> $2`,
    [walletRow.user_id, v.sub.endpoint],
  );
  if (n >= MAX_SUBS_PER_USER) {
    return { status: 429, body: { ok: false, error: "too_many_subscriptions" } };
  }

  // Upsert on endpoint: re-subscribing the same browser must refresh the row,
  // never create a duplicate that would deliver the same warning twice. A
  // previously revoked endpoint coming back is un-revoked.
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, signer_wallet)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            signer_wallet = EXCLUDED.signer_wallet,
            revoked_at = NULL,
            revoked_reason = NULL,
            failure_count = 0`,
    [walletRow.user_id, v.sub.endpoint, v.sub.p256dh, v.sub.auth, signerPubkey],
  );

  return { status: 200, body: { ok: true, subscribed: true } };
}

/** POST /api/v1/push/unsubscribe — endpoint possession is sufficient. */
export async function handlePushUnsubscribe(req) {
  let body;
  try { body = await readJsonBody(req); }
  catch { return { status: 400, body: { ok: false, error: "invalid_body" } }; }

  const endpoint = body?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length < 20 || endpoint.length > 2048) {
    return { status: 400, body: { ok: false, error: "invalid_endpoint" } };
  }
  await query(
    `UPDATE push_subscriptions
        SET revoked_at = NOW(), revoked_reason = 'user unsubscribed'
      WHERE endpoint = $1 AND revoked_at IS NULL`,
    [endpoint],
  );
  // Always 200 — revealing whether an endpoint was registered would leak
  // information to anyone probing with guessed endpoints.
  return { status: 200, body: { ok: true } };
}
