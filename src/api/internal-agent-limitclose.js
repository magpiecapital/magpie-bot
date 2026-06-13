/**
 * Internal endpoint — POST /api/v1/internal/agent/limit-close/arm.
 *
 * Called by the magpie-x402 service AFTER it has verified an x402
 * payment from the agent. We do not re-verify the payment here; the
 * x402 service is the trusted gatekeeper for that. Instead we trust
 * INTERNAL_API_TOKEN-gated callers and focus on the authorization
 * model: did the wallet's owner pre-authorize THIS agent to arm
 * THIS kind of order within THESE bounds?
 *
 * Auth model (defense in depth):
 *   1. Network layer:  X-Internal-Token must match INTERNAL_API_TOKEN.
 *      Anyone past this is treated as "the x402 service".
 *   2. App layer:      An active row in agent_delegations for
 *      (user_wallet, agent_pubkey, action='limit_close') must exist
 *      AND not be expired AND bound the requested order on every
 *      dimension: per-order notional cap, concurrent-orders cap,
 *      slippage cap.
 *   3. Storage layer:  The UNIQUE partial index on limit_close_orders
 *      (loan_id WHERE status='armed') physically prevents the agent
 *      from double-arming the same loan even if the app-layer check
 *      had a race.
 *
 * The agent never names the user by Telegram id or DB primary key —
 * it identifies the borrower by on-chain wallet pubkey, which is what
 * the user knew when they ran /agent_authorize.
 */
import { query } from "../db/pool.js";
import { constantTimeEqual } from "./auth-utils.js";
import { armOrder, modifyOrder } from "../services/limit-close-arm-core.js";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

// HTTP status mapping for arm-core error strings. The agent path needs
// to translate the shared error codes into the HTTP shape the x402
// service is already documented against. Defaults to 409 (conflict)
// when an error isn't explicitly mapped — most arm-core errors are
// "we won't proceed because of state" which is the canonical 409.
const ARM_ERROR_STATUS = {
  // shape errors → 400
  invalid_trigger_kind: 400,
  invalid_trigger_direction: 400,
  invalid_trigger_value: 400,
  trigger_value_out_of_range: 400,
  invalid_slippage_bps: 400,
  invalid_sell_destination: 400,
  invalid_loan_id: 400,
  invalid_expires_at: 400,
  invalid_source: 400,
  invalid_cap_bps: 400,
  // ownership / state → 404 / 409
  loan_not_found_for_user: 404,
  loan_not_active: 409,
  loan_below_minimum_size: 409,
  collateral_not_enabled: 409,
  rwa_collateral_not_supported_in_v1: 409,
  trigger_would_fire_immediately: 409,
  sl_below_solvency: 409,
  loan_already_has_active_order: 409,
  loan_already_has_active_order_in_direction: 409,
  // concurrency → 429
  user_concurrency_cap_reached: 429,
  // server-side failures → 500
  insert_failed: 500,
};

// Operator kill switch — set LIMIT_CLOSE_AGENT_DISABLED=1 to disable
// the x402 agent arm path WITHOUT affecting TG-armed orders or any
// already-armed agent orders. The engine still processes armed
// orders; this just refuses new ones from the x402 endpoint.
// Read fresh on every request so flipping the env doesn't need a
// process restart.
function agentArmDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.LIMIT_CLOSE_AGENT_DISABLED || "");
}

const MIN_LOAN_LAMPORTS = 1_000_000_000n; // 1 SOL eligibility floor (same as TG path)
const MIN_TRIGGER_VALUE_MICRO = 1n;
const MAX_TRIGGER_VALUE_MICRO = 1_000_000_000_000_000n;
const VALID_TRIGGER_KINDS = new Set(["mc_usd", "price_usd", "price_sol"]);
const VALID_DESTINATIONS = new Set(["sol", "usdc"]);
// Mirror VALID_TRIGGER_DIRECTIONS from arm-core. Adding 'below' support
// 2026-06-13 — operator escalation "limit sale build for both regular
// protocol and x402 must be PERFECTED." The TG/site path already supports
// stop-loss via /stoploss; the x402 agent path was missing it.
const VALID_TRIGGER_DIRECTIONS = new Set(["above", "below"]);

// Sourced from src/lib/slippage-constants.js — protocol-absolute ceiling.
// The delegation's max_slippage_bps still gates further (it's the user-
// consent ceiling and is lower by design — see slippage-constants.js for
// the layered model). This constant is the OUTER bound only; the agent
// can never exceed min(delegation.max_slippage_bps, this).
import { MAX_PROTOCOL_SLIPPAGE_BPS as MAX_INITIAL_SLIPPAGE_BPS_PROTOCOL } from "../lib/slippage-constants.js";

