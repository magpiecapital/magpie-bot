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

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
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

export async function handleLenderAlarmWebhook(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }

  // Verify the shared secret. Helius passes it in the Authorization
  // header, exactly as we configured at webhook-creation time.
  if (WEBHOOK_SECRET) {
    const got = req.headers["authorization"] || req.headers["Authorization"];
    if (got !== WEBHOOK_SECRET) {
      console.warn("[lender-alarm-webhook] bad auth header");
      return { status: 401, body: { error: "auth" } };
    }
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return { status: 400, body: { error: "Invalid body" } };
  }

  const txs = Array.isArray(body) ? body : [body];
  for (const tx of txs) {
    const outflow = isOutflowFromLender(tx);
    if (!outflow) continue;

    const solAmount = (Number(outflow.amount) / 1e9).toFixed(6);
    const message =
      `🚨 *Lender wallet outflow detected*\n\n` +
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
