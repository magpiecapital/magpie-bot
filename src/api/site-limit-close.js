/**
 * Site-facing limit-close (take-profit) endpoints.
 *
 *   GET    /api/v1/site/limit-close?wallet=<pubkey>
 *          Read-only listing of the wallet's loans + their armed
 *          take-profit orders. Unsigned (same risk envelope as
 *          /api/v1/loans — public data the wallet owner can see).
 *
 *   POST   /api/v1/site/limit-close/arm
 *          Ed25519-signed envelope. Arms a take-profit on a specific
 *          loan owned by the signer's wallet.
 *
 *   DELETE /api/v1/site/limit-close/cancel
 *          Ed25519-signed envelope. Cancels an armed order by id.
 *
 * Auth model (POST + DELETE):
 *   The site asks the user's wallet adapter to sign a structured
 *   text envelope. The bot:
 *     1. Parses + validates envelope shape
 *     2. Checks freshness (5 min window) + per-signer rate limit
 *     3. Verifies Ed25519 signature
 *     4. Looks up user_id from wallets.public_key — the signer MUST
 *        be a linked wallet (custodial or imported) so the engine
 *        can actually sign repay+sell on their behalf. Pure-Phantom
 *        users who haven't linked get a clear error.
 *
 * Why we require a linked-and-custodial wallet:
 *   The engine fires by loading the user's keypair (loadKeypairForUserId)
 *   and signing the repay+sell tx itself. Without a custodial keypair
 *   on file, autonomous fire is impossible — the user would need to
 *   sign at fire time, which defeats "don't babysit a chart." For
 *   Phantom-only users we return a `requires_linked_custodial_wallet`
 *   error code that the site UI can translate into a "link your wallet
 *   to enable take-profit" CTA.
 *
 * Shared logic lives in src/services/limit-close-arm-core.js so the
 * TG path, this site path, and the x402 internal path all run the
 * same eligibility math + pre-flight + INSERT.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { sign as naclSign } from "tweetnacl";
import { query } from "../db/pool.js";
import {
  armOrder, cancelOrder, enqueueArmedDm,
  resolveMultiplierToPrice,
  MIN_LOAN_LAMPORTS,
} from "../services/limit-close-arm-core.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const FRESH_WINDOW_MS = 5 * 60 * 1000;     // signed envelope freshness
const MIN_INTERVAL_MS = 10_000;            // per-signer arm/cancel rate limit
const lastAttemptBySigner = new Map();

function verifyEd25519(messageBytes, signatureBytes, pubkeyBytes) {
  return naclSign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
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
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function isValidPubkey(s) {
  if (typeof s !== "string") return false;
  if (s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

/**
 * Parse the structured envelope. We use a simple "Header: value" format
 * (same pattern as withdraw.js) so the signed bytes are human-readable
 * — a user can verify what they're signing in any wallet adapter that
 * shows the message.
 */
function parseSignedMessage(text) {
  const lines = text.split(/\r?\n/);
  const fields = {};
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    fields[k] = v;
  }
  return { ok: true, fields };
}

/**
 * Common auth path for the signed POST + DELETE endpoints.
 * Returns { ok: true, userId, signerPubkey, fields } or { ok: false, ... }.
 *
 * `expectedMagpieHeader` is the `magpie: …/v1` tag we expect on the
 * envelope. Each endpoint passes its own so a signature for one action
 * can never be replayed as a different action.
 */
