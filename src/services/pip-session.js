/**
 * Pip session tokens — sign once, chat for 24 hours.
 *
 * The signed-message-per-request model is great for actions that
 * move money (withdraw, set-active wallet, support delete) but
 * intolerable for chat. Every message popping a Phantom prompt
 * trains users to dismiss the chat entirely.
 *
 * Compromise: a per-wallet session token that authorizes the
 * "chat" scope ONLY. The user signs one "sign in to Pip" message
 * to mint the token. The token has a fixed 24-hour TTL and can't
 * be used for withdraw / wallets / prefs / etc — those still
 * require fresh Ed25519 signatures.
 *
 * Token format (HMAC-signed):
 *   base64url(payload).base64url(hmac_sha256(payload, secret))
 *
 * Payload (JSON):
 *   { pubkey, exp, scope, v }
 *
 * Secret: HMAC_SECRET env var (32+ random bytes). Falls back to a
 * derivative of WALLET_ENCRYPTION_KEY when present so the operator
 * doesn't need a new secret for this to work.
 */
import crypto from "node:crypto";

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h
const TOKEN_VERSION = 1;
const SCOPE_CHAT = "chat";

function getSecret() {
  const explicit = process.env.PIP_SESSION_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  // Derive from the wallet encryption key — already a 64-char hex
  // value the operator already manages. Hashing avoids reusing the
  // raw key for two purposes.
  const enc = process.env.WALLET_ENCRYPTION_KEY;
  if (enc && enc.length >= 32) {
    return crypto.createHash("sha256").update("pip-session::" + enc).digest("hex");
  }
  throw new Error("PIP_SESSION_SECRET (or WALLET_ENCRYPTION_KEY) not configured");
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function issueChatSession(pubkey) {
  if (!pubkey || typeof pubkey !== "string") {
    throw new Error("issueChatSession: pubkey required");
  }
  const payload = {
    pubkey,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    scope: SCOPE_CHAT,
    v: TOKEN_VERSION,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64url(payloadStr);
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(payloadB64)
    .digest();
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * Returns { ok: true, pubkey } on valid token, { ok: false, reason } otherwise.
 * Never throws — always returns a result object.
 */
export function verifyChatSession(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const [payloadB64, sigB64] = token.split(".", 2);
  let secret;
  try {
    secret = getSecret();
  } catch (e) {
    return { ok: false, reason: "no_secret" };
  }
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  let actualSig;
  try {
    actualSig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "malformed_sig" };
  }
  if (
    expectedSig.length !== actualSig.length ||
    !crypto.timingSafeEqual(expectedSig, actualSig)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed_payload" };
  }
  if (payload.v !== TOKEN_VERSION) return { ok: false, reason: "version" };
  if (payload.scope !== SCOPE_CHAT) return { ok: false, reason: "scope" };
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.pubkey !== "string" || !payload.pubkey) {
    return { ok: false, reason: "no_pubkey" };
  }
  return { ok: true, pubkey: payload.pubkey, exp: payload.exp };
}

export function sessionTtlSeconds() {
  return SESSION_TTL_SECONDS;
}
