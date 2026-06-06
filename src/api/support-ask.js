/**
 * POST /api/v1/support/ask
 *
 * Signed-message endpoint that lets a linked user manage their support
 * tickets from the site:
 *
 *   action = "open"       → create a new ticket + run the AI agent on it
 *   action = "follow_up"  → append a follow-up + re-run the AI agent
 *   action = "close"      → close the ticket
 *
 * Auth: same Ed25519 pattern as src/api/withdraw.js. The signer must
 * be a wallet present in `wallets` table — that links them to a TG
 * user_id, which is the only identity we use to scope the action.
 *
 * Signed payload is a JSON string (utf-8 bytes signed). Schema:
 *   {
 *     "magpie": "support/v1",
 *     "action": "open" | "follow_up" | "close",
 *     "ticketId": <number, required for follow_up + close>,
 *     "message": <string, required for open + follow_up>,
 *     "nonce": <hex string>,
 *     "issuedAt": <ISO8601>
 *   }
 *
 * Replay protection via `used_nonces`. Freshness ±5min. Per-signer
 * rate limit 20s. AI agent reuses the same chatWithAgent service the
 * TG bot uses, so behavior + safety filters + spend caps are unified.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { chatWithAgent, resetConversation, isAiSupportEnabled } from "../services/ai-support.js";
import { rejectIfLocked } from "../services/site-lock.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 20_000;
const MAX_MESSAGE_LEN = 4000;

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
      if (total > 32 * 1024) {
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

export async function handleSupportAsk(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;

  if (!isAiSupportEnabled()) {
    return {
      status: 503,
      body: { error: "AI agent is currently disabled — file a ticket on Telegram instead" },
    };
  }

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

  // ── Shape ──
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
    if (messageBytes.length === 0 || messageBytes.length > 8192) {
      throw new Error("size out of range");
    }
  } catch {
    return { status: 400, body: { error: "Invalid signedMessageBase64" } };
  }

  // ── Parse signed JSON payload ──
  let payload;
  try {
    payload = JSON.parse(messageBytes.toString("utf-8"));
  } catch {
    return { status: 400, body: { error: "Signed message is not valid JSON" } };
  }
  if (payload?.magpie !== "support/v1") {
    return { status: 400, body: { error: "Bad payload header — expected magpie='support/v1'" } };
  }
  const { action, ticketId, message, nonce, issuedAt } = payload;
  if (!nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing nonce or issuedAt" } };
  }
  if (!["open", "follow_up", "close"].includes(action)) {
    return { status: 400, body: { error: "Invalid action — must be open|follow_up|close" } };
  }
  if (action === "open" && (!message || typeof message !== "string")) {
    return { status: 400, body: { error: "'open' requires a non-empty message" } };
  }
  if (action === "follow_up" && (!message || typeof message !== "string" || !ticketId)) {
    return { status: 400, body: { error: "'follow_up' requires ticketId + message" } };
  }
  if (action === "close" && !ticketId) {
    return { status: 400, body: { error: "'close' requires ticketId" } };
  }
  if (message && message.length > MAX_MESSAGE_LEN) {
    return { status: 400, body: { error: `Message too long (max ${MAX_MESSAGE_LEN} chars)` } };
  }

  // ── Freshness ──
  const ts = Date.parse(issuedAt);
  if (!Number.isFinite(ts)) return { status: 400, body: { error: "Invalid issuedAt" } };
  const skew = Math.abs(Date.now() - ts);
  if (skew > FRESH_WINDOW_MS) {
    return { status: 400, body: { error: `Signed message is stale (${Math.round(skew / 1000)}s) — re-sign` } };
  }

  // ── Rate limit ──
  const now = Date.now();
  const last = lastBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
    return { status: 429, body: { error: `Too fast — wait ${wait}s` } };
  }
  lastBySigner.set(signerPubkey, now);

  // ── Signature ──
  let sigOk;
  try {
    sigOk = verifyEd25519(messageBytes, sigBytes, signerPk.toBytes());
  } catch (e) {
    console.warn("[support-ask] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  // ── Ownership: signer must be linked ──
  const { rows: [linked] } = await query(
    `SELECT u.id, u.telegram_username
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!linked) {
    return {
      status: 403,
      body: { error: "Signer wallet is not linked to a Magpie account" },
    };
  }
  const userId = linked.id;

  const lockResp = await rejectIfLocked(userId);
  if (lockResp) return lockResp;

  // ── Nonce one-shot ──
  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "support_ask", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  // ── Action dispatch ──
  if (action === "close") {
    const { rowCount } = await query(
      `UPDATE support_tickets
          SET status = 'closed', closed_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status != 'closed'`,
      [ticketId, userId],
    );
    if (rowCount === 0) {
      return {
        status: 404,
        body: { error: "Ticket not found, not yours, or already closed" },
      };
    }
    return { status: 200, body: { ok: true, action: "close", ticketId } };
  }

  // For open + follow_up we either create a row or append to one.
  let ticketRow;
  if (action === "open") {
    const { rows: [row] } = await query(
      `INSERT INTO support_tickets (user_id, message, status)
       VALUES ($1, $2, 'open')
       RETURNING id, message, status, created_at`,
      [userId, message],
    );
    ticketRow = row;
  } else {
    // follow_up — verify ownership + append
    const { rows: [t] } = await query(
      `UPDATE support_tickets
          SET status = 'open',
              message = COALESCE(message, '') || E'\n\n[follow-up ' || (followup_count + 1) || ']: ' || $2,
              last_user_followup_at = NOW(),
              followup_count = followup_count + 1,
              last_alerted_tier = NULL
        WHERE id = $1 AND user_id = $3
        RETURNING id, message, status, created_at, followup_count`,
      [ticketId, message, userId],
    );
    if (!t) {
      return { status: 404, body: { error: "Ticket not found or not yours" } };
    }
    ticketRow = t;
  }

  // ── Run AI agent on the message ──
  // Fresh conversation so the agent re-reads the user's current account
  // state with no chat-history bias from older sessions.
  try {
    await resetConversation(userId);
  } catch { /* non-critical */ }

  let aiResult;
  try {
    aiResult = await chatWithAgent(userId, message, {
      username: linked.telegram_username,
    });
  } catch (e) {
    console.error("[support-ask] AI error:", e.message);
    // Leave the ticket open so admin can pick it up; surface a soft error.
    return {
      status: 200,
      body: {
        ok: true,
        ticketId: ticketRow.id,
        action,
        ai_response: null,
        ai_error: "AI agent unavailable right now — team has been notified",
      },
    };
  }

  if (!aiResult?.text) {
    return {
      status: 200,
      body: {
        ok: true,
        ticketId: ticketRow.id,
        action,
        ai_response: null,
        ai_error: "AI agent returned no response — team will follow up",
      },
    };
  }

  // Store AI reply on the ticket so future viewers (TG /mytickets, the
  // site, future admin reviews) all see the same answer.
  await query(
    `UPDATE support_tickets
        SET status = 'awaiting_user',
            admin_reply = $2,
            admin_replied_at = NOW(),
            auto_resolved_at = NOW(),
            last_alerted_tier = NULL
      WHERE id = $1`,
    [ticketRow.id, "[auto-resolved by agent · via site]\n\n" + aiResult.text.slice(0, 4000)],
  );

  return {
    status: 200,
    body: {
      ok: true,
      ticketId: ticketRow.id,
      action,
      ai_response: aiResult.text,
      escalated_ticket_id: aiResult.escalated_ticket_id ?? null,
    },
  };
}
