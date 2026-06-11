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

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

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
  const triggerValueMicroRaw = String(body?.trigger_value_micro ?? "");
  const slippageBpsRaw   = body?.slippage_bps;
  const sellDestination  = String(body?.sell_destination ?? "sol").toLowerCase();
  const expiresAt        = body?.expires_at ? String(body.expires_at) : null;
  const x402TxSignature  = String(body?.x402_tx_signature ?? "");

  // ── Shape validation ─────────────────────────────────────────
  if (!isValidPubkey(userWallet))  return bad("invalid_user_wallet");
  if (!isValidPubkey(agentPubkey)) return bad("invalid_agent_pubkey");
  if (!/^\d+$/.test(loanIdRaw))    return bad("invalid_loan_id");
  if (!VALID_TRIGGER_KINDS.has(triggerKind)) return bad("invalid_trigger_kind");
  if (!/^\d+$/.test(triggerValueMicroRaw))   return bad("invalid_trigger_value");
  let triggerValueMicro;
  try { triggerValueMicro = BigInt(triggerValueMicroRaw); } catch { return bad("invalid_trigger_value"); }
  if (triggerValueMicro < MIN_TRIGGER_VALUE_MICRO || triggerValueMicro > MAX_TRIGGER_VALUE_MICRO) {
    return bad("trigger_value_out_of_range");
  }
  if (!Number.isInteger(slippageBpsRaw) || slippageBpsRaw < 10 || slippageBpsRaw > 1000) {
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

  // ── Loan ownership + state ──────────────────────────────────
  // The agent supplied user_wallet AND loan_id; we re-derive
  // user_id from the delegation and require the loan to belong to
  // that same user. This is the load-bearing check that an agent
  // authorized for wallet A cannot arm an order on wallet B's loan.
  const { rows: [loan] } = await query(
    `SELECT l.id, l.loan_id, l.status,
            l.original_loan_amount_lamports::text AS owed,
            l.collateral_mint,
            u.id AS owner_user_id
       FROM loans l
       JOIN users u ON u.id = l.user_id
       JOIN wallets w ON w.user_id = u.id AND w.public_key = $1
      WHERE l.user_id = $2 AND l.loan_id = $3`,
    [userWallet, delegation.user_id, loanIdRaw],
  );
  if (!loan) {
    return { status: 404, body: { error: "loan_not_found_for_wallet" } };
  }
  if (loan.status !== "active") {
    return { status: 409, body: { error: "loan_not_active", loan_status: loan.status } };
  }
  if (BigInt(loan.owed) < MIN_LOAN_LAMPORTS) {
    return { status: 409, body: { error: "loan_below_minimum_size" } };
  }

  // ── Collateral allowlist (mirrors TG path) ──────────────────
  const { rows: [mintRow] } = await query(
    `SELECT enabled, category FROM supported_mints WHERE mint = $1`,
    [loan.collateral_mint],
  );
  if (!mintRow || !mintRow.enabled) {
    return { status: 409, body: { error: "collateral_not_enabled" } };
  }
  if (["stock", "etf", "metal"].includes(mintRow.category)) {
    return { status: 409, body: { error: "rwa_collateral_not_supported_in_v1" } };
  }

  // ── Delegation BOUNDS check ─────────────────────────────────
  // (a) per-order notional ceiling
  if (BigInt(loan.owed) > BigInt(delegation.max_per_order_lamports)) {
    return {
      status: 403,
      body: {
        error: "order_exceeds_delegation_cap",
        loan_owed_lamports: loan.owed,
        max_per_order_lamports: delegation.max_per_order_lamports,
      },
    };
  }
  // (b) slippage ceiling
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
  // (c) concurrent-orders ceiling (count only orders this agent armed for this user)
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

  // ── INSERT — UNIQUE partial index catches dup-arm races ──────
  let inserted;
  try {
    inserted = await query(
      `INSERT INTO limit_close_orders
         (user_id, loan_id, trigger_kind, trigger_value_micro,
          slippage_bps, sell_destination, expires_at,
          source, source_agent_pubkey, status, armed_at,
          notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'agent_x402', $8, 'armed', NOW(),
               $9)
       RETURNING id, armed_at`,
      [delegation.user_id, loan.id, triggerKind, triggerValueMicro.toString(),
       slippageBps, sellDestination, expiresAt,
       agentPubkey,
       `armed via x402 tx ${x402TxSignature.slice(0, 16)}...`],
    );
  } catch (err) {
    if (/duplicate key value violates unique constraint/i.test(err.message)) {
      return { status: 409, body: { error: "loan_already_has_active_order" } };
    }
    console.error("[internal-agent-limitclose] insert failed:", err.message);
    return { status: 500, body: { error: "insert_failed" } };
  }

  const orderId = inserted.rows[0].id;

  // Borrower wasn't the actor here — DM them so they know an
  // authorized agent just armed an order on their loan. Best-effort:
  // if the enqueue fails the order is still armed (correct), they
  // just don't get the immediate ping.
  try {
    await query(
      `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
         VALUES ($1, 'tg', 'limit_close_armed', $2::jsonb, 'pending')`,
      [delegation.user_id, JSON.stringify({
        order_id: orderId,
        loan_id_chain: loan.loan_id,
        trigger_label: `${triggerKind}=${triggerValueMicro.toString()}`,
        slippage_bps: slippageBps,
        sell_destination: sellDestination,
        source: "agent_x402",
        source_agent_pubkey: agentPubkey,
      })],
    );
  } catch (err) {
    console.warn("[internal-agent-limitclose] arm-DM enqueue failed:", err.message?.slice(0, 200));
  }

  return {
    status: 200,
    body: {
      ok: true,
      order_id: orderId,
      loan_id: loan.loan_id,
      trigger_kind: triggerKind,
      trigger_value_micro: triggerValueMicro.toString(),
      slippage_bps: slippageBps,
      sell_destination: sellDestination,
      armed_at: inserted.rows[0].armed_at,
      expires_at: expiresAt,
      source: "agent_x402",
      source_agent_pubkey: agentPubkey,
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
            lc.failure_reason, lc.cancellation_reason,
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

function bad(err) { return { status: 400, body: { error: err } }; }
