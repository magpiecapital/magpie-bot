/**
 * POST /api/v1/ai/chat/stream
 *
 * Streaming variant of /api/v1/ai/chat — same Bearer-token /
 * signed-message auth, same chat semantics, same tool execution, but
 * server-streams text deltas via NDJSON so the floating chat panel
 * can render Pip's response as it generates instead of waiting for
 * the full response.
 *
 * Wire format (newline-delimited JSON):
 *   {"type":"text","delta":"Hello"}
 *   {"type":"text","delta":" there"}
 *   {"type":"tool","names":["list_my_loans"]}
 *   {"type":"text","delta":". Your loan…"}
 *   {"type":"done","result":{"text":"...","proposed_action":...}}
 *
 * Each frame is exactly one JSON object followed by a newline. The
 * site reads with fetch().body.getReader() + a JSONLines parser.
 *
 * On any auth or pre-flight error, the stream closes after one frame:
 *   {"type":"error","status":401,"text":"..."}
 *
 * Falls back to the existing /api/v1/ai/chat path if the client
 * doesn't request streaming explicitly (it always will via the
 * matching endpoint URL).
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { chatWithAgentStream, resetConversation, isAiSupportEnabled } from "../services/ai-support.js";
import { rejectIfLocked } from "../services/site-lock.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";
import { preflightFast, applyTopicGate } from "../services/ai-chat-gate.js";
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
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/**
 * Server-Sent-style streaming handler. Writes NDJSON frames directly
 * to the response, then ends.
 *
 * The router (src/api/server.js) handles JSON responses via a single
 * writeJson at the end of the dispatch. For streaming we need direct
 * res control, so this handler does the writeHead + writes + end
 * itself and returns { __handled: true } to tell the router to skip
 * its normal response path.
 */
