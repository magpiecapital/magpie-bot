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
 * P0 BUG FIXED 2026-06-18 PM: previously this reconciler called
 * getReadOnlyProgram() with no args, which defaults to V1's program ID.
 * For loans on V3/V4 programs, the loan_pda doesn't exist under V1, so
 * fetchMultiple returned null → the reconciler then MARKED THE LOAN
 * LIQUIDATED. That is the "loan just closed for no reason" smoking gun.
 *
 * Two fixes:
 *   1. The SELECT now pulls program_id per loan and we group by program
 *      then fetch each group under the matching program.
 *   2. Marking-liquidated-on-missing is gated behind a CONSECUTIVE
 *      observation threshold (MISSING_OBSERVATION_THRESHOLD, default 3
 *      consecutive 5-min ticks) AND a direct getAccountInfo confirming
 *      the account literally has zero lamports + zero data. RPC blips
 *      no longer cascade into a phantom liquidation.
 *
 * Belt-and-suspenders defense layer on top of the reactive
 * getLiveOwedLamports() helper. That helper heals on user-initiated
 * reads; this watcher catches loans no one's looked at recently.
 *
 * Operates on heartbeat + small batches so RPC cost stays low even
 * with hundreds of active loans.
 *
 * [[feedback_no_breakage_to_existing_users]]
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { connection, withFailover } from "../solana/connection.js";
import {
  getReadOnlyProgram,
  PROGRAM_ID,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
} from "../solana/program.js";
import { notifyAdmin } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.LOAN_RECONCILER_MS) || 5 * 60 * 1000;
const BATCH_LIMIT = 50;
const MISSING_OBSERVATION_THRESHOLD = Number(process.env.LOAN_RECONCILER_MISSING_THRESHOLD) || 3;

let lastRunAt = null;
let lastDriftFixed = 0;
// Map<loanId, consecutive_missing_tick_count>. Resets on successful fetch.
const _missingTickCounts = new Map();

export function getReconcilerHeartbeat() {
  return { lastRunAt, lastDriftFixed };
}

/**
 * Resolve a loan's program_id (string) to its PublicKey, or null if the
 * env doesn't have that program configured (which would mean we can't
 * safely reconcile that loan and must skip it).
 */
function resolveProgramPubkey(programIdStr) {
  if (!programIdStr) return PROGRAM_ID; // legacy rows pre-V3
  try {
    const pk = new PublicKey(programIdStr);
    if (pk.equals(PROGRAM_ID)) return PROGRAM_ID;
    if (PROGRAM_ID_V3 && pk.equals(PROGRAM_ID_V3)) return PROGRAM_ID_V3;
    if (PROGRAM_ID_V4 && pk.equals(PROGRAM_ID_V4)) return PROGRAM_ID_V4;
    return pk; // unknown but parseable — caller may handle defensively
  } catch {
    return null;
  }
}

/**
 * Confirm that an on-chain account is GENUINELY closed before we mark
 * the DB loan liquidated. Closed Solana accounts have zero lamports and
 * zero data. RPC blips and partial responses can return null from
 * fetchMultiple without the account actually being closed — this is the
 * authoritative double-check.
 *
 * Returns true ONLY if direct getAccountInfo confirms closed state.
 */
async function isAccountGenuinelyClosed(loanPda) {
  try {
    const info = await withFailover((conn) =>
      conn.getAccountInfo(new PublicKey(loanPda), "confirmed"),
    );
    // Truly closed: account doesn't exist OR has zero lamports AND zero data.
    return info === null || (info.lamports === 0 && info.data.length === 0);
  } catch {
    // RPC failure on the confirmation step — fail SAFE (don't mark liquidated).
    return false;
  }
}

