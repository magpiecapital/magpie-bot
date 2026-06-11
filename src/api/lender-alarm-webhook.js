/**
 * POST /api/v1/lender-alarm-webhook
 *
 * Receives Helius webhook callbacks when the lender authority wallet
 * has an account-change event. Filters for outgoing SOL transfers
 * above a threshold and DMs the operator on Telegram immediately.
 *
 * Setup (one-time, in Helius dashboard or via their API):
 *
 *   curl -X POST 'https://api.helius.xyz/v0/webhooks?api-key=<KEY>' \
 *     -H 'content-type: application/json' \
 *     -d '{
 *       "webhookURL":  "https://magpie-bot-production.up.railway.app/api/v1/lender-alarm-webhook",
 *       "accountAddresses": ["4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx"],
 *       "transactionTypes": ["ANY"],
 *       "webhookType":  "enhanced",
 *       "authHeader":   "<random-shared-secret>"
 *     }'
 *
 * Then add LENDER_ALARM_WEBHOOK_SECRET=<same-secret> to Railway env.
 *
 * Threshold default: 0.01 SOL (any outflow above this triggers a DM).
 * Configurable via LENDER_ALARM_THRESHOLD_LAMPORTS env var.
 */
import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { notifyAdmin } from "../services/admin-notify.js";

// Bot reference is injected at startup via setLenderAlarmBot(bot) so
// we can fire the operator DM from the webhook handler without
// circular imports.
let botRef = null;
export function setLenderAlarmBot(bot) {
  botRef = bot;
}

const LENDER = "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";
const THRESHOLD = BigInt(process.env.LENDER_ALARM_THRESHOLD_LAMPORTS || "10000000"); // 0.01 SOL
const WEBHOOK_SECRET = process.env.LENDER_ALARM_WEBHOOK_SECRET;

// Helius sends a batch of transactions; webhook receives an array.
function isOutflowFromLender(tx) {
  // Helius enhanced format gives us nativeTransfers and tokenTransfers
  // arrays. We care about nativeTransfers where the lender is the source.
  if (!Array.isArray(tx.nativeTransfers)) return null;
  for (const t of tx.nativeTransfers) {
    if (t.fromUserAccount === LENDER && BigInt(t.amount || 0) >= THRESHOLD) {
      return {
        amount: BigInt(t.amount),
        to: t.toUserAccount,
        signature: tx.signature,
        timestamp: tx.timestamp,
      };
    }
  }
  return null;
}

const MAX_BODY_BYTES = 64 * 1024; // 64KB hard cap on inbound payload

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// In-memory tx-signature replay LRU. Helius may retry the same webhook
// payload across transient failures, and an attacker that captures one
// valid payload (e.g., from logs) could replay it to spam the operator's
// DM. We dedup the last 1024 signatures we've seen; an older signature
// rotates out naturally.
const SEEN_SIG_LRU_MAX = 1024;
const seenSignatures = new Set();
const seenSignatureOrder = [];

function markAndCheckSeen(signature) {
  if (!signature) return false;
  if (seenSignatures.has(signature)) return true;
  seenSignatures.add(signature);
  seenSignatureOrder.push(signature);
  while (seenSignatureOrder.length > SEEN_SIG_LRU_MAX) {
    const evict = seenSignatureOrder.shift();
    seenSignatures.delete(evict);
  }
  return false;
}

export async function handleLenderAlarmWebhook(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }

  // REQUIRE the shared secret env var. If unset, the endpoint refuses
  // every request — safer than skipping auth and letting any attacker
  // POST forged alarm events at us. Set LENDER_ALARM_WEBHOOK_SECRET in
  // Railway BEFORE creating the Helius webhook, in that order.
  if (!WEBHOOK_SECRET) {
    console.warn("[lender-alarm-webhook] LENDER_ALARM_WEBHOOK_SECRET not set — refusing all events");
    return {
      status: 503,
      body: { error: "alarm not configured — operator: set LENDER_ALARM_WEBHOOK_SECRET on Railway" },
    };
  }
  const got = req.headers["authorization"] || req.headers["Authorization"];
  // Constant-time compare to avoid timing-side-channel reveal of the
  // shared-secret. String !== compares byte-by-byte and short-circuits on
  // first mismatch, which is observable from outside via response-time
  // measurement.
  const gotBuf = Buffer.from(String(got ?? ""), "utf-8");
  const expectedBuf = Buffer.from(WEBHOOK_SECRET, "utf-8");
  const lengthsMatch = gotBuf.length === expectedBuf.length;
  // Pad to equal length to keep timingSafeEqual happy even on length mismatch —
  // if lengths differ, the final equality result is forced false.
  const a = lengthsMatch ? gotBuf : Buffer.alloc(expectedBuf.length);
  const ok = lengthsMatch && timingSafeEqual(a, expectedBuf);
  if (!ok) {
    console.warn("[lender-alarm-webhook] bad auth header");
    return { status: 401, body: { error: "auth" } };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e?.message === "payload_too_large") {
      return { status: 413, body: { error: "payload too large" } };
    }
    return { status: 400, body: { error: "Invalid body" } };
  }

  const txs = Array.isArray(body) ? body : [body];
  for (const tx of txs) {
    const outflow = isOutflowFromLender(tx);
    if (!outflow) continue;
    // Drop replays — Helius can retry the same payload, and a captured
    // valid payload replayed by an attacker would otherwise spam the
    // operator with duplicate DMs.
    if (markAndCheckSeen(outflow.signature)) continue;

    const solAmount = (Number(outflow.amount) / 1e9).toFixed(6);
    const message =
      `*LENDER WALLET OUTFLOW DETECTED*\n\n` +
      `*Amount:* ${solAmount} SOL\n` +
      `*To:* \`${outflow.to}\`\n` +
      `*Tx:* [${outflow.signature.slice(0, 16)}…](https://solscan.io/tx/${outflow.signature})\n` +
      `*Time:* ${new Date(outflow.timestamp * 1000).toISOString()}\n\n` +
      `If this wasn't a legitimate borrow-cosign or distribution, ` +
      `set \`COSIGN_BORROW_DISABLED=true\` on Railway immediately.`;

    // Non-blocking DM — log on failure but don't fail the webhook
    notifyAdmin(botRef, message, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }).catch((err) =>
      console.error("[lender-alarm-webhook] DM failed:", err.message),
    );
    console.warn(
      `[lender-alarm-webhook] OUTFLOW: ${solAmount} SOL → ${outflow.to.slice(0, 8)}… (${outflow.signature})`,
    );
  }

  return { status: 200, body: { ok: true, processed: txs.length } };
}
