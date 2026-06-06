/**
 * Site prefs endpoints.
 *
 *   GET  /api/v1/prefs?wallet=<linked-pubkey>
 *     Returns the user's notification + auto-protect prefs, plus the
 *     last 5 auto-protect actions so the site can render the same
 *     "recent activity" feed the TG /autoprotect view shows.
 *
 *   POST /api/v1/prefs/set
 *     Signed JSON action to set a single pref to true/false. Allowed
 *     keys are hard-coded in PREF_KEYS — no arbitrary column writes.
 *
 * Same auth posture as the other signed endpoints (withdraw,
 * support-ask, wallets/set-active).
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { getPrefs } from "../services/prefs.js";
import { alertPrefChanged } from "../services/security-alerts.js";
import { rejectIfLocked, getSiteLock } from "../services/site-lock.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 2_000;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lastBySigner = new Map();

// Allowlist of prefs the site can write. Mirrors DEFAULTS in
// src/services/prefs.js — any new pref must be added here explicitly.
const PREF_KEYS = new Set([
  "auto_protect",
  "auto_repay",
  "notify_deposits",
  "notify_loan_warnings",
  "notify_liquidations",
  "notify_health",
]);

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

export async function handlePrefsList(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }
  const { rows: [u] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [wallet],
  );
  if (!u) {
    return { status: 200, body: { linked: false, prefs: null, recent_actions: [] } };
  }

  const [prefs, lock, actionsRes] = await Promise.all([
    getPrefs(u.user_id),
    getSiteLock(u.user_id),
    query(
      `SELECT action_type, amount_lamports::text AS amount_lamports,
              health_before, health_after, signature, loan_id, created_at
         FROM auto_protect_actions
        WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
        ORDER BY created_at DESC
        LIMIT 5`,
      [u.user_id],
    ),
  ]);

  return {
    status: 200,
    body: {
      linked: true,
      prefs: {
        auto_protect: !!prefs.auto_protect,
        auto_repay: !!prefs.auto_repay,
        notify_deposits: !!prefs.notify_deposits,
        notify_loan_warnings: !!prefs.notify_loan_warnings,
        notify_liquidations: !!prefs.notify_liquidations,
        notify_health: !!prefs.notify_health,
      },
      site_lock: {
        locked: lock.locked,
        until: lock.until ? lock.until.toISOString() : null,
      },
      recent_actions: actionsRes.rows,
    },
  };
}

export async function handlePrefsSet(req) {
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
    if (messageBytes.length === 0 || messageBytes.length > 1024) {
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
  if (payload?.magpie !== "prefs/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { key, value, nonce, issuedAt } = payload;
  if (!PREF_KEYS.has(key)) {
    return { status: 400, body: { error: "Unknown pref key" } };
  }
  if (typeof value !== "boolean") {
    return { status: 400, body: { error: "value must be true or false" } };
  }
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
    console.warn("[prefs-set] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  const { rows: [linked] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!linked) {
    return { status: 403, body: { error: "Signer wallet is not linked to a Magpie account" } };
  }
  const userId = linked.user_id;

  const lockResp = await rejectIfLocked(userId);
  if (lockResp) return lockResp;

  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "prefs_set", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  // Ensure row exists (mirrors prefs.js togglePref), then set the exact
  // value rather than toggling — avoids drift if the UI shows a stale
  // state.
  await getPrefs(userId);
  // key is from PREF_KEYS allowlist so it's safe to inline into SQL
  await query(
    `UPDATE user_prefs SET ${key} = $2, updated_at = NOW() WHERE user_id = $1`,
    [userId, value],
  );

  alertPrefChanged({ userId, key, value }).catch(() => {});

  return { status: 200, body: { ok: true, key, value } };
}