async function reconcileTick() {
  // Pull program_id per loan so we can route each fetch to its matching
  // program. Without this, V3/V4 loans return null from V1's fetcher and
  // would get phantom-liquidated.
  const { rows: active } = await query(
    `SELECT id, loan_id, loan_pda, user_id, status,
            original_loan_amount_lamports, due_timestamp,
            program_id
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

  // Group loans by program_id (PublicKey). Skip loans whose program we
  // can't resolve — better to leave alone than risk a phantom liquidation.
  const byProgram = new Map(); // programId.toBase58() -> { programPk, loans }
  const skipped = [];
  for (const l of active) {
    const programPk = resolveProgramPubkey(l.program_id);
    if (!programPk) {
      skipped.push({ id: l.id, reason: "unresolvable_program_id" });
      continue;
    }
    const key = programPk.toBase58();
    if (!byProgram.has(key)) byProgram.set(key, { programPk, loans: [] });
    byProgram.get(key).loans.push(l);
  }

  let fixed = 0;
  let phantomMarkPrevented = 0;

  for (const [_, { programPk, loans }] of byProgram.entries()) {
    let program;
    try {
      program = getReadOnlyProgram(programPk);
    } catch (err) {
      console.warn(`[loan-reconciler] could not build program for ${programPk.toBase58().slice(0,8)}: ${err.message}`);
      continue;
    }

    let onChainStates;
    try {
      onChainStates = await withFailover(async () =>
        program.account.loan.fetchMultiple(loans.map((l) => new PublicKey(l.loan_pda))),
      );
    } catch (err) {
      console.error(`[loan-reconciler] bulk fetch failed for ${programPk.toBase58().slice(0,8)}: ${err.message}`);
      // RPC failure across all backups — skip THIS program's group for this
      // tick. The next tick re-tries. The whole batch is NOT marked as
      // missing observations.
      continue;
    }

    for (let i = 0; i < loans.length; i++) {
      const dbLoan = loans[i];
      const onChain = onChainStates[i];

      if (!onChain) {
        // On-chain account returned null. This could mean:
        //   (a) Genuinely liquidated + account closed
        //   (b) Wrong program (shouldn't happen now — we routed by program_id)
        //   (c) RPC partial response / temporary indexing lag
        //
        // Gate the liquidated mark behind:
        //   1. MISSING_OBSERVATION_THRESHOLD consecutive ticks observed null
        //   2. Direct getAccountInfo confirms zero lamports + zero data
        //
        // Either check fails -> skip THIS tick + DM operator at the threshold.
        const prev = _missingTickCounts.get(dbLoan.id) || 0;
        const next = prev + 1;
        _missingTickCounts.set(dbLoan.id, next);

        if (next < MISSING_OBSERVATION_THRESHOLD) {
          phantomMarkPrevented++;
          if (next === 1) {
            // First miss — log so operator can correlate if needed.
            console.warn(
              `[loan-reconciler] loan ${dbLoan.id} (#${dbLoan.loan_id}) missing on-chain — observation 1/${MISSING_OBSERVATION_THRESHOLD} (not marking yet)`,
            );
          }
          continue;
        }

        // Threshold met. Double-check on-chain directly.
        const genuinelyClosed = await isAccountGenuinelyClosed(dbLoan.loan_pda);
        if (!genuinelyClosed) {
          phantomMarkPrevented++;
          console.warn(
            `[loan-reconciler] loan ${dbLoan.id} (#${dbLoan.loan_id}) missing from fetchMultiple but getAccountInfo says NOT closed — SKIPPING liquidation mark`,
          );
          try {
            await notifyAdmin(
              `CRIT [loan-reconciler] loan ${dbLoan.id} (#${dbLoan.loan_id}) showed missing for ${next} ticks but direct fetch says account is NOT closed. Phantom-liquidation prevented. Investigate RPC indexing or partial response shape.`,
            );
          } catch {}
          continue;
        }

        // OK — genuine on-chain liquidation. Mark it.
        try {
          await query(
            `UPDATE loans SET status = 'liquidated', updated_at = NOW() WHERE id = $1 AND status = 'active'`,
            [dbLoan.id],
          );
          console.log(
            `[loan-reconciler] loan ${dbLoan.id} (#${dbLoan.loan_id}) account confirmed closed on-chain → marked liquidated`,
          );
          try {
            const { recordCreditEvent } = await import("./credit-score.js");
            await recordCreditEvent(dbLoan.user_id, "liquidated", dbLoan.id);
          } catch { /* non-critical */ }
          _missingTickCounts.delete(dbLoan.id);
          fixed++;
        } catch (err) {
          console.warn("[loan-reconciler] failed to mark missing loan liquidated:", err.message);
        }
        continue;
      }

      // Got a successful fetch — clear any prior missing-tick count.
      _missingTickCounts.delete(dbLoan.id);

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
          if (onChainStatus === "repaid" || onChainStatus === "liquidated") {
            try {
              const { recordCreditEvent } = await import("./credit-score.js");
              const eventType =
                onChainStatus === "liquidated" ? "liquidated" : "repay_ontime";
              await recordCreditEvent(dbLoan.user_id, eventType, dbLoan.id);
            } catch { /* non-critical */ }
          }
          fixed++;
          continue;
        } catch (err) {
          console.warn("[loan-reconciler] status update failed:", err.message);
        }
      }

      // 2. repay_amount drift
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

      // 3. due_timestamp drift
      const onChainDueMs = Number(onChain.dueTimestamp) * 1000;
      const dbDueMs = new Date(dbLoan.due_timestamp).getTime();
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
            `[loan-reconciler] Loan ${dbLoan.id} (#${dbLoan.loan_id}) due_timestamp synced`,
          );
          fixed++;
        } catch (err) {
          console.warn("[loan-reconciler] due_timestamp update failed:", err.message);
        }
      }
    }
  }

  lastRunAt = new Date();
  lastDriftFixed = fixed;
  if (fixed > 0 || phantomMarkPrevented > 0 || skipped.length > 0) {
    console.log(
      `[loan-reconciler] checked=${active.length} fixed=${fixed} phantomPrevented=${phantomMarkPrevented} skipped=${skipped.length}`,
    );
  }
  return { checked: active.length, fixed, phantomMarkPrevented, skipped: skipped.length };
}

/**
 * Public manual trigger — used by the /reconcile admin command and
 * the bot's startup self-check.
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
  setTimeout(runLoanReconciliation, 30_000);
  return setInterval(runLoanReconciliation, POLL_INTERVAL_MS);
}
