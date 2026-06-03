/**
 * Loan reconciler — proactive on-chain ↔ DB drift detection.
 *
 * Every 5 minutes, sweeps every loan the DB considers 'active' and
 * compares with the on-chain source of truth. Reconciles when they
 * disagree:
 *
 *   - On-chain status flipped to Repaid → mark DB row repaid
 *   - On-chain status flipped to Liquidated → mark DB row liquidated +
 *     record credit event
 *   - On-chain repay_amount decremented (partial repay landed but
 *     recordPartialRepay's DB write failed) → update DB
 *   - On-chain due_timestamp advanced (extend landed but recordExtendLoan
 *     failed) → update DB
 *
 * Belt-and-suspenders defense layer on top of the reactive
 * getLiveOwedLamports() helper. That helper heals on user-initiated
 * reads; this watcher catches loans no one's looked at recently.
 *
 * Operates on heartbeat + small batches so RPC cost stays low even
 * with hundreds of active loans.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { getReadOnlyProgram } from "../solana/program.js";

const POLL_INTERVAL_MS = Number(process.env.LOAN_RECONCILER_MS) || 5 * 60 * 1000;
const BATCH_LIMIT = 50;

let lastRunAt = null;
let lastDriftFixed = 0;

export function getReconcilerHeartbeat() {
  return { lastRunAt, lastDriftFixed };
}

async function reconcileTick() {
  const program = getReadOnlyProgram();

  const { rows: active } = await query(
    `SELECT id, loan_id, loan_pda, user_id, status,
            original_loan_amount_lamports, due_timestamp
       FROM loans
      WHERE status = 'active'
      ORDER BY updated_at ASC NULLS FIRST
      LIMIT $1`,
    [BATCH_LIMIT],
  );

  if (active.length === 0) {
    lastRunAt = new Date();
    return { checked: 0, fixed: 0 };
  }

  // Parallel fetch all loan accounts. Anchor's fetchMultiple is faster
  // than N sequential fetches for this kind of bulk reconciliation.
  let onChainStates;
  try {
    onChainStates = await program.account.loan.fetchMultiple(
      active.map((l) => new PublicKey(l.loan_pda)),
    );
  } catch (err) {
    console.error("[loan-reconciler] bulk fetch failed:", err.message);
    return { checked: 0, fixed: 0, error: err.message };
  }

  let fixed = 0;
  for (let i = 0; i < active.length; i++) {
    const dbLoan = active[i];
    const onChain = onChainStates[i];

    if (!onChain) {
      // On-chain loan account was closed (probably liquidated post-default
      // with collateral fully transferred). Defensive: mark DB row
      // 'liquidated' so risk views stop counting it.
      try {
        await query(
          `UPDATE loans SET status = 'liquidated', updated_at = NOW() WHERE id = $1 AND status = 'active'`,
          [dbLoan.id],
        );
        console.log(`[loan-reconciler] Loan ${dbLoan.id} (#${dbLoan.loan_id}) account missing on-chain → marked liquidated`);
        fixed++;
      } catch (err) {
        console.warn("[loan-reconciler] failed to mark missing loan liquidated:", err.message);
      }
      continue;
    }

    // 1. Status changes (Active → Repaid or Liquidated)
    const onChainStatus =
      "repaid" in onChain.status ? "repaid"
      : "liquidated" in onChain.status ? "liquidated"
      : "active";

    if (onChainStatus !== dbLoan.status) {
      try {
        await query(
          `UPDATE loans SET status = $2, updated_at = NOW() WHERE id = $1`,
          [dbLoan.id, onChainStatus],
        );
        console.log(
          `[loan-reconciler] Loan ${dbLoan.id} (#${dbLoan.loan_id}) status ${dbLoan.status} → ${onChainStatus}`,
        );
        // Record a credit event for closure types we hadn't booked
        if (onChainStatus === "repaid" || onChainStatus === "liquidated") {
          try {
            const { recordCreditEvent } = await import("./credit-score.js");
            // Repaid via reconciler — we can't tell if early/ontime/late
            // without the actual repay tx; assume repay_ontime as a baseline.
            const eventType =
              onChainStatus === "liquidated" ? "liquidated" : "repay_ontime";
            await recordCreditEvent(dbLoan.user_id, eventType, dbLoan.id);
          } catch { /* non-critical */ }
        }
        fixed++;
        // Skip amount/timestamp checks for closed loans
        continue;
      } catch (err) {
        console.warn("[loan-reconciler] status update failed:", err.message);
      }
    }

    // 2. repay_amount drift (partial repay landed but DB sync dropped)
    const onChainRepay = BigInt(onChain.repayAmount.toString());
    const dbRepay = BigInt(dbLoan.original_loan_amount_lamports);
    if (onChainRepay !== dbRepay) {
      try {
        await query(
          `UPDATE loans
              SET original_loan_amount_lamports = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [dbLoan.id, onChainRepay.toString()],
        );
        console.log(
          `[loan-reconciler] Loan ${dbLoan.id} (#${dbLoan.loan_id}) repay_amount ${dbRepay} → ${onChainRepay}`,
        );
        fixed++;
      } catch (err) {
        console.warn("[loan-reconciler] repay_amount update failed:", err.message);
      }
    }

    // 3. due_timestamp drift (extend landed but recordExtendLoan dropped)
    const onChainDueMs = Number(onChain.dueTimestamp) * 1000;
    const dbDueMs = new Date(dbLoan.due_timestamp).getTime();
    // Allow small drift (1 second) since rounding can introduce noise
    if (Math.abs(onChainDueMs - dbDueMs) > 1000) {
      try {
        await query(
          `UPDATE loans
              SET due_timestamp = to_timestamp($2),
                  warned_24h_at = NULL,
                  warned_6h_at = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [dbLoan.id, Math.floor(onChainDueMs / 1000)],
        );
        console.log(
          `[loan-reconciler] Loan ${dbLoan.id} (#${dbLoan.loan_id}) due_timestamp synced (extend recovered)`,
        );
        fixed++;
      } catch (err) {
        console.warn("[loan-reconciler] due_timestamp update failed:", err.message);
      }
    }
  }

  lastRunAt = new Date();
  lastDriftFixed = fixed;
  if (fixed > 0) {
    console.log(`[loan-reconciler] Reconciled ${fixed} drift(s) across ${active.length} active loans`);
  }
  return { checked: active.length, fixed };
}

/**
 * Public manual trigger — used by the /reconcile admin command and
 * the bot's startup self-check. Safe to call concurrently with the
 * scheduled tick (the SQL UPDATEs are idempotent).
 */
export async function runLoanReconciliation() {
  try {
    return await reconcileTick();
  } catch (err) {
    console.error("[loan-reconciler] tick failed:", err.message);
    return { checked: 0, fixed: 0, error: err.message };
  }
}

export function startLoanReconciler() {
  console.log(`[loan-reconciler] Starting (interval=${POLL_INTERVAL_MS}ms)`);
  // First sweep ~30s after boot so other services finish initializing
  setTimeout(runLoanReconciliation, 30_000);
  return setInterval(runLoanReconciliation, POLL_INTERVAL_MS);
}
