/**
 * Conditional borrow intents — "limit orders for borrows".
 *
 * The wedge that makes Magpie the first agent-native lending protocol:
 * an agent doesn't need to be online when the opportunity strikes —
 * just to sign + submit when the watcher tells it the conditions hit.
 *
 *   Agent posts an intent:
 *     "When $TOKEN trades above $0.50, borrow 5 SOL against 10000
 *      $TOKEN. Or when wall-clock hits unix=1717900000, fire."
 *
 *   Watcher polls live DEX prices every 30s. When conditions match:
 *     1. Server runs the FULL anti-exploit gauntlet (same as direct borrow).
 *     2. Server builds the unsigned tx (locks in price + blockhash).
 *     3. Server flips intent to 'matched' and stores partial_signed_tx_b64.
 *
 *   Agent polls GET /agent/intent/:id periodically. When status='matched',
 *   it pulls the partial-signed tx, signs locally, and submits via the
 *   existing cosign-borrow endpoint.
 *
 *   If conditions don't hit before expires_at, intent flips to 'expired'.
 *   Agent can cancel pending intents via DELETE.
 *
 * Security:
 *   - Same INTERNAL_API_TOKEN auth as the direct borrow endpoint.
 *   - All anti-exploit gates run at MATCH time (not at intent creation
 *     time) — using fresh price + fresh pool state. An intent posted
 *     before a ban-list update will still be blocked at match time.
 *   - Tx blockhash and on-chain valuation are computed at match time,
 *     not creation time. The intent stores only the agent's INTENT.
 *   - No keypairs ever loaded server-side.
 *
 * NOT a custodial vault. NOT a smart-contract pre-commit. The agent
 * always retains final-signature authority.
 */
import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

const VALID_CONDITION_TYPES = new Set([
  "price_above",
  "price_below",
  "time_after",
  "pool_liq_above",
]);

const MIN_EXPIRY_SECONDS = 60;            // 1 min
const MAX_EXPIRY_SECONDS = 30 * 86400;    // 30 days

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
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

