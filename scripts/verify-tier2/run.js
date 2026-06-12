#!/usr/bin/env node
/**
 * Tier 2 (agentic limit-close via x402) end-to-end verification.
 *
 * Walks every step of the Tier 2 flow against the real prod stack
 * WITHOUT touching the chain:
 *
 *   1. Insert a synthetic user (negative telegram_id so it can never
 *      collide with a real TG user).
 *   2. Insert a synthetic wallet for that user (uses the user's
 *      "borrower wallet" string).
 *   3. Insert a synthetic active loan against that wallet using a
 *      KNOWN enabled memecoin so the eligibility checks would pass.
 *   4. Insert a synthetic agent_delegations row authorizing a
 *      synthetic agent pubkey.
 *   5. Hit POST /api/v1/internal/agent/limit-close/arm with the
 *      synthetic data + verify it INSERTs a `limit_close_orders` row
 *      with source='agent_x402'.
 *   6. Hit GET /api/v1/internal/agent/limit-close/eligible-loans
 *      and verify the synthetic loan appears with the expected
 *      eligibility/reasons across multiple scenarios.
 *   7. Hit GET /api/v1/internal/agent/limit-close/delegations and
 *      verify the synthetic delegation appears with correct usage.
 *   8. Hit DELETE /api/v1/internal/agent/limit-close and verify the
 *      armed order cancels.
 *   9. Clean up every synthetic row in a finally{} block so a thrown
 *      assertion never leaves test data in prod.
 *
 * The engine is NOT exercised — this is a control-plane test. The
 * engine's own smoke test (`magpie-limitclose/scripts/smoke.js`)
 * covers the data-plane / execution side.
 *
 * Exit codes:
 *   0  — every check passed
 *   1  — at least one assertion failed
 *   2  — script-level error (DB unavailable, env missing, etc.)
 *
 * Required env:
 *   DATABASE_URL                — same as the bot
 *   BOT_INTERNAL_API_URL        — default http://127.0.0.1:3001
 *   INTERNAL_API_TOKEN          — same as the bot's
 *
 * Usage:
 *   DATABASE_URL=... INTERNAL_API_TOKEN=... \
 *     node scripts/verify-tier2/run.js
 */
import { query } from "../../src/db/pool.js";

const BOT_INTERNAL_API_URL =
  process.env.BOT_INTERNAL_API_URL || "http://127.0.0.1:3001";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const TEST_MARKER = "[tier2-verify]";

// Track checks for a final summary
let passes = 0;
let fails = 0;
let lastFail = null;

function pass(label, extra = "") {
  passes++;
  console.log(`   OK  ${label}${extra ? `  (${extra})` : ""}`);
}
function fail(label, msg) {
  fails++;
  lastFail = `${label}: ${msg}`;
  console.error(`\n  FAIL @ ${label}\n     ${msg}\n`);
}

