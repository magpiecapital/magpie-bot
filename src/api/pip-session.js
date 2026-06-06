/**
 * POST /api/v1/auth/pip-session
 *
 * Mint a 24-hour chat-only session token from a signed Phantom
 * message. The site signs ONE message ("Sign in to Pip — Magpie's
 * AI agent. Token expires in 24h.") and gets back a Bearer token
 * it can use on every subsequent /api/v1/ai/chat call without
 * triggering Phantom again.
 *
 * Security gates mirror the other signed endpoints:
 *   - Ed25519 signature verified against the signer pubkey
 *   - Domain-separated payload header (pip-session/v1)
 *   - ±5 min freshness window
 *   - One-shot nonce
 *   - Per-signer rate limit (60s between signin attempts)
 *   - Signer must be a linked wallet
 *   - Site kill-switch + global disable both honored
 *
 * The minted token authorizes the "chat" scope ONLY — it can never
 * be used to withdraw, change wallets, delete tickets, etc. Those
 * keep their per-action signature requirement.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { rejectIfLocked } from "../services/site-lock.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";
import { issueChatSession, sessionTtlSeconds } from "../services/pip-session.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
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
      if (total > 16 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function handlePipSession(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return { status: 400, body: { error: `Invalid body: ${e.message}` } };
  }
  const { signedMessageBase64, signatureBase58, signerPubkey } = body || {};
  if (!signedMessageBase64 || !signatureBase58 || !signerPubkey) {
    return {
      status: 400,
      body: { error: "Missing signedMessageBase64, signatureBase58, or signerPubkey" },
    };
  }

  let signerPk;
  try {
    signerPk = new PublicKey(signerPubkey);
  } catch {
    return { status: 400, body: { error: "Invalid signerPubkey" } };
  }
  let sigBytes;
  try {
    sigBytes = bs58decode(signatureBase58);
    if (sigBytes.length !== 64) throw new Error("bad length");
  } catch {
    return { status: 400, body: { error: "Invalid signatureBase58" } };
  }
  let messageBytes;
  try {
    messageBytes = Buffer.from(signedMessageBase64, "base64");
    if (messageBytes.length === 0 || messageBytes.length > 1024) throw new Error("size");
  } catch {
    return { status: 400, body: { error: "Invalid signedMessageBase64" } };
  }

  let payload;
  try {
    payload = JSON.parse(messageBytes.toString("utf-8"));
  } catch {
    return { status: 400, body: { error: "Signed message is not valid JSON" } };
  }
  if (payload?.magpie !== "pip-session/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { nonce, issuedAt } = payload;
  if (!nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing nonce or issuedAt" } };
  }
  const ts = Date.parse(issuedAt);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESH_WINDOW_MS) {
    return { status: 400, body: { error: "Signed message is stale — re-sign" } };
  }
  const now = Date.now();
  const last = lastBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return { status: 429, body: { error: "Too fast — wait a moment" } };
  }
  lastBySigner.set(signerPubkey, now);

  let sigOk;
  try {
    sigOk = verifyEd25519(messageBytes, sigBytes, signerPk.toBytes());
  } catch (e) {
    console.warn("[pip-session] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  const { rows: [linked] } = await query(
    `SELECT u.id FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!linked) {
    return { status: 403, body: { error: "Signer wallet is not linked to a Magpie account" } };
  }
  const lockResp = await rejectIfLocked(linked.id);
  if (lockResp) return lockResp;

  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "pip_session", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  const token = issueChatSession(signerPubkey);
  return {
    status: 200,
    body: {
      ok: true,
      token,
      expires_in_seconds: sessionTtlSeconds(),
    },
  };
}
