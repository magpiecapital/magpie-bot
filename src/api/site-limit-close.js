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
// tweetnacl is a CommonJS module — the named-import form (`import { sign }`)
// breaks under Node ESM in some environments. Use the default-import +
// destructure pattern (same as src/api/credit-attest.js).
import nacl from "tweetnacl";
const { sign: naclSign } = nacl;
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

  // ── Nonce uniqueness enforcement ─────────────────────────────
  // Audit fix 2026-06-12: every other signed-envelope endpoint
  // (me-export, wallets-api, ai-chat, support-ask) records consumed
  // nonces in used_nonces and rejects duplicates inside the freshness
  // window. site-limit-close had only the freshness + per-signer rate
  // limit before — sufficient against most attackers but weaker than
  // the rest of the system. Bringing into line.
  //
  // Purpose tag separates limit-close nonces from other endpoints' so
  // a nonce reused for a different action doesn't collide. Action-binding
  // header (magpie:) already prevents the cross-action replay; this
  // closes the SAME-action replay leg.
  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [String(fields.Nonce), `limit_close:${expectedMagpieHeader}`, signerPubkey],
    );
  } catch (err) {
    if (err.code === "23505") {
      return { ok: false, status: 409, error: "nonce_already_used" };
    }
    console.error("[site-limit-close] nonce insert threw:", err.message);
    return { ok: false, status: 500, error: "nonce_check_failed" };
  }

  // Wallet ownership + custodial check.
  // Prefer the TG-linked wallet row when multiple exist; see
  // src/services/wallet-owner-resolver.js. We need encrypted_secret
  // here so we can't use the helper directly — inline the same
  // ranking so the chosen row is consistent with /repay etc.
  const { rows: [walletRow] } = await query(
    `SELECT w.user_id, w.encrypted_secret, w.source
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      ORDER BY (u.telegram_id IS NOT NULL AND u.telegram_id > 0) DESC,
               w.is_active DESC,
               w.created_at DESC
      LIMIT 1`,
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

  return { ok: true, userId: walletRow.user_id, signerPubkey, fields, body };
}

