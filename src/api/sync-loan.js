/**
 * POST /api/v1/sync-loan
 *
 * Post-tx sync hook for site-side actions (repay, partial-repay,
 * topup, extend). The site calls this immediately after waitConfirmed
 * lands the on-chain tx so the bot's DB picks up the state change
 * instantly — without waiting for the every-5-min loan-reconciler.
 *
 * The activity feed, /stats lifetime totals, credit score, and
 * on-time streak all read from the bot's DB. Before this endpoint,
 * a site repay landed on-chain but stayed "active" in the DB for up
 * to 5 minutes, which left the user staring at a stale dashboard.
 *
 * Design:
 *   - Fully PUBLIC: no auth required. The endpoint can ONLY pull the
 *     bot's DB toward on-chain truth — it cannot move funds, sign
 *     anything, or write any state that isn't already true on-chain.
 *     Worst case is a wasted RPC fetch.
 *   - On-chain is the source of truth. We fetch the live Loan
 *     account and reconcile the DB row against it, calling the same
 *     handlers the TG bot calls (markLoanRepaid → credit event +
 *     streak + LP loyalty; recordPartialRepay; recordExtendLoan).
 *   - Idempotent. Calling N times for the same tx is safe — the DB
 *     update is conditional (WHERE status='active' / WHERE the
 *     amount differs), and credit-event recording is keyed off the
 *     transition, not the call.
 *   - Rate-limited by loan_pda to bound RPC cost from accidental
 *     hot-loops on the client.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { getReadOnlyProgram, chooseProgramIdForLoan } from "../solana/program.js";
import {
  markLoanRepaid,
  recordPartialRepay,
  recordExtendLoan,
} from "../services/loans.js";

const PER_LOAN_MIN_INTERVAL_MS = 2_000;
const lastByLoan = new Map();

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 4 * 1024) {
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

export async function handleSyncLoan(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return { status: 400, body: { error: `Invalid body: ${e.message}` } }; }

  const { loan_pda, signature } = body ?? {};
  if (!loan_pda) {
    return { status: 400, body: { error: "loan_pda required" } };
  }
  let loanPk;
  try { loanPk = new PublicKey(loan_pda); }
  catch { return { status: 400, body: { error: "invalid loan_pda" } }; }

  // Per-loan light rate limit. The site never NEEDS to call this
  // more than once per tx, but if some UI bug or a refresh-while-
  // submitting hits the endpoint twice, we want the second call to
  // be a fast no-op rather than another RPC roundtrip.
  const now = Date.now();
  const last = lastByLoan.get(loan_pda) || 0;
  if (now - last < PER_LOAN_MIN_INTERVAL_MS) {
    return { status: 200, body: { ok: true, skipped: "rate_limit", action: "noop" } };
  }
  lastByLoan.set(loan_pda, now);

  // 1) Find the DB row.
  const { rows: [dbLoan] } = await query(
    `SELECT id, loan_id, loan_pda, user_id, status, program_id,
            original_loan_amount_lamports, due_timestamp, collateral_amount
       FROM loans WHERE loan_pda = $1`,
    [loan_pda],
  );
  if (!dbLoan) {
    return { status: 404, body: { error: "loan_pda not found in DB" } };
  }

  // 2) Fetch the live on-chain state. The DB row carries program_id
  //    so we hit the right Anchor program (v1 memecoin pool, v2 RWA
  //    pool, etc.) and decode against the matching IDL.
  const programId = chooseProgramIdForLoan(dbLoan);
  const program = getReadOnlyProgram(programId);
  let onChain;
  try {
    onChain = await program.account.loan.fetch(loanPk);
  } catch (err) {
    // Account missing on-chain → likely liquidated + collateral
    // transferred (program closes the loan account in that path).
    // Mirror the reconciler's behavior.
    if (dbLoan.status === "active") {
      await query(
        `UPDATE loans SET status = 'liquidated', updated_at = NOW()
           WHERE id = $1 AND status = 'active'`,
        [dbLoan.id],
      );
      return { status: 200, body: { ok: true, action: "marked_liquidated_account_missing" } };
    }
    return {
      status: 200,
      body: { ok: true, action: "noop", reason: `on-chain fetch failed: ${err.message?.slice(0, 120)}` },
    };
  }

  const onChainStatus =
    "repaid" in onChain.status ? "repaid"
    : "liquidated" in onChain.status ? "liquidated"
    : "active";

  // 3a) Status flipped — call the canonical handler so DB row,
  //     credit event, streak, and LP loyalty all stay consistent
  //     with the TG-bot path.
  if (onChainStatus === "repaid" && dbLoan.status === "active") {
    await markLoanRepaid(dbLoan.id, signature ?? null);
    return { status: 200, body: { ok: true, action: "marked_repaid", loan_id: dbLoan.loan_id } };
  }
  if (onChainStatus === "liquidated" && dbLoan.status === "active") {
    // Liquidation comes through the keeper path which already books
    // its own credit event + streak reset. If a liquidation slipped
    // through and the DB didn't catch up, fall back to a minimal
    // update (don't record credit twice).
    await query(
      `UPDATE loans SET status = 'liquidated', updated_at = NOW()
         WHERE id = $1 AND status = 'active'`,
      [dbLoan.id],
    );
    return { status: 200, body: { ok: true, action: "marked_liquidated", loan_id: dbLoan.loan_id } };
  }

  // 3b) Status still active, but amount drifted — partial repay landed.
  const onChainRepay = BigInt(onChain.repayAmount.toString());
  const dbRepay = BigInt(dbLoan.original_loan_amount_lamports);
  if (onChainStatus === "active" && onChainRepay < dbRepay) {
    const diff = dbRepay - onChainRepay;
    await recordPartialRepay(dbLoan.id, diff, dbLoan.user_id);
    return {
      status: 200,
      body: { ok: true, action: "recorded_partial_repay", paid_sol: Number(diff) / 1e9 },
    };
  }

  // 3c) Status still active, due_timestamp advanced — extend landed.
  // The Anchor due_unix_seconds field is i64 in some IDL versions; coerce.
  const onChainDue = Number(onChain.dueUnixSeconds ?? onChain.dueTimestamp ?? 0) * 1000;
  const dbDue = new Date(dbLoan.due_timestamp).getTime();
  if (onChainStatus === "active" && onChainDue && onChainDue > dbDue + 60_000) {
    await recordExtendLoan(dbLoan.id, dbLoan.user_id);
    return { status: 200, body: { ok: true, action: "recorded_extend", loan_id: dbLoan.loan_id } };
  }

  // 3d) Status still active, collateral amount grew — topup landed.
  const onChainCollateral = BigInt(onChain.collateralAmount?.toString?.() ?? "0");
  const dbCollateral = BigInt(dbLoan.collateral_amount ?? "0");
  if (onChainStatus === "active" && onChainCollateral > dbCollateral) {
    const diff = onChainCollateral - dbCollateral;
    await query(
      `UPDATE loans
         SET collateral_amount = $2::numeric,
             last_health_alert = NULL,
             updated_at = NOW()
         WHERE id = $1`,
      [dbLoan.id, onChainCollateral.toString()],
    );
    // Best-effort credit event for the topup (matches the TG-side recordTopup).
    try {
      const { recordCreditEvent } = await import("../services/credit-score.js");
      await recordCreditEvent(dbLoan.user_id, "topup", dbLoan.id);
    } catch { /* non-critical */ }
    return {
      status: 200,
      body: { ok: true, action: "recorded_topup", added_raw: diff.toString() },
    };
  }

  // 3e) Everything already matches.
  return {
    status: 200,
    body: { ok: true, action: "noop", reason: "DB already in sync with on-chain" },
  };
}
