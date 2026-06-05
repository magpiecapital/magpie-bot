/**
 * Site-facing support endpoints.
 *
 *   GET /api/v1/support/tickets?wallet=<pubkey>
 *     Returns METADATA only for the linked user's tickets — id, status,
 *     timestamps, follow-up count, has_admin_reply boolean. The message
 *     body and admin reply are deliberately NOT returned here because
 *     wallet pubkeys are public on-chain, and this endpoint is not
 *     signature-gated. Anyone who knew the user's wallet could otherwise
 *     read their private support messages.
 *
 *   POST /api/v1/support/ticket-details
 *     Signed read for a single ticket's full content. Same Ed25519 auth
 *     posture as the other signed endpoints. Signer must be the linked
 *     user who owns the ticket.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { alertTicketDeleted } from "../services/security-alerts.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 1_000;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lastBySigner = new Map();

function isValidPubkey(pubkey) {
  if (typeof pubkey !== "string") return false;
  if (pubkey.length < 32 || pubkey.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(pubkey);
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

export async function handleSupportTickets(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }

  const { rows: [w] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [wallet],
  );
  if (!w) {
    return { status: 200, body: { linked: false, tickets: [] } };
  }

  const { rows } = await query(
    `SELECT id, status, admin_replied_at, auto_resolved_at,
            last_user_followup_at, followup_count, closed_at, created_at,
            (admin_reply IS NOT NULL) AS has_admin_reply
       FROM support_tickets
      WHERE user_id = $1
      ORDER BY status = 'closed' ASC, created_at DESC
      LIMIT 20`,
    [w.user_id],
  );

  // Deliberately NO message or admin_reply in the list response —
  // those come from the signed /ticket-details endpoint only.
  return {
    status: 200,
    body: {
      linked: true,
      tickets: rows.map((r) => ({
        id: r.id,
        status: r.status,
        has_admin_reply: !!r.has_admin_reply,
        admin_replied_at: r.admin_replied_at,
        auto_resolved_at: r.auto_resolved_at,
        last_user_followup_at: r.last_user_followup_at,
        followup_count: r.followup_count ?? 0,
        closed_at: r.closed_at,
        created_at: r.created_at,
      })),
    },
  };
}

export async function handleSupportDeleteTicket(req) {
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
  if (payload?.magpie !== "support/delete-ticket/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { ticketId, nonce, issuedAt } = payload;
  if (!ticketId || !nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing ticketId, nonce, or issuedAt" } };
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
    console.warn("[support-delete-ticket] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "support_delete_ticket", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  // Only allow deletion of CLOSED tickets — open/awaiting tickets stay
  // until resolved so the team can complete in-flight investigations.
  // Single statement so a non-owner / wrong-status case gets the same
  // 404 as a non-existent id (no enumeration disclosure). Return user_id
  // so we can fire the security alert after deletion.
  const { rows } = await query(
    `DELETE FROM support_tickets
       WHERE id = $2
         AND status = 'closed'
         AND user_id = (SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1)
       RETURNING user_id`,
    [signerPubkey, ticketId],
  );
  if (rows.length === 0) {
    return {
      status: 404,
      body: { error: "Ticket not found, not yours, or not closed" },
    };
  }

  alertTicketDeleted({ userId: rows[0].user_id, ticketId }).catch(() => {});

  return { status: 200, body: { ok: true, deleted: ticketId } };
}

export async function handleSupportTicketDetails(req) {
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
  if (payload?.magpie !== "support/ticket-details/v1") {
    return { status: 400, body: { error: "Bad payload header" } };
  }
  const { ticketId, nonce, issuedAt } = payload;
  if (!ticketId || !nonce || !issuedAt) {
    return { status: 400, body: { error: "Payload missing ticketId, nonce, or issuedAt" } };
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
    console.warn("[support-ticket-details] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) return { status: 401, body: { error: "Signature does not match signer" } };

  // One JOIN: ticket-must-belong-to-signer in a single statement so a
  // non-owner gets the same "not found" response as a non-existent id
  // (no information disclosure via response divergence).
  const { rows: [t] } = await query(
    `SELECT s.id, s.message, s.status, s.admin_reply, s.admin_replied_at,
            s.auto_resolved_at, s.last_user_followup_at, s.followup_count,
            s.closed_at, s.created_at
       FROM support_tickets s
       JOIN wallets w ON w.user_id = s.user_id
      WHERE w.public_key = $1 AND s.id = $2
      LIMIT 1`,
    [signerPubkey, ticketId],
  );
  if (!t) {
    return { status: 404, body: { error: "Ticket not found" } };
  }

  // Nonce one-shot AFTER ownership check — keeps drive-by nonce
  // consumption from being a useful enumeration probe.
  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [nonce, "support_ticket_details", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign" } };
    }
    throw e;
  }

  return {
    status: 200,
    body: {
      id: t.id,
      message: t.message,
      status: t.status,
      admin_reply: t.admin_reply,
      admin_replied_at: t.admin_replied_at,
      auto_resolved_at: t.auto_resolved_at,
      last_user_followup_at: t.last_user_followup_at,
      followup_count: t.followup_count ?? 0,
      closed_at: t.closed_at,
      created_at: t.created_at,
    },
  };
}