/* ─────────────────────────────────────────────────────────────────
 * GET /api/v1/site/limit-close?wallet=<pubkey>
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseList(req, url) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  const wallet = url.searchParams.get("wallet") || "";
  if (!isValidPubkey(wallet)) return { status: 400, body: { error: "invalid_wallet" } };

  // Same TG-preferring ranking as the arm path so the list shows
  // orders for the wallet's canonical user_id.
  const { rows: [walletRow] } = await query(
    `SELECT w.user_id, w.encrypted_secret
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      ORDER BY (u.telegram_id IS NOT NULL AND u.telegram_id > 0) DESC,
               w.is_active DESC,
               w.created_at DESC
      LIMIT 1`,
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
            -- Remainder watcher columns (migration 066, engine maintains
            -- them per fire). NULL on pre-066 rows → site falls back to
            -- collateral_amount cleanly.
            COALESCE(l.current_collateral_amount, l.collateral_amount)::text
              AS current_collateral_amount,
            COALESCE(l.sol_proceeds_amount, 0)::text AS sol_proceeds_amount,
            COALESCE(l.auto_sells_fired, 0) AS auto_sells_fired,
            l.original_loan_amount_lamports::text AS owed_lamports,
            l.start_timestamp, l.due_timestamp,
            l.program_id,
            sm.symbol AS collateral_symbol, sm.decimals AS collateral_decimals,
            sm.category AS collateral_category, sm.enabled AS collateral_enabled
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE l.user_id = $1 AND l.borrower_wallet = $2 AND l.status = 'active'
      ORDER BY l.start_timestamp DESC
      LIMIT 100`,
    [walletRow.user_id, wallet],
  );

  // Orders for those loans. Returns BOTH currently-active AND fired/
  // cancelled orders within the loan's lifetime so the dashboard can
  // show ladder progression (e.g. "80% leg fired @ $180 ✓ | 20% leg
  // armed @ $182"). Slice_pct is included so the UI can render the
  // ladder composition (default 10000 = 100% if column NULL).
  const loanIds = loans.map((l) => l.id);
  let orders = [];
  if (loanIds.length > 0) {
    const r = await query(
      `SELECT id, loan_id, trigger_kind, trigger_value_micro::text AS trigger_value_micro,
              COALESCE(trigger_direction, 'above') AS trigger_direction,
              slippage_bps, sell_destination, status,
              armed_at, expires_at,
              max_slippage_bps_cap, auto_escalate_slippage,
              source, source_agent_pubkey,
              trailing_distance_bps,
              peak_price_micros::text AS peak_price_micros,
              COALESCE(slice_pct, 10000) AS slice_pct,
              ladder_group_id,
              -- Fire details (NULL for non-fired orders)
              fired_at,
              proceeds_lamports::text AS proceeds_lamports,
              net_to_user_lamports::text AS net_to_user_lamports,
              tx_signature_swap,
              tx_signature_repay,
              -- Failure details (populated when status = 'failed' or
              -- 'max_retries_exceeded'). Dashboard renders the leg in
              -- red with this reason per the active-loans-dashboard rule.
              failure_reason,
              failure_count,
              cancellation_reason
         FROM limit_close_orders
        WHERE loan_id = ANY($1::bigint[])
          AND status IN ('armed','firing','twap_in_progress','awaiting_user','fired','cancelled','failed','max_retries_exceeded')
        ORDER BY
          -- Active states sort first by armed_at DESC, history by fired_at DESC
          CASE WHEN status IN ('fired','cancelled','failed','max_retries_exceeded') THEN 1 ELSE 0 END,
          armed_at DESC`,
      [loanIds],
    );
    orders = r.rows;
  }

  // Pending intent reconciliation (operator-mandated 2026-06-16 PM,
  // feedback_every_arm_envelope_must_reach_server.md). For each loan,
  // look up arm_intents rows that are still pending (no matching
  // armed order) so the dashboard can render the "Your auto-sell
  // didn't finish arming" recovery banner with one-click retry.
  let pendingIntents = [];
  try {
    const loanChainIds = loans.map((l) => l.loan_id);
    if (loanChainIds.length > 0) {
      const ir = await query(
        `SELECT id, loan_id_chain, direction, target_kind,
                target_value_micro::text AS target_value_micro,
                slice_pct_bps, source, created_at
           FROM arm_intents
          WHERE wallet = $1
            AND status = 'pending'
            AND loan_id_chain = ANY($2::text[])
            AND created_at > NOW() - INTERVAL '24 hour'
          ORDER BY created_at DESC`,
        [wallet, loanChainIds],
      );
      pendingIntents = ir.rows;
    }
  } catch (err) {
    // arm_intents table may not exist yet on pre-071 schemas; degrade
    // gracefully so the dashboard still renders.
    console.warn(`[site-limit-close] arm_intents lookup failed (pre-071?): ${err.message?.slice(0, 80)}`);
  }

  // Eligibility annotation per loan — same checks the arm endpoint
  // will apply. Surface it here so the UI can disable the Arm button
  // for ineligible loans with a clear reason.
  //
  // 2026-06-13: split eligibility by direction. A loan may legitimately
  // have BOTH a TP (above) and SL (below) armed at once — the unique
  // index since migration 047 is (loan_id, trigger_direction), not
  // just loan_id. The site can offer TP independently of SL, so we
  // emit eligibility per slot.
  const armedAboveByLoan = new Set(
    orders.filter((o) => o.status === "armed" && o.trigger_direction === "above").map((o) => Number(o.loan_id)),
  );
  const armedBelowByLoan = new Set(
    orders.filter((o) => o.status === "armed" && o.trigger_direction === "below").map((o) => Number(o.loan_id)),
  );
  // V4-exclusive enforcement: when V4_EXIT_EXCLUSIVE_ENFORCE=true (the
  // operator-stated policy posture as of 2026-06-15), only loans that
  // landed on the V4 program can be armed with new exits. Mirrors the
  // arm-core gate (`exits_require_v4_loan`) so the dashboard renders
  // the ineligibility BEFORE the user signs an envelope that would
  // just bounce. Operator hit this on 2026-06-15 with $KINS and $PUMP
  // V1 loans that still showed the "Set upside auto-sell" CTA.
  const v4EnforceOn = process.env.V4_EXIT_EXCLUSIVE_ENFORCE === "true";
  const v4ProgramIdStr = process.env.PROGRAM_ID_V4 ?? null;

  const annotated = loans.map((l) => {
    const baseReasons = [];
    if (BigInt(l.owed_lamports) < MIN_LOAN_LAMPORTS) baseReasons.push("loan_below_minimum_size");
    if (!l.collateral_enabled) baseReasons.push("collateral_not_enabled");
    // V4 enforcement: non-V4 loans can't take new exits. NOTE: this
    // intentionally does NOT touch already-armed orders — those keep
    // firing through their legacy path. Only blocks NEW arms.
    if (v4EnforceOn && v4ProgramIdStr && l.program_id && l.program_id !== v4ProgramIdStr) {
      baseReasons.push("exits_require_v4_loan");
    }
    // 2026-06-13 (PR C): RWA categories (stock/etf/metal) are NOW eligible
    // for limit-close. Engine's V2 fill path landed in PR B; arm-core
    // applies a weekend-aware initial-slippage bump for thin RWA routes.
    const tpReasons = [...baseReasons];
    const slReasons = [...baseReasons];
    if (armedAboveByLoan.has(Number(l.id))) tpReasons.push("take_profit_already_armed");
    if (armedBelowByLoan.has(Number(l.id))) slReasons.push("stop_loss_already_armed");
    // Back-compat: pre-2026-06-13 callers read is_eligible_for_takeprofit
    // + ineligibility_reasons. Keep them representing the TP slot so
    // older site bundles don't break mid-deploy.
    return {
      ...l,
      owed_sol: Number(l.owed_lamports) / 1e9,
      is_eligible_for_takeprofit: tpReasons.length === 0,
      ineligibility_reasons: tpReasons,
      is_eligible_for_stoploss: slReasons.length === 0,
      stoploss_ineligibility_reasons: slReasons,
    };
  });

  return {
    status: 200,
    body: {
      linked: true,
      custodial: isCustodial,
      loans: annotated,
      orders,
      // Pending arm intents (operator-mandated 2026-06-16 PM,
      // feedback_every_arm_envelope_must_reach_server.md). Dashboard
      // reconciles against orders: an intent without a matching armed
      // order means the auto-arm chain silently failed → render the
      // V4 recovery banner with one-click retry.
      pending_intents: pendingIntents,
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
 *   Direction: above            (optional; "above" = take-profit, "below"
 *                                = stop-loss. Defaults to "above" for
 *                                back-compat with pre-2026-06-13 sites.)
 *   Target: 2x                  (multiplier; OR Price: 0.005 OR MC: 150m.
 *                                For Direction: below, multiplier MUST be
 *                                < 1 (e.g. 0.7x = "sell if price drops
 *                                to 70% of current"). Omit when using
 *                                Trailing: below.)
 *   Trailing: 1000              (optional; trailing-stop distance in bps,
 *                                50-5000. ONLY valid with Direction:
 *                                below. When set, the effective stop
 *                                floats with the highest observed price
 *                                — see migration 057. Trailing arms
 *                                seed peak = current price; explicit
 *                                Target/Price/MC is ignored.)
 *   Slippage: 200               (optional, default 200, bps)
 *   Dest: sol                   (optional, default sol)
 *   Expire: 30d                 (optional, days or hours)
 *   Slice: 7000                 (optional, default 10000 = 100% = full close.
 *                                Set <10000 to arm a LADDER LEG that sells
 *                                slice/10000 of original collateral when
 *                                this leg fires. arm-core stamps a shared
 *                                ladder_group_id when siblings exist on the
 *                                same loan/direction. Migration 065 trigger
 *                                enforces SUM(slice) <= 10000.)
 *   Nonce: <random_base58_or_uuid>
 *   IssuedAt: <ISO timestamp>
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseArm(req) {
  // V4 Hardening T1 (2026-06-15 PM): structured entry log so every arm
  // POST is visible in Railway, including those rejected by auth or
  // parsing. Operator hit a class of bug where dashboard arms produced
  // ZERO orders in DB and NO traces in bot logs — we couldn't tell if
  // the request was even reaching the bot. This log closes that gap.
  // Logs only request metadata (wallet, loan_id, envelope tag) — no
  // private fields, no signatures.
  const reqId = Math.random().toString(36).slice(2, 10);
  console.log(`[arm] ENTRY req=${reqId} ip=${req.socket?.remoteAddress?.slice(0, 20) || "?"} ua="${(req.headers["user-agent"] || "").slice(0, 60)}"`);
  const auth = await authSignedEnvelope(req, "limit-close-arm/v1", ["LoanId"]);
  if (!auth.ok) {
    console.warn(`[arm] AUTH-FAIL req=${reqId} status=${auth.status} error=${auth.error} detail=${(auth.detail || "").slice(0, 120)}`);
    return { status: auth.status, body: { error: auth.error, ...(auth.detail ? { detail: auth.detail } : {}), ...(auth.expected ? { expected: auth.expected } : {}), ...(auth.retry_after_seconds ? { retry_after_seconds: auth.retry_after_seconds } : {}) } };
  }
  const { userId, fields } = auth;
  console.log(
    `[arm] AUTH-OK req=${reqId} user_id=${userId} signer=${auth.signerPubkey.slice(0, 8)}… ` +
    `loan_id_chain=${fields.LoanId} direction=${fields.Direction || "above"} ` +
    `target=${fields.Target || ""} price=${fields.Price || ""} mc=${fields.MC || ""} ` +
    `trailing=${fields.Trailing || ""} slippage=${fields.Slippage || ""} slice=${fields.Slice || ""} dest=${fields.Dest || ""}`,
  );

  // ── Parse direction ──
  // 2026-06-13: site now supports stop-loss arming. Old envelopes that
  // don't include Direction get the historical default of "above" (TP).
  const triggerDirection = (fields.Direction || "above").toLowerCase();
  if (triggerDirection !== "above" && triggerDirection !== "below") {
    return { status: 400, body: { error: "invalid_direction", detail: "Direction must be 'above' (take-profit) or 'below' (stop-loss)." } };
  }
  const isSl = triggerDirection === "below";

  // ── Parse trailing-distance (optional, SL only) ──
  let trailingDistanceBps = null;
  if (fields.Trailing !== undefined) {
    if (!isSl) {
      return { status: 400, body: { error: "trailing_only_valid_on_stop_loss", detail: "Trailing: requires Direction: below. Take-profit always fires at a fixed target." } };
    }
    const t = Number(String(fields.Trailing).trim());
    if (!Number.isInteger(t) || t < 50 || t > 5000) {
      return { status: 400, body: { error: "invalid_trailing_distance_bps", detail: "Trailing must be an integer in [50, 5000] bps (0.5%-50%)." } };
    }
    trailingDistanceBps = t;
  }

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
      if (!Number.isFinite(mult) || mult <= 0) {
        return { status: 400, body: { error: "invalid_target_multiplier" } };
      }
      // TP must be > 1x, SL must be < 1x. Mixing them up is almost
      // always a UX bug (e.g. SL form submitting "2x"); fail loud so
      // the site can surface a useful error.
      if (!isSl && mult <= 1) {
        return { status: 400, body: { error: "invalid_target_multiplier", detail: "Take-profit multiplier must be > 1× (e.g. 2× to fire when price doubles). For a downside target, set Direction: below and use a multiplier < 1× (e.g. 0.7×)." } };
      }
      if (isSl && mult >= 1) {
        return { status: 400, body: { error: "invalid_target_multiplier", detail: "Stop-loss multiplier must be < 1× (e.g. 0.7× to fire when price drops to 70% of current). For an upside target, set Direction: above and use a multiplier > 1×." } };
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
  } else if (trailingDistanceBps != null) {
    // Trailing arms don't need an explicit target — the watcher seeds
    // peak = current price and computes effective trigger as
    // peak × (1 - trailing/10000). We still need a triggerKind for
    // arm-core's downstream logic. Default to price_usd as the most
    // common; the multiplier-to-price helper below picks up live
    // price and seeds triggerValueMicro at that × (1-trailing).
    triggerKind = "price_usd";
    // Defer triggerValueMicro resolution to the multiplier path —
    // multiplierUsed = (1 - trailing/10000) accomplishes "set initial
    // trigger to current-price × that ratio", which is the right seed
    // for the watcher's first-tick peak.
    multiplierUsed = 1 - (trailingDistanceBps / 10_000);
  } else {
    return { status: 400, body: { error: "missing_target", detail: "Provide Target (e.g. 2x), Price ($0.005), or MC ($150m). For a trailing stop, send Trailing: <bps>." } };
  }

  const slippageBps = fields.Slippage ? Number(fields.Slippage) : 200;
  // Upper bound matches arm-core's MAX_INITIAL_SLIPPAGE_BPS (2500 = 25%) so
  // moon-pump UX can request a wide initial slippage when the user knows the
  // token is thin. Arm-core then auto-derives a wider cap on top.
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 2500) {
    return { status: 400, body: { error: "invalid_slippage" } };
  }
  const dest = (fields.Dest || "sol").toLowerCase();

  // ── Slice (ladder leg) parsing ──
  // Optional Slice: <bps>  field on the envelope. When set <10000, this
  // arm is a ladder leg (one of N siblings sharing a ladder_group_id).
  // The bot's arm-core stamps ladder_group_id + original_collateral_amount
  // when slicePct<10000. Multiple legs from the same loan/direction with
  // sum(slice_pct)<=10000 are enforced by the migration-065 trigger.
  let slicePctApplied = 10000;
  if (fields.Slice !== undefined) {
    const raw = String(fields.Slice).trim();
    const s = Number(raw);
    if (!Number.isInteger(s) || s < 1 || s > 10000) {
      return { status: 400, body: { error: "invalid_slice_pct", detail: "Slice must be an integer in [1, 10000] bps (0.01%–100%)." } };
    }
    slicePctApplied = s;
  }

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
    // allowBelowOne is the contract with resolveMultiplierToPrice — it
    // rejects mismatched direction/multiplier pairs as a defense-in-
    // depth backstop. We've already validated above, but pass through
    // so a future caller bypassing our checks still gets the guard.
    const r = await resolveMultiplierToPrice(loanLite.collateral_mint, multiplierUsed, { allowBelowOne: isSl });
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
    triggerDirection,
    trailingDistanceBps,
    slippageBps,
    sellDestination: dest,
    expiresAt,
    slicePct: slicePctApplied,
    armNote: `armed via site (${trailingDistanceBps != null ? `TRAILING-SL ${trailingDistanceBps/100}%` : (isSl ? "SL" : "TP")}${slicePctApplied < 10000 ? ` slice=${(slicePctApplied/100).toFixed(0)}%` : ""}) by ${auth.signerPubkey.slice(0, 8)}…`,
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
/* ── POST /api/v1/site/limit-close/modify ──────────────────────────
 *
 * In-place modify an armed order without canceling first. Same auth
 * pattern as /cancel — Ed25519 signed envelope; the wallet that
 * signed must be the order's owner.
 *
 * Envelope (signed message body):
 *   Action: limit-close-modify/v1
 *   OrderId: <int>
 *   Price?: <usd_per_token>     — change trigger_value_micro for price_usd
 *   MC?: <mc_usd>               — change trigger_value_micro for mc_usd
 *   Slippage?: <bps integer>    — change slippage_bps
 *   Dest?: sol | usdc           — change sell_destination
 *   Expires?: <ISO|none>        — change expires_at (or "none" to clear)
 *   Trailing?: <bps|"none">     — change trailing_distance_bps (50-5000 bps)
 *                                  or "none" to clear trailing (back to fixed SL).
 *                                  First-time enable seeds peak_price_micros from
 *                                  live price; later changes recompute trigger
 *                                  from the existing peak so the new distance is
 *                                  live on the next watcher tick.
 *   Wallet: <pubkey>
 *   IssuedAt: <ISO>
 *
 * At least one of Price / MC / Slippage / Dest / Expires / Trailing required.
 *
 * Pairs with magpie-bot#148 (modifyOrder core) + magpie-x402#29
 * (x402 forwarder). Brings site users to parity with TG and agent
 * surfaces — fine-tune your trigger without a cancel/re-arm market-
 * move gap.
 * ────────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseModify(req) {
  const auth = await authSignedEnvelope(req, "limit-close-modify/v1", ["OrderId"]);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error, ...(auth.detail ? { detail: auth.detail } : {}), ...(auth.retry_after_seconds ? { retry_after_seconds: auth.retry_after_seconds } : {}) } };
  const { userId, fields } = auth;

  const orderId = Number(fields.OrderId);
  if (!Number.isInteger(orderId)) return { status: 400, body: { error: "invalid_OrderId" } };

  const updates = {};
  if (fields.Price !== undefined) {
    const usd = Number(String(fields.Price).replace(/^\$/, ""));
    if (!Number.isFinite(usd) || usd <= 0) return { status: 400, body: { error: "invalid_price" } };
    updates.triggerValueMicro = BigInt(Math.round(usd * 1e6)).toString();
  } else if (fields.MC !== undefined) {
    const raw = String(fields.MC).replace(/^\$/, "");
    const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)([KMBkmb])?$/);
    if (!m) return { status: 400, body: { error: "invalid_mc" } };
    const n = Number(m[1]);
    const mul = (m[2] || "").toLowerCase() === "b" ? 1e9 : (m[2] || "").toLowerCase() === "m" ? 1e6 : (m[2] || "").toLowerCase() === "k" ? 1e3 : 1;
    const usd = n * mul;
    updates.triggerValueMicro = BigInt(Math.round(usd * 1e6)).toString();
  }
  if (fields.Slippage !== undefined) {
    const bps = Number(fields.Slippage);
    if (!Number.isInteger(bps) || bps < 10 || bps > 2500) {
      return { status: 400, body: { error: "invalid_slippage" } };
    }
    updates.slippageBps = bps;
  }
  if (fields.Dest !== undefined) {
    const d = String(fields.Dest).toLowerCase();
    if (d !== "sol" && d !== "usdc") return { status: 400, body: { error: "invalid_dest" } };
    updates.sellDestination = d;
  }
  if (fields.Expires !== undefined) {
    if (String(fields.Expires).toLowerCase() === "none") {
      updates.expiresAt = null;
    } else if (Number.isNaN(Date.parse(fields.Expires))) {
      return { status: 400, body: { error: "invalid_expires" } };
    } else {
      updates.expiresAt = new Date(fields.Expires).toISOString();
    }
  }
  if (fields.Trailing !== undefined) {
    const t = String(fields.Trailing).toLowerCase();
    if (t === "none" || t === "off" || t === "0") {
      updates.trailingDistanceBps = null;
    } else {
      const bps = Number(t);
      if (!Number.isInteger(bps) || bps < 50 || bps > 5000) {
        return { status: 400, body: { error: "invalid_trailing_distance_bps", detail: "Trailing must be an integer in [50, 5000] bps, or 'none' to clear." } };
      }
      updates.trailingDistanceBps = bps;
    }
  }
  if (Object.keys(updates).length === 0) {
    return { status: 400, body: { error: "no_changes_supplied" } };
  }

  const { modifyOrder } = await import("../services/limit-close-arm-core.js");
  const r = await modifyOrder({
    orderId,
    userId,
    ...updates,
  });
  if (!r.ok) {
    const statusMap = {
      not_modifiable_or_not_found: 409,
      invalid_trigger_value: 400,
      trigger_value_out_of_range: 400,
      invalid_slippage_bps: 400,
      slippage_exceeds_order_cap: 403,
      invalid_sell_destination: 400,
      invalid_expires_at: 400,
      trigger_would_fire_immediately: 409,
      no_changes_supplied: 400,
      invalid_trailing_distance_bps: 400,
      trailing_only_valid_on_stop_loss: 409,
    };
    return {
      status: statusMap[r.error] || 409,
      body: { error: r.error, ...(r.detail ? { detail: r.detail } : {}) },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      order_id: r.order.id,
      changed_fields: r.changedFields,
      trigger_value_micro: r.order.trigger_value_micro,
      slippage_bps: r.order.slippage_bps,
      sell_destination: r.order.sell_destination,
      expires_at: r.order.expires_at,
      updated_at: r.order.updated_at,
      // Echo trailing state so the dashboard can update its in-memory
      // armed-order view without a separate refetch round-trip.
      trailing_distance_bps: r.order.trailing_distance_bps ?? null,
      peak_price_micros: r.order.peak_price_micros ?? null,
    },
  };
}

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

/* ─────────────────────────────────────────────────────────────────
 * POST /api/v1/site/limit-close/intent
 *
 * Lightweight intent beacon, operator-mandated 2026-06-16 PM (per
 * feedback_every_arm_envelope_must_reach_server.md). The site POSTs
 * this BEFORE asking Phantom to sign so the server has a durable
 * record of the user's intent even if the subsequent signed arm
 * silently fails.
 *
 * Auth: unsigned. This endpoint stores intent, NOT authoritative
 * state — no funds move, no orders arm. The wallet field is the
 * user's claimed pubkey; we record it as-is and resolve to user_id
 * via wallets.public_key lookup. A bad actor can spam intents on any
 * wallet, but they can never cause an actual fire because the signed
 * /arm endpoint still gates on Ed25519 verification + the cosign
 * cron only acts on `status='armed'` rows.
 *
 * Body: {
 *   wallet: string,
 *   loan_id_chain: string,
 *   direction: 'above' | 'below',
 *   target_kind: 'multiplier' | 'price_usd' | 'mc_usd' | 'price_sol' | 'trailing',
 *   target_value_micro: string | number,
 *   slice_pct_bps?: number,
 *   source?: string (defaults to 'site')
 * }
 *
 * Returns: { ok: true, intent_id: number }
 * The site uses intent_id when subsequently POSTing /arm so the
 * server can mark the intent armed on success.
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseIntent(req) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "invalid_body" } };
  }
  const {
    wallet,
    loan_id_chain,
    direction,
    target_kind,
    target_value_micro,
    slice_pct_bps,
    source,
  } = body;

  if (typeof wallet !== "string" || wallet.length < 32 || wallet.length > 44) {
    return { status: 400, body: { error: "invalid_wallet" } };
  }
  if (typeof loan_id_chain !== "string" || !/^\d+$/.test(loan_id_chain)) {
    return { status: 400, body: { error: "invalid_loan_id_chain" } };
  }
  if (direction !== "above" && direction !== "below") {
    return { status: 400, body: { error: "invalid_direction" } };
  }
  const validKinds = new Set(["multiplier", "price_usd", "mc_usd", "price_sol", "trailing"]);
  if (!validKinds.has(target_kind)) {
    return { status: 400, body: { error: "invalid_target_kind" } };
  }
  // target_value_micro: accept string or number, store as numeric.
  const tvm = typeof target_value_micro === "string" ? target_value_micro : String(target_value_micro);
  if (!/^\d+$/.test(tvm)) {
    return { status: 400, body: { error: "invalid_target_value_micro" } };
  }
  const sliceBps =
    slice_pct_bps == null
      ? null
      : Number.isInteger(slice_pct_bps) && slice_pct_bps > 0 && slice_pct_bps <= 10000
        ? slice_pct_bps
        : null;
  const src = typeof source === "string" && source.length <= 32 ? source : "site";

  // Resolve user_id from wallets.public_key. Best-effort — intent is
  // recorded even if the wallet isn't linked yet, which lets us spot
  // "pre-link" intents on the reconciliation cron.
  let userId = null;
  try {
    const walletRow = await query(
      "SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1",
      [wallet],
    );
    if (walletRow.rows.length > 0) userId = walletRow.rows[0].user_id;
  } catch (err) {
    console.warn("[intent] wallet lookup failed:", err.message?.slice(0, 100));
  }

  // De-dupe before INSERT — operator-mandated 2026-06-17 03:50 UTC
  // (feedback_no_duplicate_intents_in_recovery_banner_NEVER.md, ZERO
  // TOLERANCE). If an identical pending intent exists for the same
  // (wallet, loan_id_chain, direction, target_kind, target_value_micro,
  // slice_pct_bps) within the last 5 minutes, return its id instead of
  // writing a new row. Prevents the SPCX loan 816 incident where user
  // retried a 2-leg ladder twice and ended up with 4 duplicate pending
  // intents surfaced as 4 buttons on the recovery banner.
  //
  // The 5-min window is the same idempotency window used by the
  // breadcrumb writer in arm-core.js — every entry point must agree.
  try {
    const dedup = await query(
      `SELECT id, created_at FROM arm_intents
        WHERE wallet = $1
          AND loan_id_chain = $2
          AND direction = $3
          AND target_kind = $4
          AND target_value_micro = $5::numeric
          AND COALESCE(slice_pct_bps, 0) = COALESCE($6::int, 0)
          AND status = 'pending'
          AND created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC
        LIMIT 1`,
      [wallet, loan_id_chain, direction, target_kind, tvm, sliceBps],
    );
    if (dedup.rows.length > 0) {
      const existing = dedup.rows[0];
      return {
        status: 200,
        body: { ok: true, intent_id: existing.id, created_at: existing.created_at, deduped: true },
      };
    }
  } catch (err) {
    // Dedupe is best-effort. If it fails, fall through to INSERT —
    // safety net is still in place via the dashboard's dedupe logic.
    console.warn("[intent] dedupe lookup failed (proceeding):", err.message?.slice(0, 120));
  }

  try {
    const { rows } = await query(
      `INSERT INTO arm_intents
         (user_id, wallet, loan_id_chain, direction, target_kind, target_value_micro, slice_pct_bps, source, status)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, 'pending')
       RETURNING id, created_at`,
      [userId, wallet, loan_id_chain, direction, target_kind, tvm, sliceBps, src],
    );
    const intent = rows[0];
    return {
      status: 201,
      body: { ok: true, intent_id: intent.id, created_at: intent.created_at },
    };
  } catch (err) {
    console.error("[intent] INSERT failed:", err.message?.slice(0, 200));
    return { status: 500, body: { error: "intent_persist_failed" } };
  }
}

/* ─────────────────────────────────────────────────────────────────
 * POST /api/v1/site/limit-close/arm-batch
 *
 * Operator-mandated 2026-06-16 PM
 * (feedback_one_signature_for_n_legs_always.md). ONE Phantom signature
 * arms ALL legs of a ladder atomically. Replaces the N-popups-for-N-
 * legs pattern that caused silent-leg-drop UX disasters on loans 798
 * and 802 when Phantom sessions died between sequential signs.
 *
 * Signed envelope shape:
 *   magpie: limit-close-arm-batch/v1
 *   From:   <signer_wallet>
 *   LoanId: <chain_loan_id>
 *   Legs:   <json-array>
 *   Nonce / Timestamp via signed_message envelope
 *
 * Where Legs is a JSON-stringified array:
 *   [
 *     {"d":"above","k":"price_usd","v":"212000000","s":5000,"slip":200},
 *     {"d":"above","k":"price_usd","v":"230000000","s":5000,"slip":200}
 *   ]
 *   - d: 'above' (TP) | 'below' (SL)
 *   - k: 'price_usd' | 'mc_usd' | 'price_sol'
 *   - v: trigger_value_micro as string
 *   - s: slice_bps (1..10000)
 *   - slip: slippage_bps initial (10..MAX_PROTOCOL_SLIPPAGE_BPS)
 *   - intent_id (optional): pending arm_intents row id to mark armed
 *
 * Body may ALSO include `intent_ids: [int, ...]` at the top level so
 * the server reconciles each leg's intent without it being in the
 * signed payload. Either path works; signed payload takes precedence.
 *
 * Returns:
 *   201 + { ok: true, order_ids: [...], ladder_group_ids: { above?, below? } }
 * or
 *   409 + { ok: false, error, failed_leg_index, detail }
 * ───────────────────────────────────────────────────────────────── */