function isValidPubkey(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * POST /api/v1/internal/agent/limit-close/arm
 *
 * Body:
 *   {
 *     user_wallet:        <pubkey>      borrower's custodial wallet
 *     agent_pubkey:       <pubkey>      x402 payer = agent identity
 *     loan_id:            <number>      on-chain loan id (loans.loan_id)
 *     trigger_kind:       'mc_usd' | 'price_usd' | 'price_sol'
 *     trigger_value_micro: <decimal-string>
 *     slippage_bps:       <integer>     10..1000
 *     sell_destination:   'sol' | 'usdc'
 *     expires_at:         <ISO string or null>
 *     x402_tx_signature:  <signature>   for audit trail
 *   }
 */
export async function handleAgentLimitCloseArm(req) {
  if (!INTERNAL_API_TOKEN) {
    return { status: 503, body: { error: "service_not_configured" } };
  }
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  if (agentArmDisabled()) {
    // Operator kill switch — refuse new agent arms. TG-armed orders
    // and already-armed agent orders continue to be processed by the
    // engine. The x402 service surfaces this to the agent as a 503
    // with reason, which they should treat as "retry later".
    return { status: 503, body: { error: "agent_arm_disabled_by_operator" } };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const userWallet       = String(body?.user_wallet ?? "");
  const agentPubkey      = String(body?.agent_pubkey ?? "");
  const loanIdRaw        = String(body?.loan_id ?? "");
  const triggerKind      = String(body?.trigger_kind ?? "");
  // Default 'above' (take-profit) for back-compat with existing agents.
  // Agents wanting stop-loss pass {"trigger_direction": "below"}.
  const triggerDirection = String(body?.trigger_direction ?? "above");
  const triggerValueMicroRaw = String(body?.trigger_value_micro ?? "");
  const slippageBpsRaw   = body?.slippage_bps;
  const sellDestination  = String(body?.sell_destination ?? "sol").toLowerCase();
  const expiresAt        = body?.expires_at ? String(body.expires_at) : null;
  const x402TxSignature  = String(body?.x402_tx_signature ?? "");
  const autoEscalateRaw  = body?.auto_escalate_slippage;
  // Coerce to strict boolean — accept true/false explicitly, anything else
  // is treated as false. We don't want truthy strings like "yes" sneaking
  // in and flipping the behavior.
  const autoEscalate     = autoEscalateRaw === true;

  // ── Shape validation ─────────────────────────────────────────
  if (!isValidPubkey(userWallet))  return bad("invalid_user_wallet");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  if (!/^\d+$/.test(loanIdRaw))    return bad("invalid_loan_id");
  if (!VALID_TRIGGER_KINDS.has(triggerKind)) return bad("invalid_trigger_kind");
  if (!VALID_TRIGGER_DIRECTIONS.has(triggerDirection)) return bad("invalid_trigger_direction");
  if (!/^\d+$/.test(triggerValueMicroRaw))   return bad("invalid_trigger_value");
  let triggerValueMicro;
  try { triggerValueMicro = BigInt(triggerValueMicroRaw); } catch { return bad("invalid_trigger_value"); }
  if (triggerValueMicro < MIN_TRIGGER_VALUE_MICRO || triggerValueMicro > MAX_TRIGGER_VALUE_MICRO) {
    return bad("trigger_value_out_of_range");
  }
  if (!Number.isInteger(slippageBpsRaw) || slippageBpsRaw < 10 || slippageBpsRaw > MAX_INITIAL_SLIPPAGE_BPS_PROTOCOL) {
    return bad("invalid_slippage_bps");
  }
  const slippageBps = slippageBpsRaw;
  if (!VALID_DESTINATIONS.has(sellDestination)) return bad("invalid_sell_destination");
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) return bad("invalid_expires_at");

  // ── Authorization: delegation must exist + cover this order ─────
  // The composite index agent_delegations_lookup_idx makes this a
  // sub-ms hit. We pull the bounds back so we can apply them below.
  const { rows: [delegation] } = await query(
    `SELECT id,
            max_per_order_lamports::text AS max_per_order_lamports,
            max_active_orders,
            max_slippage_bps,
            expires_at,
            user_id
       FROM agent_delegations
      WHERE user_wallet = $1
        AND agent_pubkey = $2
        AND action = 'limit_close'
        AND status = 'active'`,
    [userWallet, agentPubkey],
  );
  if (!delegation) {
    return { status: 403, body: { error: "no_active_delegation" } };
  }
  if (delegation.expires_at && new Date(delegation.expires_at) < new Date()) {
    // Best-effort cleanup; the next /agent_authorize will overwrite.
    await query(
      `UPDATE agent_delegations SET status = 'expired', revoked_at = NOW(), revoked_by = 'system'
        WHERE id = $1`,
      [delegation.id],
    ).catch(() => {});
    return { status: 403, body: { error: "delegation_expired" } };
  }

  // ── Loan ownership pre-check (wallet binding) ──────────────────
  // The agent supplied user_wallet AND loan_id. armOrder() looks up
  // (user_id, loan_id) directly, but it does NOT verify that the
  // delegation.user_id actually owns the wallet the agent claims to
  // be operating against. That's the load-bearing agent-specific check:
  // an agent authorized for wallet A cannot arm an order on wallet B's
  // loan, even if both wallets are linked to the same telegram user.
  //
  // We resolve the (user_wallet, delegation.user_id) tuple here so we
  // can return the agent-flavored loan_not_found_for_wallet error
  // before armOrder is even called. We also pull loan.loan_id so the
  // response body keeps its existing shape (agents key off it).
  const { rows: [walletGuard] } = await query(
    `SELECT l.loan_id::text AS loan_id_chain,
            l.original_loan_amount_lamports::text AS owed
       FROM loans l
       JOIN wallets w ON w.user_id = l.user_id AND w.public_key = $1
      WHERE l.user_id = $2 AND l.loan_id = $3`,
    [userWallet, delegation.user_id, loanIdRaw],
  );
  if (!walletGuard) {
    return { status: 404, body: { error: "loan_not_found_for_wallet" } };
  }

  // ── Delegation BOUNDS — agent-consent ceilings ──────────────────
  // These are NOT in armOrder() because they're consent boundaries
  // the borrower set when they ran /agent_authorize. armOrder is the
  // user-level safety floor; this is the agent-specific consent ceiling.
  //
  // (a) per-order notional cap. The borrower said "this agent may arm
  // orders up to X SOL each" — refuse if the loan itself is larger.
  if (BigInt(walletGuard.owed) > BigInt(delegation.max_per_order_lamports)) {
    return {
      status: 403,
      body: {
        error: "order_exceeds_delegation_cap",
        loan_owed_lamports: walletGuard.owed,
        max_per_order_lamports: delegation.max_per_order_lamports,
      },
    };
  }
  // (b) slippage cap — borrower set a max acceptable slippage. Hard 403
  // not a clamp: if the agent's request exceeds the consent ceiling we
  // reject loud so the agent can request a lower number or the borrower
  // can update their delegation.
  if (slippageBps > delegation.max_slippage_bps) {
    return {
      status: 403,
      body: {
        error: "slippage_exceeds_delegation_cap",
        requested_bps: slippageBps,
        max_allowed_bps: delegation.max_slippage_bps,
      },
    };
  }
  // (c) per-agent concurrent-orders cap. Counts only orders THIS agent
  // armed for THIS user — different from armOrder's user-wide cap.
  const { rows: [activeCount] } = await query(
    `SELECT COUNT(*)::int AS n
       FROM limit_close_orders
      WHERE user_id = $1
        AND status = 'armed'
        AND source = 'agent_x402'
        AND source_agent_pubkey = $2`,
    [delegation.user_id, agentPubkey],
  );
  if (activeCount.n >= delegation.max_active_orders) {
    return {
      status: 429,
      body: {
        error: "agent_concurrency_cap_reached",
        active: activeCount.n,
        max_active_orders: delegation.max_active_orders,
      },
    };
  }

  // ── Hand off to armOrder() ──────────────────────────────────
  // Everything beyond this point — loan state, collateral allowlist,
  // pre-flight quote, immediate-fire guard, SL solvency floor,
  // liquidity-aware slippage bump, per-user concurrency, INSERT with
  // UNIQUE-partial-index dup-arm protection — is shared with the
  // TG/site path so we let armOrder() own it. Single source of truth
  // for arm-time gates: any new safety check added there applies to
  // all three surfaces automatically.
  //
  // The cap we pass is the delegation's slippage ceiling so the engine
  // has the consent-bounded headroom for auto-escalation. We snapshot
  // the cap at arm time (NOT read it live each tick) so a borrower
  // tightening the delegation later doesn't strand orders the agent
  // already armed under the previous consent.
  const capBps = autoEscalate ? delegation.max_slippage_bps : slippageBps;
  const armResult = await armOrder({
    userId: delegation.user_id,
    source: "agent_x402",
    sourceAgentPubkey: agentPubkey,
    loanIdChain: loanIdRaw,
    triggerKind,
    triggerValueMicro,
    triggerDirection,
    slippageBps,
    sellDestination,
    expiresAt,
    autoEscalate,
    capBps,
    preflightProtocolFeeBps: 100,
    // Preserve the x402-tx audit trail in the notes column. armOrder
    // appends its own context (direction, slippage-bump, etc.) on top.
    armNote: `armed via x402 tx ${x402TxSignature.slice(0, 16)}...; direction=${triggerDirection}; auto_escalate=${autoEscalate} cap=${capBps}bps`,
  });

  if (!armResult.ok) {
    const status = ARM_ERROR_STATUS[armResult.error] || 409;
    return {
      status,
      body: {
        error: armResult.error,
        ...(armResult.detail != null ? { detail: armResult.detail } : {}),
        ...(armResult.suggestedSlippageBps != null
          ? { suggested_slippage_bps: armResult.suggestedSlippageBps,
              your_slippage_bps: armResult.yourSlippageBps,
              cap_used_for_check_bps: capBps }
          : {}),
      },
    };
  }

  const orderId = armResult.orderId;

  // armOrder already enqueues no notification — DMing the borrower is a
  // per-surface decision. For agent path: ALWAYS DM (the borrower wasn't
  // the actor; they need to know their delegated agent fired off an arm).
  // Best-effort — enqueue failure does not roll back the arm.
  try {
    await query(
      `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
         VALUES ($1, 'tg', 'limit_close_armed', $2::jsonb, 'pending')`,
      [delegation.user_id, JSON.stringify({
        order_id: orderId,
        loan_id_chain: walletGuard.loan_id_chain,
        trigger_label: `${triggerKind}=${triggerValueMicro.toString()}`,
        slippage_bps: armResult.initialSlippageBpsApplied,
        sell_destination: sellDestination,
        source: "agent_x402",
        source_agent_pubkey: agentPubkey,
      })],
    );
  } catch (err) {
    console.warn("[internal-agent-limitclose] arm-DM enqueue failed:", err.message?.slice(0, 200));
  }

  const appliedInitialBps   = armResult.initialSlippageBpsApplied;
  const originalRequestedBps = armResult.initialSlippageBpsRequested;
  return {
    status: 200,
    body: {
      ok: true,
      order_id: orderId,
      loan_id: walletGuard.loan_id_chain,
      trigger_kind: triggerKind,
      trigger_value_micro: triggerValueMicro.toString(),
      slippage_bps: appliedInitialBps,
      sell_destination: sellDestination,
      armed_at: armResult.armedAt,
      expires_at: expiresAt,
      source: "agent_x402",
      source_agent_pubkey: agentPubkey,
      auto_escalate_slippage: autoEscalate,
      max_slippage_bps_cap: capBps,
      initial_slippage_bps: appliedInitialBps,
      // Surface the bump so the agent can log / present it to the user.
      ...(appliedInitialBps !== originalRequestedBps
        ? {
            slippage_bps_requested: originalRequestedBps,
            liquidity_floor_bps: armResult.liquidityTierFloorBps,
            liquidity_usd: armResult.liquidityUsd,
          }
        : {}),
    },
  };
}

/**
 * GET /api/v1/internal/agent/limit-close?agent=<pubkey>&id=<order_id>
 *
 * Read one order — scoped to the agent that armed it. Free (no x402)
 * because read-only and the agent is identified by query param the
 * x402 service has already proven (via payment verifying agent's
 * payer key on the original arm call).
 *
 * Wait — but a free read endpoint can't trust a self-asserted agent
 * pubkey. The x402 service must therefore re-charge for reads OR we
 * make this internal-only and let the x402 service do the pubkey
 * binding upstream. We chose the latter: internal-token-gated, the
 * x402 service binds (agent_pubkey ← verified x402 payer) before
 * calling us. So this endpoint is safe to scope by agent_pubkey
 * because INTERNAL_API_TOKEN already authenticated the caller.
 */
export async function handleAgentLimitCloseGet(req, params) {
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  const agentPubkey = String(params.agent ?? "");
  const orderId     = String(params.id ?? "");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  if (!/^\d+$/.test(orderId))      return bad("invalid_order_id");

  const { rows: [order] } = await query(
    `SELECT lc.id, lc.trigger_kind,
            lc.trigger_value_micro::text AS trigger_value_micro,
            lc.slippage_bps, lc.sell_destination, lc.status,
            lc.armed_at, lc.expires_at, lc.firing_started_at, lc.fired_at,
            lc.tx_signature_repay, lc.tx_signature_swap,
            lc.proceeds_lamports::text AS proceeds_lamports,
            lc.protocol_fee_lamports::text AS protocol_fee_lamports,
            lc.net_to_user_lamports::text AS net_to_user_lamports,
            lc.failure_reason, lc.cancellation_reason, lc.failure_count,
            lc.auto_escalate_slippage, lc.max_slippage_bps_cap,
            lc.initial_slippage_bps, lc.slippage_escalations,
            l.loan_id AS chain_loan_id
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
      WHERE lc.id = $1
        AND lc.source = 'agent_x402'
        AND lc.source_agent_pubkey = $2`,
    [orderId, agentPubkey],
  );
  if (!order) {
    return { status: 404, body: { error: "order_not_found" } };
  }
  return { status: 200, body: order };
}

/**
 * POST /api/v1/internal/agent/limit-close/preflight
 *
 * Same body shape as /arm. Runs every gate armOrder runs (collateral
 * allowlist, runArmPreflight, immediate-fire guard, SL solvency floor,
 * liquidity bump derivation) but does NOT INSERT a row and does NOT
 * count against the per-user concurrency cap.
 *
 * Why this exists: agents pay x402 per /arm call. A rejected /arm
 * burns the agent's fee with no value back. /preflight is FREE (no
 * x402 ladder on the magpie-x402 side) and lets the agent ask "would
 * this exact arm succeed right now?" — economically rational for
 * agents to call before paying.
 *
 * Returns the same { ok: true, ... } shape as /arm on success and the
 * same error codes on failure. The only difference is dryRun=true is
 * surfaced in the response so the agent can distinguish a preflight
 * result from a real arm.
 *
 * The preflight check is a strong hint, not a contractual reservation.
 * Liquidity can shift between preflight and arm, so a successful
 * preflight does NOT guarantee a subsequent arm will succeed. Agents
 * should still be prepared to handle arm-time rejections.
 */
export async function handleAgentLimitClosePreflight(req) {
  if (!INTERNAL_API_TOKEN) {
    return { status: 503, body: { error: "service_not_configured" } };
  }
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  // No agentArmDisabled() check here — preflight is read-only and
  // returning useful info even while the kill switch is on lets
  // agents know to back off cleanly.

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  // Same shape parsing as /arm. Default direction 'above' for back-compat.
  const userWallet       = String(body?.user_wallet ?? "");
  const agentPubkey      = String(body?.agent_pubkey ?? "");
  const loanIdRaw        = String(body?.loan_id ?? "");
  const triggerKind      = String(body?.trigger_kind ?? "");
  const triggerDirection = String(body?.trigger_direction ?? "above");
  const triggerValueMicroRaw = String(body?.trigger_value_micro ?? "");
  const slippageBpsRaw   = body?.slippage_bps;
  const sellDestination  = String(body?.sell_destination ?? "sol").toLowerCase();
  const expiresAt        = body?.expires_at ? String(body.expires_at) : null;
  const autoEscalateRaw  = body?.auto_escalate_slippage;
  const autoEscalate     = autoEscalateRaw === true;

  // Shape validation (same set as /arm)
  if (!isValidPubkey(userWallet))  return bad("invalid_user_wallet");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  if (!/^\d+$/.test(loanIdRaw))    return bad("invalid_loan_id");
  if (!VALID_TRIGGER_KINDS.has(triggerKind)) return bad("invalid_trigger_kind");
  if (!VALID_TRIGGER_DIRECTIONS.has(triggerDirection)) return bad("invalid_trigger_direction");
  if (!/^\d+$/.test(triggerValueMicroRaw))   return bad("invalid_trigger_value");
  let triggerValueMicro;
  try { triggerValueMicro = BigInt(triggerValueMicroRaw); } catch { return bad("invalid_trigger_value"); }
  if (triggerValueMicro < MIN_TRIGGER_VALUE_MICRO || triggerValueMicro > MAX_TRIGGER_VALUE_MICRO) {
    return bad("trigger_value_out_of_range");
  }
  if (!Number.isInteger(slippageBpsRaw) || slippageBpsRaw < 10 || slippageBpsRaw > MAX_INITIAL_SLIPPAGE_BPS_PROTOCOL) {
    return bad("invalid_slippage_bps");
  }
  const slippageBps = slippageBpsRaw;
  if (!VALID_DESTINATIONS.has(sellDestination)) return bad("invalid_sell_destination");
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) return bad("invalid_expires_at");

  // Delegation lookup (same auth model as /arm)
  const { rows: [delegation] } = await query(
    `SELECT id,
            max_per_order_lamports::text AS max_per_order_lamports,
            max_active_orders,
            max_slippage_bps,
            expires_at,
            user_id
       FROM agent_delegations
      WHERE user_wallet = $1
        AND agent_pubkey = $2
        AND action = 'limit_close'
        AND status = 'active'`,
    [userWallet, agentPubkey],
  );
  if (!delegation) {
    return { status: 403, body: { error: "no_active_delegation" } };
  }
  if (delegation.expires_at && new Date(delegation.expires_at) < new Date()) {
    return { status: 403, body: { error: "delegation_expired" } };
  }

  // Wallet binding + loan owed lookup (same as /arm)
  const { rows: [walletGuard] } = await query(
    `SELECT l.loan_id::text AS loan_id_chain,
            l.original_loan_amount_lamports::text AS owed
       FROM loans l
       JOIN wallets w ON w.user_id = l.user_id AND w.public_key = $1
      WHERE l.user_id = $2 AND l.loan_id = $3`,
    [userWallet, delegation.user_id, loanIdRaw],
  );
  if (!walletGuard) {
    return { status: 404, body: { error: "loan_not_found_for_wallet" } };
  }

  // Delegation BOUNDS (same as /arm)
  if (BigInt(walletGuard.owed) > BigInt(delegation.max_per_order_lamports)) {
    return {
      status: 403,
      body: {
        error: "order_exceeds_delegation_cap",
        loan_owed_lamports: walletGuard.owed,
        max_per_order_lamports: delegation.max_per_order_lamports,
      },
    };
  }
  if (slippageBps > delegation.max_slippage_bps) {
    return {
      status: 403,
      body: {
        error: "slippage_exceeds_delegation_cap",
        requested_bps: slippageBps,
        max_allowed_bps: delegation.max_slippage_bps,
      },
    };
  }
  // Note: per-agent concurrency cap is INTENTIONALLY skipped on preflight
  // for the same reason armOrder skips user concurrency in dryRun — a
  // preflight is a question, not a slot commitment.

  // Hand off to armOrder() in dryRun mode
  const capBps = autoEscalate ? delegation.max_slippage_bps : slippageBps;
  const armResult = await armOrder({
    userId: delegation.user_id,
    source: "agent_x402",
    sourceAgentPubkey: agentPubkey,
    loanIdChain: loanIdRaw,
    triggerKind,
    triggerValueMicro,
    triggerDirection,
    slippageBps,
    sellDestination,
    expiresAt,
    autoEscalate,
    capBps,
    preflightProtocolFeeBps: 100,
    dryRun: true,
  });

  if (!armResult.ok) {
    const status = ARM_ERROR_STATUS[armResult.error] || 409;
    return {
      status,
      body: {
        ok: false,
        preflight: true,
        error: armResult.error,
        ...(armResult.detail != null ? { detail: armResult.detail } : {}),
        ...(armResult.suggestedSlippageBps != null
          ? { suggested_slippage_bps: armResult.suggestedSlippageBps,
              your_slippage_bps: armResult.yourSlippageBps,
              cap_used_for_check_bps: capBps }
          : {}),
      },
    };
  }

  const appliedInitialBps   = armResult.initialSlippageBpsApplied;
  const originalRequestedBps = armResult.initialSlippageBpsRequested;
  return {
    status: 200,
    body: {
      ok: true,
      preflight: true,
      would_arm: true,
      loan_id: walletGuard.loan_id_chain,
      trigger_kind: triggerKind,
      trigger_value_micro: triggerValueMicro.toString(),
      slippage_bps: appliedInitialBps,
      sell_destination: sellDestination,
      auto_escalate_slippage: autoEscalate,
      max_slippage_bps_cap: capBps,
      initial_slippage_bps: appliedInitialBps,
      // Same liquidity-bump surfacing as /arm
      ...(appliedInitialBps !== originalRequestedBps
        ? {
            slippage_bps_requested: originalRequestedBps,
            liquidity_floor_bps: armResult.liquidityTierFloorBps,
            liquidity_usd: armResult.liquidityUsd,
          }
        : {}),
    },
  };
}