function checkAuth(req) {
  if (!INTERNAL_API_TOKEN) {
    return { ok: false, status: 500, error: "Agent API not configured (server-side)" };
  }
  const auth = req.headers["x-internal-token"] || req.headers["authorization"] || "";
  const presented = String(auth).replace(/^Bearer\s+/i, "");
  if (presented !== INTERNAL_API_TOKEN) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

function validateCondition(condType, params) {
  if (!VALID_CONDITION_TYPES.has(condType)) {
    return `condition_type must be one of: ${[...VALID_CONDITION_TYPES].join(", ")}`;
  }
  if (typeof params !== "object" || params === null) {
    return "condition_params must be an object";
  }
  switch (condType) {
    case "price_above":
    case "price_below": {
      if (typeof params.mint !== "string") return "condition_params.mint required";
      try { new PublicKey(params.mint); } catch { return "condition_params.mint invalid pubkey"; }
      if (typeof params.usd !== "number" || params.usd <= 0 || !isFinite(params.usd)) {
        return "condition_params.usd must be a positive number";
      }
      if (params.usd > 1e9) return "condition_params.usd unreasonable";
      return null;
    }
    case "time_after": {
      if (typeof params.unix !== "number" || !Number.isInteger(params.unix)) {
        return "condition_params.unix must be an integer (unix seconds)";
      }
      const now = Math.floor(Date.now() / 1000);
      if (params.unix <= now) return "condition_params.unix must be in the future";
      return null;
    }
    case "pool_liq_above": {
      if (typeof params.usd !== "number" || params.usd <= 0 || !isFinite(params.usd)) {
        return "condition_params.usd must be a positive number";
      }
      return null;
    }
  }
  return null;
}

function newIntentId() {
  // 16 random bytes → base64url, ~22 chars. Globally unique with
  // overwhelming probability; safe to use as a public lookup key
  // because nothing about it leaks user state.
  return randomBytes(16).toString("base64url");
}

/**
 * POST /api/v1/agent/intent
 *
 * Body: {
 *   borrower_wallet:    string,
 *   collateral_mint:    string,
 *   collateral_amount:  string (raw u64),
 *   tier:               0 | 1 | 2,
 *   condition_type:     "price_above" | "price_below" | "time_after" | "pool_liq_above",
 *   condition_params:   object (shape depends on type),
 *   expires_in_seconds: number (default 86400 = 1 day, max 30 days)
 * }
 */
export async function handleAgentCreateIntent(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
  if (process.env.AGENT_API_DISABLED === "true") {
    return { status: 503, body: { error: "Agent API temporarily disabled" } };
  }
  const auth = checkAuth(req);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  let body;
  try { body = await readJsonBody(req); }
  catch { return { status: 400, body: { error: "Invalid JSON body" } }; }

  const {
    borrower_wallet,
    collateral_mint,
    collateral_amount,
    tier,
    condition_type,
    condition_params,
    expires_in_seconds,
  } = body ?? {};

  if (!borrower_wallet || !collateral_mint || !collateral_amount ||
      tier == null || !condition_type || !condition_params) {
    return {
      status: 400,
      body: {
        error: "missing_params",
        required: [
          "borrower_wallet", "collateral_mint", "collateral_amount", "tier",
          "condition_type", "condition_params",
        ],
      },
    };
  }
  try {
    new PublicKey(borrower_wallet);
    new PublicKey(collateral_mint);
  } catch { return { status: 400, body: { error: "invalid_pubkey" } }; }

  if (!/^\d+$/.test(String(collateral_amount))) {
    return { status: 400, body: { error: "collateral_amount must be a u64 string" } };
  }
  if (![0, 1, 2].includes(Number(tier))) {
    return { status: 400, body: { error: "tier must be 0, 1, or 2" } };
  }
  const condErr = validateCondition(condition_type, condition_params);
  if (condErr) return { status: 400, body: { error: condErr } };

  const ttl = Number.isInteger(expires_in_seconds) ? expires_in_seconds : 86400;
  if (ttl < MIN_EXPIRY_SECONDS || ttl > MAX_EXPIRY_SECONDS) {
    return {
      status: 400,
      body: { error: `expires_in_seconds must be in [${MIN_EXPIRY_SECONDS}, ${MAX_EXPIRY_SECONDS}]` },
    };
  }

  // Quick mint validity check — fail loudly at creation so the agent
  // doesn't sit on a pending intent for a token we can't support.
  const { rows: mintRows } = await query(
    `SELECT enabled FROM supported_mints WHERE mint = $1`,
    [collateral_mint],
  );
  if (!mintRows[0]) {
    return { status: 400, body: { error: "collateral_mint not supported on Magpie" } };
  }
  if (!mintRows[0].enabled) {
    return { status: 403, body: { error: "This token is currently disabled for new borrows" } };
  }

  // Rate-limit pending intents per wallet — prevents a runaway agent
  // from flooding the watcher queue.
  const { rows: pendingRows } = await query(
    `SELECT COUNT(*)::int AS n FROM borrow_intents
       WHERE borrower_wallet = $1 AND status = 'pending'`,
    [borrower_wallet],
  );
  if (pendingRows[0].n >= 10) {
    return {
      status: 429,
      body: { error: "too_many_pending_intents", detail: "Max 10 pending intents per wallet" },
    };
  }

  // Optional webhook subscription. If webhook_url is supplied, we POST
  // an HMAC-signed payload to it when the intent flips to 'matched'.
  // webhook_secret is server-generated and returned ONCE in this
  // response — agents must store it to verify signatures on receive.
  let webhookUrl = null;
  let webhookSecret = null;
  const webhookUrlInput = body?.webhook_url;
  if (webhookUrlInput !== undefined && webhookUrlInput !== null && webhookUrlInput !== "") {
    const { isValidWebhookUrl, generateWebhookSecret } = await import(
      "../services/intent-webhook.js"
    );
    if (!isValidWebhookUrl(webhookUrlInput)) {
      return {
        status: 400,
        body: {
          error: "invalid_webhook_url",
          detail:
            "webhook_url must be HTTPS, not contain credentials, " +
            "and not point at a local / private / link-local / metadata address. " +
            "Max length 2048.",
        },
      };
    }
    webhookUrl = String(webhookUrlInput);
    webhookSecret = generateWebhookSecret();
  }

  const intentId = newIntentId();
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await query(
    `INSERT INTO borrow_intents (
       intent_id, borrower_wallet, collateral_mint, collateral_amount,
       tier, condition_type, condition_params, expires_at,
       webhook_url, webhook_secret
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      intentId,
      borrower_wallet,
      collateral_mint,
      String(collateral_amount),
      Number(tier),
      condition_type,
      JSON.stringify(condition_params),
      expiresAt.toISOString(),
      webhookUrl,
      webhookSecret,
    ],
  );

  const responseBody = {
    ok: true,
    intent_id: intentId,
    status: "pending",
    expires_at: expiresAt.toISOString(),
    poll_url: `/api/v1/agent/intent/${intentId}`,
    next_step:
      "Poll GET /api/v1/agent/intent/:id every 30s. When status='matched', " +
      "decode partial_signed_tx_b64, sign with borrower_wallet, and POST " +
      "to /api/v1/cosign-borrow.",
  };
  // The webhook secret is returned EXACTLY ONCE — at intent-create time.
  // It's never retrievable via GET poll responses (would defeat the
  // shared-secret model). Agents must persist it now.
  if (webhookUrl) {
    responseBody.webhook = {
      url: webhookUrl,
      secret: webhookSecret,
      signature_header: "X-Magpie-Signature",
      signature_alg: "HMAC-SHA256",
      verify_example:
        "Verify on receive: const expected = HMAC_SHA256(webhook_secret, raw_body_bytes).hex(); if (constant_time_equals(expected, X-Magpie-Signature)) accept;",
      retry_policy: "5 attempts with exponential backoff (5s → 15s → 45s → 135s → 405s). 4xx never retried. 5xx retried.",
    };
    responseBody.next_step =
      "Wait for POST to your webhook URL. The HMAC-SHA256 signature is in " +
      "the X-Magpie-Signature header — verify before trusting the body. " +
      "If your webhook never fires (e.g., your endpoint was down), fall back " +
      "to GET /api/v1/agent/intent/:id to retrieve the same data.";
  }

  return { status: 200, body: responseBody };
}

/**
 * GET /api/v1/agent/intent?id=...
 *
 * Returns the intent's current state. When status='matched', the
 * response includes partial_signed_tx_b64 + summary — ready for the
 * agent to sign and submit.
 *
 * DELETE /api/v1/agent/intent?id=... cancels the intent (see below).
 */
export async function handleAgentGetIntent(req, queryParams) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  const auth = checkAuth(req);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  const intentId = queryParams?.id;
  if (!intentId || !/^[A-Za-z0-9_-]{16,32}$/.test(intentId)) {
    return { status: 400, body: { error: "invalid_intent_id" } };
  }
  const { rows } = await query(
    `SELECT intent_id, borrower_wallet, collateral_mint, collateral_amount,
            tier, condition_type, condition_params, status,
            partial_signed_tx_b64, summary, executed_tx,
            created_at, expires_at, matched_at, executed_at, last_checked_at
       FROM borrow_intents WHERE intent_id = $1`,
    [intentId],
  );
  if (!rows[0]) return { status: 404, body: { error: "not_found" } };
  const r = rows[0];

  return {
    status: 200,
    body: {
      intent_id: r.intent_id,
      status: r.status,
      borrower_wallet: r.borrower_wallet,
      collateral_mint: r.collateral_mint,
      collateral_amount: r.collateral_amount,
      tier: r.tier,
      condition: { type: r.condition_type, params: r.condition_params },
      partial_signed_tx_b64: r.status === "matched" ? r.partial_signed_tx_b64 : null,
      summary: r.summary,
      executed_tx: r.executed_tx,
      created_at: r.created_at,
      expires_at: r.expires_at,
      matched_at: r.matched_at,
      executed_at: r.executed_at,
      last_checked_at: r.last_checked_at,
      next_step:
        r.status === "matched"
          ? "Sign partial_signed_tx_b64 with borrower_wallet, then POST to /api/v1/cosign-borrow"
          : r.status === "pending"
          ? "Conditions not yet met — keep polling"
          : null,
    },
  };
}

/**
 * DELETE /api/v1/agent/intent?id=...
 *
 * Cancels a pending intent. Can be called on a 'matched' intent too,
 * but the tx may already be on-chain (agent's responsibility to check).
 */
export async function handleAgentCancelIntent(req, queryParams) {
  if (req.method !== "DELETE") return { status: 405, body: { error: "DELETE only" } };
  const auth = checkAuth(req);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  const intentId = queryParams?.id;
  if (!intentId || !/^[A-Za-z0-9_-]{16,32}$/.test(intentId)) {
    return { status: 400, body: { error: "invalid_intent_id" } };
  }
  const { rows } = await query(
    `UPDATE borrow_intents SET status = 'cancelled'
       WHERE intent_id = $1 AND status IN ('pending', 'matched')
       RETURNING intent_id, status`,
    [intentId],
  );
  if (!rows[0]) {
    return { status: 404, body: { error: "not_found_or_already_terminal" } };
  }
  return { status: 200, body: { ok: true, intent_id: rows[0].intent_id, status: "cancelled" } };
}

/**
 * Dispatcher for /api/v1/agent/intent — GET reads, DELETE cancels.
 * Server router dispatches by path; this routes by method.
 */
export async function handleAgentIntent(req, queryParams) {
  if (req.method === "GET") return handleAgentGetIntent(req, queryParams);
  if (req.method === "DELETE") return handleAgentCancelIntent(req, queryParams);
  return { status: 405, body: { error: "GET or DELETE only" } };
}

/**
 * GET /api/v1/agent/intents?wallet=...
 *
 * Lists intents for a wallet. For agent transparency / debugging.
 */
export async function handleAgentListIntents(req, queryParams) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  const auth = checkAuth(req);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  const wallet = queryParams?.wallet;
  if (!wallet) return { status: 400, body: { error: "wallet query param required" } };
  try { new PublicKey(wallet); } catch { return { status: 400, body: { error: "invalid_pubkey" } }; }

  const { rows } = await query(
    `SELECT intent_id, status, collateral_mint, collateral_amount, tier,
            condition_type, condition_params, created_at, expires_at, matched_at, executed_at
       FROM borrow_intents
       WHERE borrower_wallet = $1
       ORDER BY created_at DESC
       LIMIT 100`,
    [wallet],
  );
  return {
    status: 200,
    body: {
      ok: true,
      wallet,
      count: rows.length,
      intents: rows.map(r => ({
        intent_id: r.intent_id,
        status: r.status,
        collateral_mint: r.collateral_mint,
        collateral_amount: r.collateral_amount,
        tier: r.tier,
        condition: { type: r.condition_type, params: r.condition_params },
        created_at: r.created_at,
        expires_at: r.expires_at,
        matched_at: r.matched_at,
        executed_at: r.executed_at,
      })),
    },
  };
}
