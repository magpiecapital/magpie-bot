/**
 * x-poster.js — minimal, dependency-free OAuth 1.0a client for POSTING
 * tweets to @MagpieLoans via the X API v2 (POST /2/tweets).
 *
 * WHY OAuth 1.0a (not the existing X_BEARER_TOKEN): a bearer token is
 * app-only and can READ the timeline but CANNOT post on a user's behalf.
 * Posting requires user-context auth. OAuth 1.0a (consumer key/secret +
 * access token/secret) is the simplest server-to-server option and needs
 * no extra dependency — we sign with Node's built-in crypto (HMAC-SHA1).
 *
 * PROVISIONING (operator, at developer.x.com → the @MagpieLoans app, with
 * "Read and write" permission, then regenerate the access token AFTER
 * enabling write): set four Railway variables on magpie-bot:
 *     X_API_KEY         (consumer/api key)
 *     X_API_SECRET      (consumer/api secret)
 *     X_ACCESS_TOKEN    (access token, write-enabled)
 *     X_ACCESS_SECRET   (access token secret)
 *
 * With any of the four missing, postTweet() is a safe no-op (logs the text
 * it WOULD have posted, returns {ok:false, skipped:true}) — so every caller
 * works before the creds exist and the announcer still seeds its state.
 *
 * SECURITY: secrets are read from env per-call and are NEVER logged or
 * returned. The signing key + signature are local. No secret crosses a log
 * line or the function boundary.
 */
import crypto from "node:crypto";

function creds() {
  return {
    apiKey: process.env.X_API_KEY || "",
    apiSecret: process.env.X_API_SECRET || "",
    accessToken: process.env.X_ACCESS_TOKEN || "",
    accessSecret: process.env.X_ACCESS_SECRET || "",
  };
}

export function xPosterConfigured() {
  const c = creds();
  return !!(c.apiKey && c.apiSecret && c.accessToken && c.accessSecret);
}

/** RFC-3986 percent-encoding (encodeURIComponent + the four reserved chars). */
function pctEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build the OAuth 1.0a Authorization header for a request. For POST
 * /2/tweets the body is JSON (application/json), which per the OAuth spec
 * does NOT contribute to the signature base string — only the oauth_*
 * params do. (Form-encoded bodies would; JSON ones don't.)
 */
function buildOAuthHeader(method, url, c) {
  const oauth = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(oauth)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(oauth[k])}`)
    .join("&");
  const baseStr = [
    method.toUpperCase(),
    pctEncode(url),
    pctEncode(paramStr),
  ].join("&");
  const signingKey = `${pctEncode(c.apiSecret)}&${pctEncode(c.accessSecret)}`;
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseStr)
    .digest("base64");
  const headerParams = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(headerParams[k])}"`)
      .join(", ")
  );
}

/**
 * Post a tweet. Returns {ok, tweetId} on success, {ok:false, skipped:true}
 * if creds are absent, {ok:false, status} on an API error. Never throws —
 * a failed post must never break the caller's worker loop.
 */
export async function postTweet(text) {
  const c = creds();
  if (!(c.apiKey && c.apiSecret && c.accessToken && c.accessSecret)) {
    console.log(`[x-poster] skipped (X OAuth creds not set) — would post: ${String(text).slice(0, 80).replace(/\n/g, " ")}`);
    return { ok: false, skipped: true };
  }
  // Hard cap to the tweet limit so an over-long compose can never 403.
  const body = { text: String(text).slice(0, 280) };
  const url = "https://api.twitter.com/2/tweets";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: buildOAuthHeader("POST", url, c),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[x-poster] POST /2/tweets failed ${res.status}: ${errText.slice(0, 180)}`);
      return { ok: false, status: res.status };
    }
    const json = await res.json().catch(() => ({}));
    const tweetId = json?.data?.id ?? null;
    console.log(`[x-poster] posted tweet ${tweetId ?? "(no id)"}`);
    return { ok: true, tweetId };
  } catch (err) {
    console.warn(`[x-poster] post threw: ${err.message?.slice(0, 140)}`);
    return { ok: false, error: true };
  }
}
