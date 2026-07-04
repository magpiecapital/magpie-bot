/**
 * POST /api/v1/referral/set-code — signed vanity-referral-code setter.
 *
 * Lets a site user (Magpie Dashboard) claim a custom referral nickname the
 * same way support/set-active work: they sign a small JSON payload with their
 * connected wallet, we verify the ed25519 signature, resolve the wallet → user,
 * and set the code (validation/uniqueness/cooldown enforced in setCustomCode).
 *
 * Body: { signedMessageBase64, signatureBase58, signerPubkey }
 *   signed payload = { magpie:"referral/set-code/v1", code, nonce, issuedAt }
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { setCustomCode } from "../services/referrals.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 3_000;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lastBySigner = new Map();

function verifyEd25519(messageBytes, signatureBytes, pubkeyBytes) {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyBytes)]);
  const keyObject = createPublicKey({ key: der, format: "der", type: "spki" });
  return cryptoVerify(null, messageBytes, keyObject, signatureBytes);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 16 * 1024) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export async function handleReferralSetCode(req) {
  const disabled = await rejectIfSiteDisabled?.().catch(() => null);
  if (disabled) return disabled;

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return { status: 400, body: { error: `Invalid body: ${e.message}` } }; }

  const { signedMessageBase64, signatureBase58, signerPubkey } = body || {};
  if (!signedMessageBase64 || !signatureBase58 || !signerPubkey) {
    return { status: 400, body: { error: "Missing signedMessageBase64, signatureBase58, or signerPubkey" } };
  }

  let signerPk;
  try { signerPk = new PublicKey(signerPubkey); }
  catch { return { status: 400, body: { error: "Invalid signerPubkey" } }; }

  let sigBytes;
  try { sigBytes = bs58decode(signatureBase58); if (sigBytes.length !== 64) throw new Error("len"); }
  catch { return { status: 400, body: { error: "Invalid signatureBase58" } }; }

  let messageBytes;
  try {
    messageBytes = Buffer.from(signedMessageBase64, "base64");
    if (messageBytes.length === 0 || messageBytes.length > 2048) throw new Error("size");
  } catch { return { status: 400, body: { error: "Invalid signedMessageBase64" } }; }

  let payload;
  try { payload = JSON.parse(messageBytes.toString("utf-8")); }
  catch { return { status: 400, body: { error: "Signed message is not valid JSON" } }; }
  if (payload?.magpie !== "referral/set-code/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { code, nonce, issuedAt } = payload;
  if (!code || !nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing code, nonce, or issuedAt" } };
  }

  const ts = Date.parse(issuedAt);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESH_WINDOW_MS) {
    return { status: 400, body: { error: "Signed message is stale — re-sign" } };
  }

  const now = Date.now();
  const last = lastBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) return { status: 429, body: { error: "Too fast — wait a moment" } };
  lastBySigner.set(signerPubkey, now);

  let sigOk;
  try { sigOk = verifyEd25519(messageBytes, sigBytes, signerPk.toBytes()); }
  catch { return { status: 400, body: { error: "Signature verification failed" } }; }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  // Resolve the signer wallet → its Magpie user.
  const { rows: [w] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!w?.user_id) {
    return { status: 404, body: { error: "no_account", detail: "This wallet isn't linked to a Magpie account yet. Open the Telegram bot once, or connect on the dashboard, then retry." } };
  }

  const result = await setCustomCode(w.user_id, code);
  if (!result.ok) return { status: 400, body: { error: "invalid_code", detail: result.reason } };
  return { status: 200, body: { ok: true, code: result.code } };
}