/**
 * GET /api/v1/internal/agent/limit-close/list?agent=<pubkey>&status=<armed|all>
 *
 * List orders armed by this agent. Default status filter is 'armed'
 * (the common case — "what do I have working right now"); pass
 * status=all to include terminal states for audit.
 */
export async function handleAgentLimitCloseList(req, params) {
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  const agentPubkey = String(params.agent ?? "");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  const statusFilter = String(params.status ?? "armed");
  const filterArmed = statusFilter !== "all";

  const { rows } = await query(
    `SELECT lc.id, lc.trigger_kind,
            lc.trigger_value_micro::text AS trigger_value_micro,
            lc.slippage_bps, lc.sell_destination, lc.status,
            lc.armed_at, lc.expires_at,
            lc.auto_escalate_slippage, lc.max_slippage_bps_cap,
            lc.initial_slippage_bps, lc.slippage_escalations,
            lc.failure_count,
            l.loan_id AS chain_loan_id,
            l.collateral_mint
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
      WHERE lc.source = 'agent_x402'
        AND lc.source_agent_pubkey = $1
        AND ($2::boolean = FALSE OR lc.status = 'armed')
      ORDER BY lc.armed_at DESC
      LIMIT 100`,
    [agentPubkey, filterArmed],
  );
  return { status: 200, body: { count: rows.length, orders: rows } };
}