async function assertHttp(method, path, opts = {}) {
  const url = `${BOT_INTERNAL_API_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Internal-Token": INTERNAL_API_TOKEN,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}

// Synthetic identifiers — randomized per run so concurrent runs
// don't collide.
const RUN_ID = Math.random().toString(36).slice(2, 10);
const TG_ID = -Date.now(); // negative so never collides with real TG IDs
const SYNTHETIC = {
  username: `tier2-verify-${RUN_ID}`,
  // Fake borrower wallet — base58, 44 chars. The actual on-chain bytes
  // don't matter because the internal arm endpoint validates shape
  // (PublicKey constructor) but never reads the on-chain account.
  borrowerWallet: "TestBorrower" + RUN_ID.padEnd(32, "X").slice(0, 32),
  agentPubkey: "TestAgent" + RUN_ID.padEnd(35, "X").slice(0, 35),
  // A real enabled memecoin mint — anything from supported_mints with
  // category != 'stock'/'etf'/'metal'. Will be picked dynamically.
  collateralMint: null,
  // Fake loan_pda — also shape-only validated.
  loanPda: "TestLoanPda" + RUN_ID.padEnd(33, "X").slice(0, 33),
  loanId: Math.floor(Math.random() * 1e15) + 1e15,
};

let createdUserId = null;
let createdLoanId = null;
let createdDelegationId = null;
let armedOrderId = null;

async function main() {
  console.log("Tier 2 (agentic limit-close) verification");
  console.log("==========================================");
  console.log("");

  // ── Preflight ────────────────────────────────────────────────
  if (!INTERNAL_API_TOKEN) {
    console.error("FAIL: INTERNAL_API_TOKEN env not set");
    process.exit(2);
  }
  pass("preflight: INTERNAL_API_TOKEN set");

  // Pick a real enabled memecoin to use as collateral
  try {
    const { rows: [m] } = await query(
      `SELECT mint, symbol FROM supported_mints
        WHERE enabled = TRUE
          AND category NOT IN ('stock','etf','metal')
          AND mint != 'So11111111111111111111111111111111111111112'
        ORDER BY RANDOM() LIMIT 1`,
    );
    if (!m) { fail("pick_collateral_mint", "no enabled memecoin found"); return; }
    SYNTHETIC.collateralMint = m.mint;
    pass("pick_collateral_mint", `${m.symbol}`);
  } catch (err) {
    fail("pick_collateral_mint", err.message);
    return;
  }

  // ── 1. Synthetic user ────────────────────────────────────────
  try {
    const { rows: [u] } = await query(
      `INSERT INTO users (telegram_id, telegram_username) VALUES ($1, $2) RETURNING id`,
      [TG_ID, SYNTHETIC.username],
    );
    createdUserId = u.id;
    pass("create_user", `id=${createdUserId}`);
  } catch (err) { fail("create_user", err.message); return; }

  // ── 2. Synthetic wallet ──────────────────────────────────────
  try {
    await query(
      `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag, source, label, is_active)
         VALUES ($1, $2, $3, $4, $5, 'verify-script', 'tier2-verify', TRUE)`,
      [createdUserId, SYNTHETIC.borrowerWallet, "fake_enc", "fake_nonce", "fake_tag"],
    );
    pass("create_wallet", `wallet=${SYNTHETIC.borrowerWallet.slice(0, 12)}…`);
  } catch (err) { fail("create_wallet", err.message); return; }

  // ── 3. Synthetic active loan ─────────────────────────────────
  try {
    const startTs = new Date();
    const dueTs = new Date(Date.now() + 7 * 86_400_000);
    const { rows: [l] } = await query(
      `INSERT INTO loans
         (user_id, loan_id, loan_pda, collateral_mint, collateral_amount, status,
          original_loan_amount_lamports, loan_amount_lamports,
          ltv_percentage, duration_days, program_id,
          borrower_wallet, start_timestamp, due_timestamp)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [createdUserId, SYNTHETIC.loanId, SYNTHETIC.loanPda, SYNTHETIC.collateralMint,
       "10000000",       // 10 token-units of collateral
       "1500000000",     // 1.5 SOL owed
       "1500000000",
       30, 7,
       process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh",
       SYNTHETIC.borrowerWallet,
       startTs.toISOString(), dueTs.toISOString()],
    );
    createdLoanId = l.id;
    pass("create_loan", `id=${createdLoanId} on-chain-id=${SYNTHETIC.loanId}`);
  } catch (err) { fail("create_loan", err.message); return; }

  // ── 4. Synthetic delegation ──────────────────────────────────
  try {
    const { rows: [d] } = await query(
      `INSERT INTO agent_delegations
         (user_id, user_wallet, agent_pubkey, action,
          max_per_order_lamports, max_active_orders, max_slippage_bps,
          status)
       VALUES ($1, $2, $3, 'limit_close', $4, $5, $6, 'active')
       RETURNING id`,
      [createdUserId, SYNTHETIC.borrowerWallet, SYNTHETIC.agentPubkey,
       "10000000000",  // 10 SOL per-order cap (way above the 1.5 SOL loan)
       5, 500],
    );
    createdDelegationId = d.id;
    pass("create_delegation", `id=${createdDelegationId}`);
  } catch (err) { fail("create_delegation", err.message); return; }

  // ── 5. /api/v1/internal/agent/limit-close/eligible-loans ─────
  // Pre-arm: verify the synthetic loan shows up as ELIGIBLE.
  try {
    const r = await assertHttp(
      "GET",
      `/api/v1/internal/agent/limit-close/eligible-loans?agent=${encodeURIComponent(SYNTHETIC.agentPubkey)}`,
    );
    if (r.status !== 200) throw new Error(`http ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    if (r.body.delegations_count !== 1) throw new Error(`expected 1 delegation, got ${r.body.delegations_count}`);
    if (r.body.eligible_loans_count !== 1) throw new Error(`expected 1 eligible loan, got ${r.body.eligible_loans_count}`);
    const w = r.body.by_wallet.find((x) => x.user_wallet === SYNTHETIC.borrowerWallet);
    if (!w) throw new Error("synthetic wallet not in by_wallet response");
    const loan = w.loans.find((x) => String(x.loan_id) === String(SYNTHETIC.loanId));
    if (!loan) throw new Error("synthetic loan not in wallet's loans");
    if (!loan.is_eligible) throw new Error(`expected eligible, got reasons=${JSON.stringify(loan.ineligibility_reasons)}`);
    pass("eligible_loans_pre_arm", `1 eligible loan visible`);
  } catch (err) { fail("eligible_loans_pre_arm", err.message); }

  // ── 6. /api/v1/internal/agent/limit-close/delegations ────────
  try {
    const r = await assertHttp(
      "GET",
      `/api/v1/internal/agent/limit-close/delegations?agent=${encodeURIComponent(SYNTHETIC.agentPubkey)}`,
    );
    if (r.status !== 200) throw new Error(`http ${r.status}`);
    if (r.body.count !== 1) throw new Error(`expected 1 delegation, got ${r.body.count}`);
    const d = r.body.delegations[0];
    if (d.user_wallet !== SYNTHETIC.borrowerWallet) throw new Error("wallet mismatch");
    if (d.bounds.max_active_orders !== 5) throw new Error("bounds mismatch");
    if (d.usage.headroom !== 5) throw new Error(`expected headroom 5, got ${d.usage.headroom}`);
    pass("delegations_lookup", `headroom=5/5`);
  } catch (err) { fail("delegations_lookup", err.message); }

  // ── 7. ARM via internal endpoint ─────────────────────────────
  try {
    const r = await assertHttp(
      "POST",
      `/api/v1/internal/agent/limit-close/arm`,
      {
        body: {
          user_wallet: SYNTHETIC.borrowerWallet,
          agent_pubkey: SYNTHETIC.agentPubkey,
          loan_id: String(SYNTHETIC.loanId),
          trigger_kind: "mc_usd",
          trigger_value_micro: "1000000000", // $1k MC (way above current, will never fire)
          slippage_bps: 200,
          sell_destination: "sol",
          x402_tx_signature: `synthetic_tx_${RUN_ID}`,
        },
      },
    );
    if (r.status !== 200 || !r.body.ok) throw new Error(`status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
    armedOrderId = r.body.order_id;
    if (r.body.source !== "agent_x402") throw new Error(`expected source=agent_x402, got ${r.body.source}`);
    if (r.body.source_agent_pubkey !== SYNTHETIC.agentPubkey) throw new Error("agent attribution mismatch");
    pass("arm_via_internal", `order_id=${armedOrderId} source=agent_x402`);
  } catch (err) { fail("arm_via_internal", err.message); }

  // ── 8. eligible-loans POST-arm: SAME loan now ineligible ─────
  // Loan should now show 'loan_already_has_active_order' as the reason
  // because the UNIQUE partial index would block a second arm.
  if (armedOrderId) {
    try {
      const r = await assertHttp(
        "GET",
        `/api/v1/internal/agent/limit-close/eligible-loans?agent=${encodeURIComponent(SYNTHETIC.agentPubkey)}`,
      );
      const loan = r.body.by_wallet[0]?.loans.find((x) => String(x.loan_id) === String(SYNTHETIC.loanId));
      if (!loan) throw new Error("loan disappeared from response");
      if (loan.is_eligible) throw new Error("loan still eligible after arm — UNIQUE-index check failed");
      if (!loan.ineligibility_reasons.includes("loan_already_has_active_order")) {
        throw new Error(`expected loan_already_has_active_order in reasons, got ${JSON.stringify(loan.ineligibility_reasons)}`);
      }
      // Also verify the agent's headroom dropped to 4
      const usage = r.body.by_wallet[0]?.delegation;
      if (usage.headroom !== 4) throw new Error(`expected headroom 4 after arm, got ${usage.headroom}`);
      pass("eligible_loans_post_arm", `dedup + headroom both correctly reflect armed order`);
    } catch (err) { fail("eligible_loans_post_arm", err.message); }

    // ── 9. Try to arm SAME loan again — should 409 ─────────────
    try {
      const r = await assertHttp("POST", `/api/v1/internal/agent/limit-close/arm`, {
        body: {
          user_wallet: SYNTHETIC.borrowerWallet,
          agent_pubkey: SYNTHETIC.agentPubkey,
          loan_id: String(SYNTHETIC.loanId),
          trigger_kind: "mc_usd", trigger_value_micro: "2000000000",
          slippage_bps: 200, sell_destination: "sol",
          x402_tx_signature: `synthetic_tx2_${RUN_ID}`,
        },
      });
      if (r.status !== 409) throw new Error(`expected 409, got ${r.status}`);
      if (r.body.error !== "loan_already_has_active_order") throw new Error(`expected loan_already_has_active_order, got ${r.body.error}`);
      pass("double_arm_blocked", `409 + correct error code`);
    } catch (err) { fail("double_arm_blocked", err.message); }

    // ── 10. Try to arm from a DIFFERENT agent against same wallet
    //         WITHOUT a delegation — should 403 no_active_delegation
    try {
      const r = await assertHttp("POST", `/api/v1/internal/agent/limit-close/arm`, {
        body: {
          user_wallet: SYNTHETIC.borrowerWallet,
          agent_pubkey: "DifferentAgent" + RUN_ID.padEnd(30, "Y").slice(0, 30),
          loan_id: String(SYNTHETIC.loanId),
          trigger_kind: "mc_usd", trigger_value_micro: "2000000000",
          slippage_bps: 200, sell_destination: "sol",
          x402_tx_signature: `synthetic_tx3_${RUN_ID}`,
        },
      });
      if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
      if (r.body.error !== "no_active_delegation") throw new Error(`expected no_active_delegation, got ${r.body.error}`);
      pass("undelegated_agent_blocked", `403 + no_active_delegation`);
    } catch (err) { fail("undelegated_agent_blocked", err.message); }

    // ── 11. DELETE — agent cancels its order ────────────────────
    try {
      const r = await assertHttp(
        "DELETE",
        `/api/v1/internal/agent/limit-close?id=${armedOrderId}&agent=${encodeURIComponent(SYNTHETIC.agentPubkey)}`,
      );
      if (r.status !== 200 || !r.body.ok) throw new Error(`status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
      if (r.body.cancelled_order_id !== armedOrderId) throw new Error("cancellation mismatch");
      pass("cancel_via_internal", `order ${armedOrderId} cancelled`);
    } catch (err) { fail("cancel_via_internal", err.message); }

    // ── 12. Verify DB: order is now status='cancelled', not 'armed'
    try {
      const { rows: [o] } = await query(
        `SELECT status, cancellation_reason FROM limit_close_orders WHERE id = $1`,
        [armedOrderId],
      );
      if (o.status !== "cancelled") throw new Error(`expected status=cancelled, got ${o.status}`);
      if (o.cancellation_reason !== "agent_cancel_via_x402") throw new Error(`expected agent_cancel_via_x402, got ${o.cancellation_reason}`);
      pass("final_db_state", `status=cancelled reason=agent_cancel_via_x402`);
    } catch (err) { fail("final_db_state", err.message); }
  }

  // ── Auth check: missing/invalid INTERNAL_API_TOKEN → 401 ──────
  try {
    const url = `${BOT_INTERNAL_API_URL}/api/v1/internal/agent/limit-close/delegations?agent=${encodeURIComponent(SYNTHETIC.agentPubkey)}`;
    const res = await fetch(url, {
      headers: { "X-Internal-Token": "wrong_token" },
    });
    if (res.status !== 401) throw new Error(`expected 401 for bad token, got ${res.status}`);
    pass("auth_reject_bad_token", `401 OK`);
  } catch (err) { fail("auth_reject_bad_token", err.message); }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error("\nFATAL:", err.message);
    process.exitCode = 2;
  } finally {
    // ── Cleanup — always runs ─────────────────────────────────
    console.log("\n   cleaning up synthetic rows…");
    try {
      if (armedOrderId) await query(`DELETE FROM limit_close_orders WHERE id = $1`, [armedOrderId]);
      if (createdDelegationId) await query(`DELETE FROM agent_delegations WHERE id = $1`, [createdDelegationId]);
      if (createdLoanId) await query(`DELETE FROM loans WHERE id = $1`, [createdLoanId]);
      // Wallets first (FK on user_id), then user
      await query(`DELETE FROM wallets WHERE user_id = $1`, [createdUserId]);
      if (createdUserId) await query(`DELETE FROM users WHERE id = $1 AND telegram_username = $2`, [createdUserId, SYNTHETIC.username]);
      console.log("   cleanup OK");
    } catch (err) {
      console.warn(`   cleanup encountered: ${err.message?.slice(0, 200)}`);
      console.warn(`   manual recovery: DELETE FROM users WHERE telegram_username = '${SYNTHETIC.username}';`);
    }

    console.log("\n==========================================");
    console.log(`Result: ${passes} passed, ${fails} failed`);
    if (fails > 0) {
      console.error(`FAIL: last failure was — ${lastFail}`);
      process.exitCode = 1;
    } else {
      console.log("ALL CHECKS PASSED — Tier 2 wiring is intact.");
    }
    process.exit(process.exitCode || 0);
  }
})();