async function authSignedEnvelope(req, expectedMagpieHeader, requiredFields = []) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return { ok: false, status: 405, error: "wrong_method" };
  }
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return { ok: false, status: 400, error: `invalid_body: ${e.message}` }; }

  const { signedMessageBase64, signatureBase58, signerPubkey } = body || {};
  if (!signedMessageBase64 || !signatureBase58 || !signerPubkey) {
    return { ok: false, status: 400, error: "missing_signed_envelope_fields" };
  }
  let signerPk;
  try { signerPk = new PublicKey(signerPubkey); }
  catch { return { ok: false, status: 400, error: "invalid_signerPubkey" }; }

  let signatureBytes;
  try {
    signatureBytes = bs58decode(signatureBase58);
    if (signatureBytes.length !== 64) throw new Error("bad length");
  } catch { return { ok: false, status: 400, error: "invalid_signatureBase58" }; }

  let messageBytes;
  try {
    messageBytes = Buffer.from(signedMessageBase64, "base64");
    if (messageBytes.length === 0 || messageBytes.length > 2048) throw new Error("size_out_of_range");
  } catch { return { ok: false, status: 400, error: "invalid_signedMessageBase64" }; }

  const text = messageBytes.toString("utf-8");
  const parsed = parseSignedMessage(text);
  if (!parsed.ok) return { ok: false, status: 400, error: "malformed_signed_message" };
  const fields = parsed.fields;

  if (fields.magpie !== expectedMagpieHeader) {
    return { ok: false, status: 400, error: "wrong_magpie_header", expected: expectedMagpieHeader, got: fields.magpie };
  }
  if (!fields.From || fields.From !== signerPubkey) {
    return { ok: false, status: 400, error: "from_signer_mismatch" };
  }
  if (!fields.Nonce || !fields.IssuedAt) {
    return { ok: false, status: 400, error: "missing_nonce_or_issuedat" };
  }
  for (const r of requiredFields) {
    if (!fields[r]) return { ok: false, status: 400, error: `missing_field_${r}` };
  }

  const issuedAt = Date.parse(fields.IssuedAt);
  if (!Number.isFinite(issuedAt)) return { ok: false, status: 400, error: "invalid_IssuedAt" };
  const skew = Math.abs(Date.now() - issuedAt);
  if (skew > FRESH_WINDOW_MS) {
    return { ok: false, status: 400, error: "stale_signed_message", skew_seconds: Math.round(skew / 1000) };
  }

  // Per-signer rate limit
  const now = Date.now();
  const last = lastAttemptBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
    return { ok: false, status: 429, error: "too_fast", retry_after_seconds: wait };
  }
  lastAttemptBySigner.set(signerPubkey, now);

  // Signature
  let sigOk;
  try { sigOk = verifyEd25519(messageBytes, signatureBytes, signerPk.toBytes()); }
  catch (e) {
    console.warn("[site-limit-close] verify threw:", e.message);
    return { ok: false, status: 400, error: "signature_verification_failed" };
  }
  if (!sigOk) return { ok: false, status: 401, error: "signature_does_not_match" };

  // Wallet ownership + custodial check
  const { rows: [walletRow] } = await query(
    `SELECT user_id, encrypted_secret, source
       FROM wallets WHERE public_key = $1 LIMIT 1`,
    [signerPubkey],
  );
  if (!walletRow) {
    return { ok: false, status: 403, error: "wallet_not_linked",
             detail: "This wallet isn't linked to a Magpie account. Link via the TG bot first." };
  }
  // The engine needs a custodial keypair to autonomously fire the
  // repay+sell tx. wallets.encrypted_secret holds the encrypted key
  // for custodial + imported wallets. Phantom-only wallets get NULL
  // and can't have autonomous take-profit.
  if (!walletRow.encrypted_secret || walletRow.encrypted_secret.length === 0) {
    return {
      ok: false, status: 403,
      error: "requires_linked_custodial_wallet",
      detail: "Autonomous take-profit needs a Magpie custodial keypair to sign the repay+sell tx at fire time. " +
              "Connect via the Telegram bot or import a key to enable.",
    };
  }

  return { ok: true, userId: walletRow.user_id, signerPubkey, fields };
}

