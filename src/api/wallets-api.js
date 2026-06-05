/**
 * Site wallets endpoints.
 *
 *   GET  /api/v1/wallets?wallet=<linked-pubkey>
 *     Returns the wallets list for the user owning the queried wallet:
 *     id, public_key, source ('custodial' | 'imported' | 'site-link'),
 *     label, is_active, created_at. No secrets ever leak.
 *
 *   POST /api/v1/wallets/set-active
 *     Signed action. Switches the user's active custodial wallet.
 *     Same auth posture as withdraw / support-ask: signer must be a
 *     linked wallet for the same user, one-shot nonce, freshness window.
 *     Source 'site-link' wallets (the user's external Phantom) can NOT
 *     be set active — the active wallet is the one whose secret the
 *     server holds (custodial / imported). External wallets are
 *     view-only; they sign their own txs via Phantom.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 5_000;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lastBySigner = new Map();

function isValidPubkey(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

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

export async function handleWalletsList(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }
  const { rows: [linked] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [wallet],
  );
  if (!linked) {
    return { status: 200, body: { linked: false, wallets: [] } };
  }

  const { rows } = await query(
    `SELECT id, public_key, source, label, is_active, created_at
       FROM wallets
      WHERE user_id = $1
      ORDER BY is_active DESC, created_at ASC`,
    [linked.user_id],
  );

  return {
    status: 200,
    body: {
      linked: true,
      wallets: rows.map((r) => ({
        id: r.id,
        public_key: r.public_key,
        source: r.source,
        label: r.label,
        is_active: r.is_active,
        // The server holds keys for custodial + imported; site-link is
        // the user's external Phantom and signs its own txs.
        managed: r.source !== "site-link",
        created_at: r.created_at,
      })),
    },
  };
}

export async function handleWalletsSetActive(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

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
    if (messageBytes.length === 0 || messageBytes.length > 2048) {
      throw new Error("size out of range");
    }
  } catch {
    return { status: 400, body: { error: "Invalid signedMessageBase64" } };
  }

  let payload;
  try {
    payload = JSON.parse(messageBytes.toString("utf-8"));
  } catch {
    return { status: 400, body: { error: "Signed message is not valid JSON" } };
  }
  if (payload?.magpie !== "wallets/set-active/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { targetPubkey, nonce, issuedAt } = payload;
  if (!targetPubkey || !nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing targetPubkey, nonce, or issuedAt" } };
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
    console.warn("[wallets-set-active] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  // Both signer and target must belong to the SAME user. We do this with
  // one JOIN rather than two roundtrips so there's no TOCTOU window.
  const { rows: [match] } = await query(
    `SELECT signer.user_id AS user_id,
            target.id AS target_id, target.source AS target_source
       FROM wallets signer
       JOIN wallets target ON target.user_id = signer.user_id
      WHERE signer.public_key = $1 AND target.public_key = $2
      LIMIT 1`,
    [signerPubkey, targetPubkey],
  );
  if (!match) {
    return {
      status: 403,
      body: { error: "Target wallet doesn't exist or isn't part of your account" },
    };
  }
  if (match.target_source === "site-link") {
    return {
      status: 400,
      body: { error: "Externally-held wallets can't be set as active — only custodial wallets the server signs for" },
    };
  }

  // Nonce one-shot.
  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "wallets_set_active", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  // Flip active flag inside a transaction so we never have zero or two
  // active rows for the user.
  await query("BEGIN");
  try {
    await query(`UPDATE wallets SET is_active = FALSE WHERE user_id = $1`, [match.user_id]);
    await query(`UPDATE wallets SET is_active = TRUE  WHERE id = $1`, [match.target_id]);
    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    throw e;
  }

  return { status: 200, body: { ok: true, active_wallet: targetPubkey } };
}