export async function handleSiteLimitCloseArmBatch(req) {
  const auth = await authSignedEnvelope(req, "limit-close-arm-batch/v1", [
    "LoanId",
    "Legs",
  ]);
  if (!auth.ok) {
    return {
      status: auth.status,
      body: {
        error: auth.error,
        ...(auth.detail ? { detail: auth.detail } : {}),
        ...(auth.expected ? { expected: auth.expected } : {}),
        ...(auth.retry_after_seconds ? { retry_after_seconds: auth.retry_after_seconds } : {}),
      },
    };
  }
  const { userId, fields, body: rawBody } = auth;
  const reqId = (Math.random() * 1e9 | 0).toString(36);

  // Parse Legs (signed payload — tamper-proof from middlemen).
  let legs;
  try {
    legs = JSON.parse(String(fields.Legs));
  } catch (e) {
    return { status: 400, body: { error: "legs_json_parse_failed", detail: e.message?.slice(0, 120) } };
  }
  if (!Array.isArray(legs)) {
    return { status: 400, body: { error: "legs_not_an_array" } };
  }
  if (legs.length === 0) {
    return { status: 400, body: { error: "no_legs_supplied" } };
  }
  if (legs.length > 8) {
    return { status: 400, body: { error: "too_many_legs", detail: "max 8 per batch" } };
  }

  // Translate the compact wire shape (d/k/v/s/slip) to armOrderBatch's
  // friendlier internal shape.
  const armCoreLegs = [];
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (!l || typeof l !== "object") {
      return { status: 400, body: { error: "leg_not_object", failed_leg_index: i } };
    }
    // Multiplier kind needs to forward the raw multiplier to arm-core's
    // batch oracle-resolve phase. l.multiplier OR l.v (which carries
    // the multiplier as a stringified number when k==="multiplier").
    const armLeg = {
      direction: l.d,
      kind: l.k,
      valueMicro: l.v,
      sliceBps: Number.isInteger(l.s) ? l.s : 10000,
      slippageBps: Number.isInteger(l.slip) ? l.slip : (l.d === "below" ? 300 : 200),
      expiresAt: l.exp || null,
    };
    if (l.k === "multiplier" || typeof l.multiplier === "number") {
      armLeg.multiplier =
        typeof l.multiplier === "number" && l.multiplier > 0
          ? l.multiplier
          : Number(l.v);
    }
    armCoreLegs.push(armLeg);
  }

  // intent_ids may travel on the body (cheaper than padding the
  // signed envelope). Site populates them from the postArmIntent
  // calls that happen leg-by-leg in the picker.
  const intentIds = Array.isArray(rawBody?.intent_ids) ? rawBody.intent_ids : null;

  console.log(
    `[arm-batch] AUTH-OK req=${reqId} user_id=${userId} signer=${auth.signerPubkey.slice(0, 8)}… ` +
    `loan_id_chain=${fields.LoanId} n_legs=${armCoreLegs.length} ` +
    `legs=${armCoreLegs.map((l) => `${l.direction}@${l.valueMicro}/${l.sliceBps}bps`).join(",")}`,
  );

  // Hand off to arm-core batch primitive.
  const { armOrderBatch } = await import("../services/limit-close-arm-core.js");
  const result = await armOrderBatch({
    userId,
    source: "site",
    loanIdChain: String(fields.LoanId),
    legs: armCoreLegs,
    intentIds,
    armNotePrefix: `armed via site batch by ${auth.signerPubkey.slice(0, 8)}…`,
  });

  if (!result.ok) {
    console.log(
      `[arm-batch] FAIL req=${reqId} error=${result.error} failed_leg=${result.failedLegIndex ?? "n/a"} detail=${result.detail?.slice?.(0, 200) || ""}`,
    );
    return {
      status: 409,
      body: {
        ok: false,
        error: result.error,
        ...(result.failedLegIndex != null ? { failed_leg_index: result.failedLegIndex } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      },
    };
  }

  console.log(
    `[arm-batch] SUCCESS req=${reqId} order_ids=${result.orderIds.join(",")} ` +
    `ladder_above=${result.ladderGroupIds.above?.slice(0, 8) || "-"} ` +
    `ladder_below=${result.ladderGroupIds.below?.slice(0, 8) || "-"}`,
  );

  // Best-effort single combined DM. The site already shows immediate
  // optimistic UI on the dashboard, so this is the operator-visible
  // record for the borrower. Failure here does NOT undo the arm.
  try {
    const { enqueueNotification } = await import("../services/notification-sender.js");
    await enqueueNotification({
      userId,
      kind: "limit_close_armed_batch",
      payload: {
        loan_id_chain: result.loanIdChain,
        collateral_symbol: result.collateralSymbol,
        n_legs: result.orderIds.length,
        order_ids: result.orderIds,
        legs: result.legs.map((l) => ({
          order_id: l.orderId,
          direction: l.direction,
          trigger_kind: l.triggerKind,
          trigger_value_micro: l.triggerValueMicro,
          slice_pct_bps: l.slicePctBps,
        })),
        source: "site",
      },
    });
  } catch (dmErr) {
    console.warn(`[arm-batch] DM enqueue failed (non-fatal): ${dmErr.message?.slice(0, 120)}`);
  }

  return {
    status: 201,
    body: {
      ok: true,
      order_ids: result.orderIds,
      ladder_group_ids: result.ladderGroupIds,
      legs: result.legs,
    },
  };
}
