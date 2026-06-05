/**
 * POST /api/v1/me/export
 *
 * Signed endpoint that returns a JSON dump of every piece of user data
 * we hold for the signing wallet's account: loans, support tickets +
 * AI replies, site withdrawals, referral earnings, holder rewards,
 * LP loyalty rewards, prefs, and auto-protect actions.
 *
 * All of this data is ALREADY accessible to the signer via the various
 * signed endpoints — the export is a convenience consolidation, not a
 * new disclosure surface. Same Ed25519 + nonce + freshness + lock-check
 * posture as the other signed endpoints.
 *
 * Used for: privacy transparency, account migration, compliance
 * (GDPR-style data access right). NOT a deletion endpoint — see
 * /api/v1/support/delete-ticket for per-ticket removal.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { rejectIfLocked } from "../services/site-lock.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 10_000; // export is heavy — slow path
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

export async function handleMeExport(req) {
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
  if (payload?.magpie !== "me/export/v1") {
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
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
    return { status: 429, body: { error: `Too fast — wait ${wait}s and try again` } };
  }
  lastBySigner.set(signerPubkey, now);

  let sigOk;
  try {
    sigOk = verifyEd25519(messageBytes, sigBytes, signerPk.toBytes());
  } catch (e) {
    console.warn("[me-export] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  const { rows: [linked] } = await query(
    `SELECT u.id, u.telegram_username, u.created_at, u.referred_by
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!linked) {
    return { status: 403, body: { error: "Signer wallet is not linked to a Magpie account" } };
  }
  const userId = linked.id;

  const lockResp = await rejectIfLocked(userId);
  if (lockResp) return lockResp;

  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "me_export", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  // Gather everything in parallel. Wallets list pulls pubkeys + sources;
  // secrets are NEVER included even though they're keyed to the same row.
  const [
    walletsRes,
    loansRes,
    ticketsRes,
    withdrawsRes,
    refsRes,
    holderRes,
    lpRes,
    apActionsRes,
    prefsRes,
  ] = await Promise.all([
    query(
      `SELECT id, public_key, source, is_active, created_at
         FROM wallets WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    query(
      `SELECT id, loan_id, loan_pda, collateral_mint, collateral_amount,
              loan_amount_lamports, original_loan_amount_lamports,
              ltv_percentage, duration_days, start_timestamp, due_timestamp,
              status, tx_signature, updated_at
         FROM loans WHERE user_id = $1 ORDER BY start_timestamp ASC`,
      [userId],
    ),
    query(
      `SELECT id, message, status, admin_reply, admin_replied_at,
              auto_resolved_at, last_user_followup_at, followup_count,
              closed_at, created_at
         FROM support_tickets WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    query(
      `SELECT id, signer_pubkey, from_pubkey, to_pubkey, asset,
              raw_amount::text AS raw_amount, decimals, tx_signature,
              status, error_text, created_at
         FROM site_withdrawals WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    query(
      `SELECT id, referee_user_id, loan_db_id, event_type,
              fee_lamports::text AS fee_lamports,
              reward_lamports::text AS reward_lamports,
              reward_bps, status, paid_tx_signature, created_at
         FROM referral_earnings WHERE referrer_user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    query(
      `SELECT mhr.id, mhr.wallet_address, mhr.reward_lamports::text AS reward_lamports,
              mhr.status, mhr.paid_tx_signature, mhr.created_at
         FROM magpie_holder_rewards mhr
         JOIN wallets w ON w.public_key = mhr.wallet_address
        WHERE w.user_id = $1
        ORDER BY mhr.created_at ASC`,
      [userId],
    ),
    query(
      `SELECT llr.id, llr.wallet_address, llr.reward_lamports::text AS reward_lamports,
              llr.status, llr.paid_tx_signature, llr.created_at
         FROM lp_loyalty_rewards llr
         JOIN wallets w ON w.public_key = llr.wallet_address
        WHERE w.user_id = $1
        ORDER BY llr.created_at ASC`,
      [userId],
    ),
    query(
      `SELECT id, loan_id, action_type, amount_lamports::text AS amount_lamports,
              health_before, health_after, signature, error, created_at
         FROM auto_protect_actions WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    ),
    query(
      `SELECT notify_deposits, notify_loan_warnings, notify_liquidations,
              notify_health, auto_repay, auto_protect, updated_at
         FROM user_prefs WHERE user_id = $1`,
      [userId],
    ),
  ]);

  return {
    status: 200,
    body: {
      generated_at: new Date().toISOString(),
      schema_version: "me/export/v1",
      account: {
        telegram_username: linked.telegram_username ? `@${linked.telegram_username}` : null,
        created_at: linked.created_at,
        referred_by_user_id: linked.referred_by,
      },
      wallets: walletsRes.rows,
      loans: loansRes.rows,
      support_tickets: ticketsRes.rows,
      site_withdrawals: withdrawsRes.rows,
      referral_earnings: refsRes.rows,
      holder_rewards: holderRes.rows,
      lp_loyalty_rewards: lpRes.rows,
      auto_protect_actions: apActionsRes.rows,
      prefs: prefsRes.rows[0] || null,
      _notes: [
        "This export contains every piece of personal data Magpie holds for your account.",
        "Wallet secrets are NEVER included — only public addresses.",
        "Telegram ID is intentionally omitted from this export to reduce identifiability of the dump file.",
      ],
    },
  };
}
