/**
 * POST /api/v1/ai/chat
 *
 * Signed-message endpoint that runs the AI agent on a user message and
 * returns the response — WITHOUT creating a support ticket. Use for
 * ephemeral Q&A on the site (the floating chat widget).
 *
 * Same Ed25519 + nonce + freshness auth as the other signed endpoints.
 * Spend caps + PII filters live inside chatWithAgent; the same daily
 * usd-cap stops runaway costs across TG, site tickets, and site chat
 * uniformly.
 *
 * The agent's conversation memory IS preserved across calls (keyed on
 * user_id), so the user can have a multi-turn conversation. Resetting
 * is the user's job — they reload or hit a Reset button which sends
 * action='reset'.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { chatWithAgent, resetConversation, isAiSupportEnabled } from "../services/ai-support.js";
import { rejectIfLocked } from "../services/site-lock.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";
import { preflightAiChat } from "../services/ai-chat-gate.js";
import { verifyChatSession } from "../services/pip-session.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 4_000;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lastBySigner = new Map();

const MAX_MESSAGE_LEN = 3000;

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

/**
 * Run the chat for a pre-authenticated user (Bearer-token path).
 * Pubkey trust comes from a verified Pip session token — no per-
 * message signature, no nonce. Lock check + cost gate still apply.
 */
async function runChatForUser({ signerPubkey, action, message, pageContext }) {
  const { rows: [linked] } = await query(
    `SELECT u.id, u.telegram_username
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!linked) {
    return { status: 403, body: { error: "Session wallet is not linked to a Magpie account" } };
  }

  const lockResp = await rejectIfLocked(linked.id);
  if (lockResp) return lockResp;

  if ((action || "chat") === "reset") {
    try {
      await resetConversation(linked.id);
    } catch (e) {
      console.warn("[ai-chat] reset failed:", e.message);
    }
    return { status: 200, body: { ok: true, action: "reset" } };
  }

  try {
    const gate = await preflightAiChat({ userId: linked.id, message });
    if (!gate.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          action: "chat",
          response: gate.response,
          gated: gate.reason,
        },
      };
    }
  } catch (e) {
    console.warn("[ai-chat] gate error, proceeding anyway:", e.message);
  }

  const finalMessage = pageContext
    ? `(User is currently on the page: ${String(pageContext).slice(0, 64)})\n\n${message}`
    : message;

  let result;
  try {
    result = await chatWithAgent(linked.id, finalMessage, {
      username: linked.telegram_username,
    });
  } catch (e) {
    console.error("[ai-chat] agent error:", e.message);
    return { status: 500, body: { error: "AI agent error", detail: e.message?.slice(0, 200) } };
  }
  if (!result?.text) {
    return { status: 500, body: { error: "AI agent returned no response" } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: "chat",
      response: result.text,
      blocked_reason: result.blocked_reason ?? null,
      spend_capped: result.spend_capped ?? false,
      escalated_ticket_id: result.escalated_ticket_id ?? null,
    },
  };
}

export async function handleAiChat(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;

  if (!isAiSupportEnabled()) {
    return { status: 503, body: { error: "AI agent is currently disabled" } };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return { status: 400, body: { error: `Invalid body: ${e.message}` } };
  }

  // Bearer-token path: if the client presents a valid Pip session
  // token, we skip the per-message signature dance entirely. Token
  // is bound to the wallet's pubkey, scope="chat", 24h TTL.
  const authHeader = (req.headers["authorization"] || req.headers["Authorization"] || "").toString();
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  let signerPubkeyFromToken = null;

  if (bearerToken) {
    const verified = verifyChatSession(bearerToken);
    if (!verified.ok) {
      return {
        status: 401,
        body: { error: "Invalid or expired Pip session", reason: verified.reason },
      };
    }
    signerPubkeyFromToken = verified.pubkey;
    // Bearer mode: jump straight to per-user gates + chat. Validates
    // action + message from body (no signature wrapper here).
    const { action, message: bodyMessage, page_context } = body || {};
    if ((action || "chat") === "chat") {
      if (!bodyMessage || typeof bodyMessage !== "string" || bodyMessage.length > MAX_MESSAGE_LEN) {
        return { status: 400, body: { error: `Message missing or too long` } };
      }
    }
    return await runChatForUser({
      signerPubkey: signerPubkeyFromToken,
      action: action || "chat",
      message: bodyMessage,
      pageContext: page_context,
    });
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
    if (messageBytes.length === 0 || messageBytes.length > 8192) {
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
  if (payload?.magpie !== "ai-chat/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { action, message, nonce, issuedAt, page_context } = payload;
  if (!nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing nonce or issuedAt" } };
  }
  if (!["chat", "reset"].includes(action || "chat")) {
    return { status: 400, body: { error: "Invalid action" } };
  }
  if ((action || "chat") === "chat") {
    if (!message || typeof message !== "string") {
      return { status: 400, body: { error: "'chat' requires a non-empty message" } };
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return { status: 400, body: { error: `Message too long (max ${MAX_MESSAGE_LEN} chars)` } };
    }
  }

  const ts = Date.parse(issuedAt);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESH_WINDOW_MS) {
    return { status: 400, body: { error: "Signed message is stale — re-sign" } };
  }
  const now = Date.now();
  const last = lastBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
    return { status: 429, body: { error: `Too fast — wait ${wait}s` } };
  }
  lastBySigner.set(signerPubkey, now);

  let sigOk;
  try {
    sigOk = verifyEd25519(messageBytes, sigBytes, signerPk.toBytes());
  } catch (e) {
    console.warn("[ai-chat] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  const { rows: [linked] } = await query(
    `SELECT u.id, u.telegram_username
       FROM wallets w JOIN users u ON u.id = w.user_id
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
      [nonce, "ai_chat", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  if ((action || "chat") === "reset") {
    try {
      await resetConversation(linked.id);
    } catch (e) {
      console.warn("[ai-chat] reset failed:", e.message);
    }
    return { status: 200, body: { ok: true, action: "reset" } };
  }

  // ── Cost-protection gate ──
  // Checks per-user daily cap, off-topic streak with cooldown.
  // Short-circuits with a canned response (no Anthropic call) on
  // gate-fail — so abusers can't burn through credits.
  try {
    const gate = await preflightAiChat({ userId: linked.id, message });
    if (!gate.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          action: "chat",
          response: gate.response,
          gated: gate.reason,
        },
      };
    }
  } catch (e) {
    // Don't block legitimate users if the gate itself crashes.
    console.warn("[ai-chat] gate error, proceeding anyway:", e.message);
  }

  // Inject light page-context hint when the floating chat passes
  // one. The agent's prompt knows to use it to ground answers
  // ("you're on /tokens, so let me check the tokens table…").
  const finalMessage = page_context
    ? `(User is currently on the page: ${String(page_context).slice(0, 64)})\n\n${message}`
    : message;

  let result;
  try {
    result = await chatWithAgent(linked.id, finalMessage, {
      username: linked.telegram_username,
    });
  } catch (e) {
    console.error("[ai-chat] agent error:", e.message);
    return { status: 500, body: { error: "AI agent error", detail: e.message?.slice(0, 200) } };
  }
  if (!result?.text) {
    return { status: 500, body: { error: "AI agent returned no response" } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: "chat",
      response: result.text,
      blocked_reason: result.blocked_reason ?? null,
      spend_capped: result.spend_capped ?? false,
      escalated_ticket_id: result.escalated_ticket_id ?? null,
    },
  };
}