/**
 * DELETE /api/v1/internal/agent/limit-close?agent=<pubkey>&id=<order_id>
 *
 * Cancel an armed order. Race-safe: WHERE status='armed' so a
 * cancel-against-firing returns "not_cancellable" instead of leaving
 * the user with a half-executed order. Same defense the TG cancel
 * uses — the engine flips status to 'firing' before doing any
 * on-chain work, so once 'firing' the cancel is too late.
 */
/**
 * PATCH /api/v1/internal/agent/limit-close/modify
 *
 * Body: { id: <order_id>, trigger_value_micro?, slippage_bps?,
 *         sell_destination?, expires_at? }
 *
 * Agent identity: X-Agent-Pubkey header (same scoping as /list /get).
 * Internal-token gated. Calls into the shared modifyOrder() so the
 * agent path applies the same gates as the TG/site /modifyorder.
 *
 * Why agents need modify: an agent that arms a TP at $0.0030 and the
 * market moves wants to push to $0.0040 without re-paying the x402
 * arm fee. Modify is free (no x402) — the agent already paid for
 * the slot at arm time.
 */
export async function handleAgentLimitCloseModify(req) {
  if (!INTERNAL_API_TOKEN) {
    return { status: 503, body: { error: "service_not_configured" } };
  }
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  let body;
  try { body = await readJsonBody(req); }
  catch { return { status: 400, body: { error: "Invalid JSON body" } }; }

  const agentPubkey = String(req.headers["x-agent-pubkey"] || body?.agent_pubkey || "");
  const orderIdRaw  = String(body?.id ?? "");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  if (!/^\d+$/.test(orderIdRaw))   return bad("invalid_order_id");

  // Optional fields — passed through to modifyOrder when present.
  const updates = {};
  if (body?.trigger_value_micro !== undefined) {
    const v = String(body.trigger_value_micro);
    if (!/^\d+$/.test(v)) return bad("invalid_trigger_value");
    updates.triggerValueMicro = v;
  }
  if (body?.slippage_bps !== undefined) {
    if (!Number.isInteger(body.slippage_bps)) return bad("invalid_slippage_bps");
    updates.slippageBps = body.slippage_bps;
  }
  if (body?.sell_destination !== undefined) {
    updates.sellDestination = String(body.sell_destination).toLowerCase();
  }
  if (body?.expires_at !== undefined) {
    if (body.expires_at !== null) updates.expiresAt = String(body.expires_at);
    else updates.expiresAt = null;
  }
  if (Object.keys(updates).length === 0) {
    return bad("no_changes_supplied");
  }

  const result = await modifyOrder({
    orderId: Number(orderIdRaw),
    sourceAgentPubkey: agentPubkey,
    ...updates,
  });
  if (!result.ok) {
    const status = ARM_ERROR_STATUS[result.error] || 409;
    return {
      status,
      body: {
        error: result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      order_id: result.order.id,
      changed_fields: result.changedFields,
      trigger_value_micro: result.order.trigger_value_micro,
      slippage_bps: result.order.slippage_bps,
      sell_destination: result.order.sell_destination,
      expires_at: result.order.expires_at,
      updated_at: result.order.updated_at,
    },
  };
}

export async function handleAgentLimitCloseDelete(req, params) {
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  const agentPubkey = String(params.agent ?? "");
  const orderId     = String(params.id ?? "");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  if (!/^\d+$/.test(orderId))      return bad("invalid_order_id");

  const result = await query(
    `UPDATE limit_close_orders
        SET status = 'cancelled',
            cancellation_reason = 'agent_cancel_via_x402',
            updated_at = NOW()
      WHERE id = $1
        AND source = 'agent_x402'
        AND source_agent_pubkey = $2
        AND status = 'armed'
      RETURNING id, armed_at`,
    [orderId, agentPubkey],
  );
  if (result.rows.length === 0) {
    return { status: 409, body: { error: "not_cancellable_or_not_found" } };
  }
  return { status: 200, body: { ok: true, cancelled_order_id: result.rows[0].id } };
}

/**
 * GET /api/v1/internal/agent/limit-close/delegations?agent=<pubkey>
 *
 * The agent reads its OWN active grants — every (user_wallet, action,
 * bounds) tuple that the borrower authorized to it. This is what an
 * agent calls on startup to discover the surface it can operate over.
 *
 * Scoped strictly by agent_pubkey so one agent cannot enumerate
 * another's delegations. Same INTERNAL_API_TOKEN gate as the other
 * internal endpoints — the x402 service binds the agent_pubkey to
 * the verified x402 payer before calling us, OR (for the free path)
 * the x402 service requires the agent to assert its pubkey via the
 * X-Agent-Pubkey header. Read-only and exposes only the bounds the
 * agent itself agreed to, so no payer-binding is required.
 */
export async function handleAgentLimitCloseListDelegations(req, params) {
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  const agentPubkey = String(params.agent ?? "");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");

  const { rows } = await query(
    `SELECT user_wallet,
            action,
            max_per_order_lamports::text AS max_per_order_lamports,
            max_active_orders,
            max_slippage_bps,
            granted_at,
            expires_at
       FROM agent_delegations
      WHERE agent_pubkey = $1
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY granted_at DESC
      LIMIT 200`,
    [agentPubkey],
  );

  // For each delegation also surface the agent's current armed-orders
  // count against the cap — the agent needs this to know whether it
  // has headroom to arm another order without round-tripping.
  let activeByWallet = new Map();
  if (rows.length > 0) {
    const wallets = rows.map((r) => r.user_wallet);
    const { rows: counts } = await query(
      `SELECT w.public_key AS user_wallet, COUNT(*)::int AS active
         FROM limit_close_orders lc
         JOIN users u ON u.id = lc.user_id
         JOIN wallets w ON w.user_id = u.id
        WHERE lc.status = 'armed'
          AND lc.source = 'agent_x402'
          AND lc.source_agent_pubkey = $1
          AND w.public_key = ANY($2::text[])
        GROUP BY w.public_key`,
      [agentPubkey, wallets],
    );
    activeByWallet = new Map(counts.map((c) => [c.user_wallet, c.active]));
  }

  return {
    status: 200,
    body: {
      count: rows.length,
      delegations: rows.map((r) => ({
        user_wallet: r.user_wallet,
        action: r.action,
        bounds: {
          max_per_order_lamports: r.max_per_order_lamports,
          max_per_order_sol: Number(r.max_per_order_lamports) / 1e9,
          max_active_orders: r.max_active_orders,
          max_slippage_bps: r.max_slippage_bps,
        },
        usage: {
          active_orders: activeByWallet.get(r.user_wallet) ?? 0,
          headroom: r.max_active_orders - (activeByWallet.get(r.user_wallet) ?? 0),
        },
        granted_at: r.granted_at,
        expires_at: r.expires_at,
      })),
    },
  };
}

/**
 * GET /api/v1/internal/agent/limit-close/eligible-loans?agent=<pubkey>
 *
 * The agent's complete actionable surface — every (wallet, loan) tuple
 * they could arm a limit-close against, with explicit eligibility for
 * each so the agent doesn't have to encode protocol invariants on
 * their side.
 *
 * Returns ONE shaped object containing:
 *   - by_wallet: array, one entry per active delegation
 *       - user_wallet
 *       - delegation: bounds + current usage (active orders, headroom)
 *       - loans: every loan owned by that wallet, with:
 *           - loan metadata (loan_id, collateral_mint+symbol, amount, status, due)
 *           - is_eligible: true/false
 *           - ineligibility_reasons: an explicit array; empty if eligible
 *
 * The endpoint surfaces INELIGIBLE loans too (not just eligible) — agents
 * can use the reasons to display "this loan is too small to limit-close"
 * or "the collateral type isn't supported" to the user in their UI.
 *
 * Free. X-Internal-Token gated (only the x402 service calls this); the
 * x402 service has already proven the agent's pubkey via the X-Agent-
 * Pubkey header binding before forwarding.
 *
 * Defense in depth:
 *   - Strictly scoped to wallets where (user_wallet, agent_pubkey,
 *     action='limit_close') has an ACTIVE non-expired delegation. An
 *     agent CANNOT discover loans on wallets that haven't authorized them.
 *   - Eligibility checks mirror the arm endpoint exactly (single source
 *     of truth via the same set of constants + queries) so the agent
 *     can never see a loan as "eligible" that the arm endpoint would
 *     subsequently reject. Drift between these two paths would be
 *     a serious UX bug.
 *   - Loan size, collateral category, existing-armed-order checks are
 *     all applied. Agent's per-wallet active-order count is applied to
 *     the delegation's max_active_orders cap.
 *   - Hard cap of 500 loans across all wallets in one response. An
 *     agent with delegations on many wallets gets the most-recent
 *     loans for each.
 */
export async function handleAgentLimitCloseEligibleLoans(req, params) {
  if (!constantTimeEqual(req.headers["x-internal-token"], INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }
  const agentPubkey = String(params.agent ?? "");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");

  // ── Active delegations for this agent ──────────────────────────
  const { rows: delegations } = await query(
    `SELECT id,
            user_wallet,
            user_id,
            max_per_order_lamports::text AS max_per_order_lamports,
            max_active_orders,
            max_slippage_bps,
            granted_at,
            expires_at
       FROM agent_delegations
      WHERE agent_pubkey = $1
        AND action = 'limit_close'
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY granted_at DESC
      LIMIT 100`,
    [agentPubkey],
  );
  if (delegations.length === 0) {
    return {
      status: 200,
      body: {
        agent_pubkey: agentPubkey,
        delegations_count: 0,
        eligible_loans_count: 0,
        by_wallet: [],
      },
    };
  }

  // ── For each delegation, fetch the wallet's loans + agent's
  //    existing active orders against THIS user (for cap math) ──
  // We do the fetch in two batched queries to keep round-trips at O(1)
  // regardless of delegation count — important if an agent has many
  // delegations.
  const userIds = delegations.map((d) => d.user_id);
  const wallets = delegations.map((d) => d.user_wallet);

  const [{ rows: allLoans }, { rows: activeOrderCounts }, { rows: activeLimitOrders }] =
    await Promise.all([
      query(
        `SELECT l.id, l.loan_id::text AS loan_id, l.loan_pda,
                l.collateral_mint, l.collateral_amount::text AS collateral_amount,
                l.original_loan_amount_lamports::text AS owed_lamports,
                l.status, l.due_timestamp, l.start_timestamp,
                l.borrower_wallet, l.user_id,
                sm.symbol AS collateral_symbol, sm.category AS collateral_category,
                sm.enabled AS collateral_enabled, sm.decimals
           FROM loans l
           LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
          WHERE l.user_id = ANY($1::bigint[])
            AND l.borrower_wallet = ANY($2::text[])
            AND l.status = 'active'
          ORDER BY l.start_timestamp DESC
          LIMIT 500`,
        [userIds, wallets],
      ),
      // Per-(user, agent) active-orders counter — used to compute headroom
      // against delegation.max_active_orders. Counts ONLY orders this
      // agent armed for this user (other agents' counts don't deplete
      // this agent's headroom).
      query(
        `SELECT user_id, COUNT(*)::int AS active_orders
           FROM limit_close_orders
          WHERE status = 'armed'
            AND source = 'agent_x402'
            AND source_agent_pubkey = $1
            AND user_id = ANY($2::bigint[])
          GROUP BY user_id`,
        [agentPubkey, userIds],
      ),
      // Set of loan_ids that ALREADY have an active limit-close order
      // (from ANY source — TG, agent, etc). Loans in this set are
      // ineligible regardless of who would try to arm them, because
      // the UNIQUE partial index physically prevents two armed orders
      // on the same loan.
      query(
        `SELECT DISTINCT loan_id
           FROM limit_close_orders
          WHERE status = 'armed'
            AND loan_id = ANY(
              SELECT id FROM loans
               WHERE user_id = ANY($1::bigint[])
            )`,
        [userIds],
      ),
    ]);

  const activeByUser = new Map(
    activeOrderCounts.map((r) => [Number(r.user_id), r.active_orders]),
  );
  const loanIdsWithActiveOrder = new Set(
    activeLimitOrders.map((r) => Number(r.loan_id)),
  );

  // Group loans by user_wallet for the response shape.
  const loansByWallet = new Map();
  for (const l of allLoans) {
    const key = l.borrower_wallet;
    if (!loansByWallet.has(key)) loansByWallet.set(key, []);
    loansByWallet.get(key).push(l);
  }

  // ── Build per-wallet response, applying eligibility per loan ───
  let totalEligible = 0;
  const byWallet = delegations.map((d) => {
    const wLoans = loansByWallet.get(d.user_wallet) || [];
    const userId = Number(d.user_id);
    const activeOrders = activeByUser.get(userId) ?? 0;
    const headroom = d.max_active_orders - activeOrders;
    const maxPerOrder = BigInt(d.max_per_order_lamports);

    const loans = wLoans.map((l) => {
      const reasons = [];
      const owedBI = BigInt(l.owed_lamports);

      // Mirror the arm endpoint's checks EXACTLY. Keep this list aligned
      // with handleAgentLimitCloseArm.
      if (l.status !== "active") reasons.push("loan_not_active");
      if (owedBI < MIN_LOAN_LAMPORTS) reasons.push("loan_below_minimum_size");
      if (!l.collateral_enabled) reasons.push("collateral_not_enabled");
      // 2026-06-13 (PR C): RWA collateral now arm-eligible end-to-end.
      // engine_program_id discriminator + V2 fill path (PR B) + weekend
      // slippage bump (arm-core) make this safe. Kept the error code in
      // the status map below for back-compat with old agent SDKs that
      // pattern-match on the string.
      if (loanIdsWithActiveOrder.has(Number(l.id))) {
        reasons.push("loan_already_has_active_order");
      }
      if (owedBI > maxPerOrder) {
        reasons.push("loan_exceeds_delegation_per_order_cap");
      }
      if (headroom <= 0) {
        reasons.push("agent_concurrency_cap_reached");
      }

      const isEligible = reasons.length === 0;
      if (isEligible) totalEligible++;

      return {
        loan_id: l.loan_id,
        loan_pda: l.loan_pda,
        collateral_mint: l.collateral_mint,
        collateral_symbol: l.collateral_symbol,
        collateral_category: l.collateral_category,
        collateral_amount_raw: l.collateral_amount,
        collateral_decimals: l.decimals,
        owed_lamports: l.owed_lamports,
        owed_sol: Number(l.owed_lamports) / 1e9,
        status: l.status,
        start_at: l.start_timestamp,
        due_at: l.due_timestamp,
        is_eligible: isEligible,
        ineligibility_reasons: reasons,
      };
    });

    return {
      user_wallet: d.user_wallet,
      delegation: {
        max_per_order_lamports: d.max_per_order_lamports,
        max_per_order_sol: Number(d.max_per_order_lamports) / 1e9,
        max_active_orders: d.max_active_orders,
        max_slippage_bps: d.max_slippage_bps,
        active_orders_used: activeOrders,
        headroom,
        granted_at: d.granted_at,
        expires_at: d.expires_at,
      },
      loans_total: loans.length,
      loans_eligible: loans.filter((x) => x.is_eligible).length,
      loans,
    };
  });

  return {
    status: 200,
    body: {
      agent_pubkey: agentPubkey,
      delegations_count: delegations.length,
      eligible_loans_count: totalEligible,
      // generated_at gives the agent a freshness signal — they can
      // cache this for a short window without worrying about staleness
      // making them try-and-fail on an arm.
      generated_at: new Date().toISOString(),
      by_wallet: byWallet,
    },
  };
}

function bad(err) { return { status: 400, body: { error: err } }; }
