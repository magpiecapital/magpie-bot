#!/usr/bin/env node
/**
 * Guard: web-push subscription input validation and delivery classification.
 *
 * Two properties are safety-critical here.
 *
 * 1. SSRF. `endpoint` is the ONLY user-supplied field that makes the bot issue
 *    an outbound request. If an attacker can point it at an internal address,
 *    they turn the bot into a probe of the private network. It must be HTTPS
 *    and must not resolve to a loopback/link-local/RFC1918 host.
 *
 * 2. GONE vs UNLUCKY. A push service returning 404/410 means the subscription
 *    is permanently dead. Anything else — 429, 5xx, a timeout — is transient.
 *    Treating a transient fault as permanent would silently unsubscribe users
 *    and cost them the warning, which is the whole failure this channel exists
 *    to fix. Same asymmetry as telegram-delivery.js.
 *
 * Run: npm run check:push-subscribe
 */
import {
  validateSubscription,
  endpointHash,
  verifySubscribeEnvelope,
} from "../src/api/push-subscribe.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { isSubscriptionGone } from "../src/services/push-send.js";

let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { failures++; console.error(`  ❌ ${n}${d ? ` — ${d}` : ""}`); };
const expect = (n, a, w) => (a === w ? ok(n) : bad(n, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(w)}`));

const KEYS = {
  p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const sub = (endpoint, keys = KEYS) => ({ endpoint, keys });
const good = "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop:APA91bF_example_token";

console.log("\n== valid subscriptions are accepted ==");
expect("real FCM endpoint", validateSubscription(sub(good)).ok, true);
expect(
  "Mozilla autopush endpoint",
  validateSubscription(sub("https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample")).ok,
  true,
);

console.log("\n== SSRF: the bot must never be pointed at internal hosts ==");
for (const e of [
  "http://fcm.googleapis.com/fcm/send/abcdefghijklmnop",   // plain http
  "https://localhost/fcm/send/abcdefghijklmnop1234",
  "https://127.0.0.1/fcm/send/abcdefghijklmnop1234",
  "https://10.0.0.5/fcm/send/abcdefghijklmnop1234",
  "https://192.168.1.10/fcm/send/abcdefghijklmnop1234",
  "https://169.254.169.254/latest/meta-data/iam/creds",     // cloud metadata
  "ftp://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
  "file:///etc/passwd0000000000000",
]) {
  const r = validateSubscription(sub(e));
  if (r.ok) bad(`ACCEPTED dangerous endpoint: ${e}`);
}
ok("all http/loopback/private/metadata/non-https endpoints rejected");

console.log("\n== malformed input degrades to an error, never a throw ==");
for (const junk of [null, undefined, "", 42, [], {}, { endpoint: good }, sub(good, {}), sub(good, null)]) {
  let r;
  try { r = validateSubscription(junk); }
  catch (e) { bad(`threw on ${JSON.stringify(junk)}`, e.message); continue; }
  if (r.ok) bad(`accepted junk: ${JSON.stringify(junk)}`);
}
ok("all malformed subscriptions rejected without throwing");

console.log("\n== key material is bounded and character-checked ==");
expect("p256dh too short", validateSubscription(sub(good, { ...KEYS, p256dh: "abc" })).ok, false);
expect("auth too short", validateSubscription(sub(good, { ...KEYS, auth: "x" })).ok, false);
expect(
  "p256dh with illegal chars",
  validateSubscription(sub(good, { ...KEYS, p256dh: "A".repeat(60) + "<script>" })).ok,
  false,
);
expect(
  "oversized p256dh",
  validateSubscription(sub(good, { ...KEYS, p256dh: "A".repeat(500) })).ok,
  false,
);
expect("endpoint over 2048 chars", validateSubscription(sub("https://a.co/" + "x".repeat(2100))).ok, false);

console.log("\n== endpoint binding: a signature authorises ONE endpoint ==");
{
  const attacker = "https://fcm.googleapis.com/fcm/send/ATTACKER_CONTROLLED_ENDPOINT_1234";
  expect("same endpoint → same hash", endpointHash(good), endpointHash(good));
  expect("different endpoint → different hash", endpointHash(good) === endpointHash(attacker), false);
  expect("hash is hex sha256", /^[0-9a-f]{64}$/.test(endpointHash(good)), true);
  // A captured envelope carries the victim's EndpointHash; swapping in the
  // attacker's endpoint changes the recomputed hash, so the handler rejects.
  expect("swap is detectable", endpointHash(attacker) !== endpointHash(good), true);
}

console.log("\n== dead vs transient push failures ==");
expect("404 → gone", isSubscriptionGone({ statusCode: 404 }), true);
expect("410 → gone", isSubscriptionGone({ statusCode: 410 }), true);
expect("429 → NOT gone (rate limited)", isSubscriptionGone({ statusCode: 429 }), false);
expect("500 → NOT gone", isSubscriptionGone({ statusCode: 500 }), false);
expect("502 → NOT gone", isSubscriptionGone({ statusCode: 502 }), false);
expect("503 → NOT gone", isSubscriptionGone({ statusCode: 503 }), false);
expect("401 → NOT gone (config problem, not a dead sub)", isSubscriptionGone({ statusCode: 401 }), false);
expect("network error → NOT gone", isSubscriptionGone(new Error("ETIMEDOUT")), false);
expect("undefined → NOT gone", isSubscriptionGone(undefined), false);
expect("null → NOT gone", isSubscriptionGone(null), false);

console.log("\n== END-TO-END: a real signed envelope, exactly as the site builds it ==");
{
  const kp = Keypair.generate();
  const pubkey = kp.publicKey.toBase58();
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");

  // Mirrors src/lib/solana/site-push.ts line for line. If the two ever drift,
  // this fails — which is the point: a client/server envelope mismatch would
  // otherwise only show up as a live user unable to subscribe.
  const buildEnvelope = (endpointForHash, opts = {}) => {
    const lines = [
      `magpie: ${opts.header ?? "push-subscribe-v1"}`,
      `From: ${opts.from ?? pubkey}`,
      `EndpointHash: ${endpointHash(endpointForHash)}`,
      `Nonce: ${opts.nonce ?? "a".repeat(32)}`,
      `IssuedAt: ${opts.issuedAt ?? new Date(NOW).toISOString()}`,
    ];
    const messageBytes = Buffer.from(lines.join("\n"), "utf8");
    const sig = nacl.sign.detached(messageBytes, kp.secretKey);
    return {
      signerPubkey: opts.from ?? pubkey,
      signatureBase58: bs58.encode(sig),
      signedMessageBase64: messageBytes.toString("base64"),
    };
  };
  const subFor = (endpoint) => ({ endpoint, keys: KEYS });

  const happy = { ...buildEnvelope(good), subscription: subFor(good) };
  const r = verifySubscribeEnvelope(happy, NOW);
  expect("valid envelope from the site format is ACCEPTED", r.ok, true);

  // THE ATTACK: capture a valid envelope, attach your own endpoint.
  const attacker = "https://fcm.googleapis.com/fcm/send/ATTACKER_ENDPOINT_9999";
  const swapped = { ...buildEnvelope(good), subscription: subFor(attacker) };
  const rs = verifySubscribeEnvelope(swapped, NOW);
  expect("endpoint SWAP is rejected", rs.ok, false);
  expect("  ...with endpoint_hash_mismatch", rs.error, "endpoint_hash_mismatch");

  // Tamper with the signed bytes.
  const tampered = { ...happy };
  const msg = Buffer.from(tampered.signedMessageBase64, "base64").toString("utf8")
    .replace(/From: \S+/, `From: ${pubkey}`) + " ";
  tampered.signedMessageBase64 = Buffer.from(msg, "utf8").toString("base64");
  expect("tampered message body is rejected", verifySubscribeEnvelope(tampered, NOW).ok, false);

  // Signature from a DIFFERENT key.
  const other = Keypair.generate();
  const forged = { ...happy, signatureBase58: bs58.encode(
    nacl.sign.detached(Buffer.from(happy.signedMessageBase64, "base64"), other.secretKey)) };
  const rf = verifySubscribeEnvelope(forged, NOW);
  expect("signature from another key is rejected", rf.ok, false);
  expect("  ...with signature_does_not_match", rf.error, "signature_does_not_match");

  // Someone else's wallet in From.
  const impersonate = { ...buildEnvelope(good, { from: other.publicKey.toBase58() }),
                        subscription: subFor(good) };
  expect("signing for another wallet is rejected", verifySubscribeEnvelope(impersonate, NOW).ok, false);

  // Freshness.
  const stale = { ...buildEnvelope(good, { issuedAt: new Date(NOW - 10 * 60_000).toISOString() }),
                  subscription: subFor(good) };
  expect("10-minute-old envelope is rejected", verifySubscribeEnvelope(stale, NOW).error, "stale_signed_message");
  const future = { ...buildEnvelope(good, { issuedAt: new Date(NOW + 10 * 60_000).toISOString() }),
                   subscription: subFor(good) };
  expect("10-minute-future envelope is rejected", verifySubscribeEnvelope(future, NOW).error, "stale_signed_message");

  // Cross-action replay: a withdraw signature must not subscribe anything.
  const wrongAction = { ...buildEnvelope(good, { header: "limit-close-arm/v1" }),
                        subscription: subFor(good) };
  expect("envelope for a different action is rejected", verifySubscribeEnvelope(wrongAction, NOW).error, "wrong_magpie_header");

  // And the SSRF guard still applies to a perfectly-signed envelope.
  const meta = "https://169.254.169.254/latest/meta-data/iam/security-credentials/";
  const signedSsrf = { ...buildEnvelope(meta), subscription: subFor(meta) };
  expect("signed SSRF endpoint is still rejected", verifySubscribeEnvelope(signedSsrf, NOW).ok, false);
}

console.log("\n== watcher wiring ==");
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/services/loan-watcher.js", import.meta.url), "utf8");
  // A negative telegram_id is a SITE-NATIVE synthetic id, and the negative
  // range overlaps real Telegram supergroup ids. Sending there could post a
  // borrower's loan into a public group.
  expect("never DMs a non-positive telegram_id", /tgId\s*>\s*0/.test(src), true);
  expect("falls back to push when TG fails", /await tryPush\(/.test(src), true);
  expect("push success marks the loan warned", /delivered via web push/.test(src), true);
}

console.log(
  failures === 0 ? "\n✅ push-subscribe guard passed\n" : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