export async function handleAiChatStream(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return { __handled: true };
  }

  const writeFrame = (obj) => {
    try { res.write(JSON.stringify(obj) + "\n"); } catch { /* socket gone */ }
  };
  const fail = (status, text, extras = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    writeFrame({ type: "error", status, text, ...extras });
    res.end();
    return { __handled: true };
  };

  // Site-global / kill switch
  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return fail(globalReject.status, globalReject.body?.error || "site disabled");
  if (!isAiSupportEnabled()) return fail(503, "AI agent is currently disabled");

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return fail(400, `Invalid body: ${e.message}`); }

  // ── AUTH ─────────────────────────────────────────────────────────
  // Same dual-mode auth as /api/v1/ai/chat: Bearer (Pip session) OR
  // per-message signed Ed25519 payload.
  const authHeader = (req.headers["authorization"] || req.headers["Authorization"] || "").toString();
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  let signerPubkey = null;
  let action = "chat";
  let message = "";
  let pageContext = null;

  if (bearerToken) {
    const verified = verifyChatSession(bearerToken);
    if (!verified.ok) return fail(401, `Invalid or expired Pip session: ${verified.reason || ""}`);
    signerPubkey = verified.pubkey;
    action = body?.action || "chat";
    message = body?.message;
    pageContext = body?.page_context;
  } else {
    const { signedMessageBase64, signatureBase58, signerPubkey: sp } = body || {};
    if (!signedMessageBase64 || !signatureBase58 || !sp) {
      return fail(400, "Missing signedMessageBase64, signatureBase58, or signerPubkey");
    }
    let signerPk;
    try { signerPk = new PublicKey(sp); }
    catch { return fail(400, "Invalid signerPubkey"); }
    let sigBytes;
    try { sigBytes = bs58decode(signatureBase58); if (sigBytes.length !== 64) throw new Error("bad length"); }
    catch { return fail(400, "Invalid signatureBase58"); }
    let messageBytes;
    try {
      messageBytes = Buffer.from(signedMessageBase64, "base64");
      if (messageBytes.length === 0 || messageBytes.length > 8192) throw new Error("size");
    } catch { return fail(400, "Invalid signedMessageBase64"); }
    let payload;
    try { payload = JSON.parse(messageBytes.toString("utf-8")); }
    catch { return fail(400, "Signed message is not valid JSON"); }
    if (payload?.magpie !== "ai-chat/v1") return fail(400, "Bad payload header");
    if (!payload.nonce || !payload.issuedAt) return fail(400, "Payload missing nonce or issuedAt");
    const ts = Date.parse(payload.issuedAt);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESH_WINDOW_MS) {
      return fail(400, "Signed message is stale — re-sign");
    }
    const nowMs = Date.now();
    const last = lastBySigner.get(sp) || 0;
    if (nowMs - last < MIN_INTERVAL_MS) {
      return fail(429, `Too fast — wait ${Math.ceil((MIN_INTERVAL_MS - (nowMs - last)) / 1000)}s`);
    }
    lastBySigner.set(sp, nowMs);
    let sigOk;
    try { sigOk = verifyEd25519(messageBytes, sigBytes, signerPk.toBytes()); }
    catch (e) { return fail(400, `Signature verification failed: ${e.message}`); }
    if (!sigOk) return fail(401, "Signature does not match signer");
    try {
      await query(
        `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
        [payload.nonce, "ai_chat", sp],
      );
    } catch (e) {
      if (e.code === "23505") return fail(409, "Nonce already used — re-sign");
      throw e;
    }
    signerPubkey = sp;
    action = payload.action || "chat";
    message = payload.message;
    pageContext = payload.page_context;
  }

  // Resolve user
  const { rows: [linked] } = await query(
    `SELECT u.id, u.telegram_username
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!linked) return fail(403, "Signer wallet is not linked to a Magpie account");
  const lockResp = await rejectIfLocked(linked.id);
  if (lockResp) return fail(lockResp.status, lockResp.body?.error || "locked");

  // Reset shortcut
  if (action === "reset") {
    try { await resetConversation(linked.id); }
    catch (e) { console.warn("[ai-chat-stream] reset failed:", e.message); }
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    writeFrame({ type: "done", result: { ok: true, action: "reset" } });
    res.end();
    return { __handled: true };
  }

  if (!message || typeof message !== "string" || message.length > MAX_MESSAGE_LEN) {
    return fail(400, `Message missing or too long (max ${MAX_MESSAGE_LEN} chars)`);
  }

  // Fast cost / cooldown gate
  try {
    const fast = await preflightFast({ userId: linked.id });
    if (!fast.ok) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      writeFrame({ type: "done", result: { ok: true, action: "chat", response: fast.response, gated: fast.reason } });
      res.end();
      return { __handled: true };
    }
  } catch (e) {
    console.warn("[ai-chat-stream] preflight error, proceeding:", e.message);
  }

  // Open the SSE-style response now that we know we'll stream.
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",   // disable nginx buffering on Railway
    "Connection": "keep-alive",
  });
  // Flush headers immediately so the client opens its stream reader.
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Inject page context into the user message exactly like the
  // non-streaming path does.
  const finalMessage = pageContext
    ? `(User is currently on the page: ${String(pageContext).slice(0, 64)})\n\n${message}`
    : message;

  // Run topic gate in parallel; if it gates, override the final result.
  const topicGatePromise = applyTopicGate({ userId: linked.id, message })
    .catch((e) => {
      console.warn("[ai-chat-stream] topic-gate error, treating as ok:", e.message);
      return { ok: true };
    });

  let finalResult = null;
  try {
    const [result, gate] = await Promise.all([
      chatWithAgentStream(
        linked.id,
        finalMessage,
        { username: linked.telegram_username, signerPubkey },
        (evt) => {
          // Forward each event as one NDJSON line.
          if (evt.type === "text" && evt.delta) {
            writeFrame({ type: "text", delta: evt.delta });
          } else if (evt.type === "tool" && evt.names?.length) {
            writeFrame({ type: "tool", names: evt.names });
          }
          // Suppress "done" — we'll emit it ourselves below so the
          // payload aligns with the non-streaming response shape.
        },
      ),
      topicGatePromise,
    ]);

    if (gate && gate.ok === false) {
      // Topic gate tripped — discard whatever streamed text the model
      // sent and replace with the gate's response. The streamed text
      // already shows on the client; we send a 'replace' frame to
      // signal the UI to swap in the gated message.
      writeFrame({ type: "replace", text: gate.response, gated: gate.reason });
      finalResult = { ok: true, action: "chat", response: gate.response, gated: gate.reason };
    } else {
      finalResult = {
        ok: true,
        action: "chat",
        response: result?.text || "",
        blocked_reason: result?.blocked_reason ?? null,
        spend_capped: result?.spend_capped ?? false,
        escalated_ticket_id: result?.escalated_ticket_id ?? null,
        proposed_action: result?.proposed_action ?? null,
      };
    }
  } catch (err) {
    console.error("[ai-chat-stream] agent error:", err.message);
    writeFrame({ type: "error", status: 500, text: `AI agent error: ${err.message?.slice(0, 200) || ""}` });
    res.end();
    return { __handled: true };
  }

  writeFrame({ type: "done", result: finalResult });
  res.end();
  return { __handled: true };
}