/* ─────────────────────────────────────────────────────────────────
 * GET /api/v1/site/limit-close?wallet=<pubkey>
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseList(req, url) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  const wallet = url.searchParams.get("wallet") || "";
  if (!isValidPubkey(wallet)) return { status: 400, body: { error: "invalid_wallet" } };

  const { rows: [walletRow] } = await query(
    `SELECT user_id, encrypted_secret FROM wallets WHERE public_key = $1 LIMIT 1`,
    [wallet],
  );
  if (!walletRow) {
    return {
      status: 200,
      body: {
        linked: false,
        custodial: false,
        loans: [],
        orders: [],
      },
    };
  }
  const isCustodial = !!walletRow.encrypted_secret;

  // Loans owned by this wallet (status='active' only — take-profit
  // is for active loans).
  const { rows: loans } = await query(
    `SELECT l.id, l.loan_id::text AS loan_id, l.loan_pda,
            l.collateral_mint, l.collateral_amount::text AS collateral_amount,
            l.original_loan_amount_lamports::text AS owed_lamports,
            l.start_timestamp, l.due_timestamp,
            sm.symbol AS collateral_symbol, sm.decimals AS collateral_decimals,
            sm.category AS collateral_category, sm.enabled AS collateral_enabled
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE l.user_id = $1 AND l.borrower_wallet = $2 AND l.status = 'active'
      ORDER BY l.start_timestamp DESC
      LIMIT 100`,
    [walletRow.user_id, wallet],
  );

  // Armed orders for those loans.
  const loanIds = loans.map((l) => l.id);
  let orders = [];
  if (loanIds.length > 0) {
    const r = await query(
      `SELECT id, loan_id, trigger_kind, trigger_value_micro::text AS trigger_value_micro,
              slippage_bps, sell_destination, status,
              armed_at, expires_at,
              max_slippage_bps_cap, auto_escalate_slippage,
              source, source_agent_pubkey
         FROM limit_close_orders
        WHERE loan_id = ANY($1::bigint[])
          AND status IN ('armed','firing','twap_in_progress','awaiting_user')
        ORDER BY armed_at DESC`,
      [loanIds],
    );
    orders = r.rows;
  }

  // Eligibility annotation per loan — same checks the arm endpoint
  // will apply. Surface it here so the UI can disable the Arm button
  // for ineligible loans with a clear reason.
  const armedByLoan = new Map(
    orders.filter((o) => o.status === "armed").map((o) => [Number(o.loan_id), o]),
  );
  const annotated = loans.map((l) => {
    const reasons = [];
    if (BigInt(l.owed_lamports) < MIN_LOAN_LAMPORTS) reasons.push("loan_below_minimum_size");
    if (!l.collateral_enabled) reasons.push("collateral_not_enabled");
    if (["stock", "etf", "metal"].includes(l.collateral_category)) {
      reasons.push("rwa_collateral_not_supported_in_v1");
    }
    if (armedByLoan.has(Number(l.id))) reasons.push("loan_already_has_active_order");
    return {
      ...l,
      owed_sol: Number(l.owed_lamports) / 1e9,
      is_eligible_for_takeprofit: reasons.length === 0,
      ineligibility_reasons: reasons,
    };
  });

  return {
    status: 200,
    body: {
      linked: true,
      custodial: isCustodial,
      loans: annotated,
      orders,
      generated_at: new Date().toISOString(),
    },
  };
}

/* ─────────────────────────────────────────────────────────────────
 * POST /api/v1/site/limit-close/arm
 *
 * Signed envelope shape:
 *   magpie: limit-close-arm/v1
 *   From: <signer_wallet>
 *   LoanId: <chain_loan_id>
 *   Target: 2x                  (multiplier; OR Price: 0.005 OR MC: 150m)
 *   Slippage: 200               (optional, default 200, bps)
 *   Dest: sol                   (optional, default sol)
 *   Expire: 30d                 (optional, days or hours)
 *   Nonce: <random_base58_or_uuid>
 *   IssuedAt: <ISO timestamp>
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseArm(req) {
  const auth = await authSignedEnvelope(req, "limit-close-arm/v1", ["LoanId"]);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error, ...(auth.detail ? { detail: auth.detail } : {}), ...(auth.expected ? { expected: auth.expected } : {}), ...(auth.retry_after_seconds ? { retry_after_seconds: auth.retry_after_seconds } : {}) } };
  const { userId, fields } = auth;

  // ── Parse target ──
  let triggerKind = null;
  let triggerValueMicro = null;
  let multiplierUsed = null;
  let currentUsdRef = null;
  let targetUsdRef = null;

  if (fields.Target) {
    const m = fields.Target.match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
    if (m) {
      const mult = Number(m[1]);
      if (!Number.isFinite(mult) || mult <= 1) {
        return { status: 400, body: { error: "invalid_target_multiplier" } };
      }
      // Resolve later, after we have the loan + mint.
      multiplierUsed = mult;
    } else {
      return { status: 400, body: { error: "invalid_target", detail: "Target must look like '2x'. Use Price: or MC: for explicit values." } };
    }
  } else if (fields.Price) {
    const usd = Number(String(fields.Price).replace(/^\$/, ""));
    if (!Number.isFinite(usd) || usd <= 0) return { status: 400, body: { error: "invalid_price" } };
    triggerKind = "price_usd";
    triggerValueMicro = BigInt(Math.round(usd * 1e6));
  } else if (fields.MC) {
    const raw = String(fields.MC).replace(/^\$/, "");
    const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)([KMBkmb])?$/);
    if (!m) return { status: 400, body: { error: "invalid_mc" } };
    const n = Number(m[1]);
    const mul = (m[2] || "").toLowerCase() === "b" ? 1e9 : (m[2] || "").toLowerCase() === "m" ? 1e6 : (m[2] || "").toLowerCase() === "k" ? 1e3 : 1;
    const usd = n * mul;
    triggerKind = "mc_usd";
    triggerValueMicro = BigInt(Math.round(usd * 1e6));
  } else {
    return { status: 400, body: { error: "missing_target", detail: "Provide Target (e.g. 2x), Price ($0.005), or MC ($150m)." } };
  }

  const slippageBps = fields.Slippage ? Number(fields.Slippage) : 200;
  // Upper bound matches arm-core's MAX_INITIAL_SLIPPAGE_BPS (2500 = 25%) so
  // moon-pump UX can request a wide initial slippage when the user knows the
  // token is thin. Arm-core then auto-derives a wider cap on top.
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 2500) {
    return { status: 400, body: { error: "invalid_slippage" } };
  }
  const dest = (fields.Dest || "sol").toLowerCase();

  // Expire parsing — "30d" / "12h"
  let expiresAt = null;
  if (fields.Expire) {
    const m = String(fields.Expire).match(/^(\d+)([dh])$/);
    if (!m) return { status: 400, body: { error: "invalid_expire", detail: "Use form like 30d or 12h." } };
    const n = Number(m[1]);
    const ms = m[2] === "d" ? n * 86_400_000 : n * 3_600_000;
    if (ms > 365 * 86_400_000) return { status: 400, body: { error: "expire_too_far" } };
    expiresAt = new Date(Date.now() + ms).toISOString();
  }

  // ── Load loan to resolve multiplier (needs collateral_mint) ──
  if (multiplierUsed != null) {
    const { rows: [loanLite] } = await query(
      `SELECT collateral_mint FROM loans
        WHERE user_id = $1 AND loan_id = $2 AND status = 'active'`,
      [userId, fields.LoanId],
    );
    if (!loanLite) return { status: 404, body: { error: "loan_not_found_for_signer" } };
    const r = await resolveMultiplierToPrice(loanLite.collateral_mint, multiplierUsed);
    if (!r.ok) return { status: 502, body: { error: "multiplier_resolve_failed", detail: r.error } };
    triggerKind = "price_usd";
    triggerValueMicro = r.triggerValueMicro;
    currentUsdRef = r.currentUsd;
    targetUsdRef = r.targetUsd;
  }

  // ── Shared arm ──
  const armed = await armOrder({
    userId,
    source: "site",
    loanIdChain: fields.LoanId,
    triggerKind,
    triggerValueMicro,
    slippageBps,
    sellDestination: dest,
    expiresAt,
    armNote: `armed via site by ${auth.signerPubkey.slice(0, 8)}…`,
  });
  if (!armed.ok) {
    return {
      status: 409,
      body: {
        error: armed.error,
        ...(armed.detail ? { detail: armed.detail } : {}),
        ...(armed.suggestedSlippageBps ? { suggested_slippage_bps: armed.suggestedSlippageBps } : {}),
      },
    };
  }

  // DM the borrower — they didn't act in TG (they acted on the site),
  // so this is THE notification they get telling them the order is live.
  await enqueueArmedDm({
    userId,
    orderId: armed.orderId,
    loanIdChain: fields.LoanId,
    triggerKind,
    triggerValueMicro,
    slippageBps,
    sellDestination: dest,
    source: "site",
  });

  return {
    status: 200,
    body: {
      ok: true,
      order_id: armed.orderId,
      armed_at: armed.armedAt,
      loan_id: fields.LoanId,
      collateral_symbol: armed.mint?.symbol || null,
      trigger_kind: triggerKind,
      trigger_value_micro: triggerValueMicro.toString(),
      // The applied initial slippage AFTER any liquidity-aware bump.
      slippage_bps: armed.initialSlippageBpsApplied ?? slippageBps,
      // Surface the bump so the site can render "we armed at 5% instead
      // of 2% because $TOKEN is thin." Only present when a bump landed.
      ...(armed.initialSlippageBpsApplied !== armed.initialSlippageBpsRequested
        ? {
            slippage_bps_requested: armed.initialSlippageBpsRequested,
            liquidity_floor_bps: armed.liquidityTierFloorBps,
            liquidity_usd: armed.liquidityUsd,
          }
        : {}),
      sell_destination: dest,
      expires_at: expiresAt,
      multiplier: multiplierUsed,
      current_usd: currentUsdRef,
      target_usd: targetUsdRef,
      source: "site",
    },
  };
}

/* ─────────────────────────────────────────────────────────────────
 * DELETE /api/v1/site/limit-close/cancel
 *
 * Signed envelope shape:
 *   magpie: limit-close-cancel/v1
 *   From: <signer_wallet>
 *   OrderId: <db_order_id>
 *   Nonce: <random>
 *   IssuedAt: <ISO timestamp>
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseCancel(req) {
  const auth = await authSignedEnvelope(req, "limit-close-cancel/v1", ["OrderId"]);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error, ...(auth.detail ? { detail: auth.detail } : {}), ...(auth.retry_after_seconds ? { retry_after_seconds: auth.retry_after_seconds } : {}) } };
  const { userId, fields } = auth;

  const orderId = Number(fields.OrderId);
  if (!Number.isInteger(orderId)) return { status: 400, body: { error: "invalid_OrderId" } };

  const r = await cancelOrder({
    orderId,
    userId,
    reason: "site_cancel",
  });
  if (!r.ok) return { status: 409, body: { error: r.error } };
  return { status: 200, body: { ok: true, cancelled_order_id: r.orderId } };
}
