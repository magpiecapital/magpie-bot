/**
 * Auto-extend decision core — PURE, zero imports, no side effects — so every
 * boundary can be unit-tested without booting the bot (same pattern as
 * conversion-attempt.js and arming-caps.js). Consumed by
 * auto-extend-watcher.js; guarded by `npm run check:auto-extend`.
 *
 * WHY THIS EXISTS (strategy doc 18). Borrowers forget. The Sec3 Q-02
 * hardening makes the deadline final — an overdue loan can never be extended.
 * For borrowers who explicitly opted in, the bot auto-executes extend_loan in
 * a strictly PRE-due window. The rules here are the entire safety envelope:
 *
 *   - WINDOW: fire only when due is (30m .. 2h] away. The 30m floor keeps a
 *     wide margin from the Q-02 boundary (an extend landing after due would
 *     just burn a fee tx on a program refusal). The 2h ceiling means we act
 *     after the T-6h human warning has had time to work — auto-extend is the
 *     safety net, not the first resort.
 *   - OPT-IN: users.auto_extend_opt_in must be explicitly true. Money
 *     movement is never default-on.
 *   - CAP: at most MAX_AUTO_EXTENDS consecutive auto-extends per loan.
 *     Uncapped auto-extend is a zombie-loan factory (fees bleed forever).
 *   - HEALTH: skip when collateral value < MIN_HEALTH_RATIO × owed — an
 *     auto-extend there mostly charges a doomed borrower fees. A NULL ratio
 *     (price unavailable) ALLOWS the extend: the extension protects the
 *     borrower, and a transient price outage must not cost them their
 *     collateral. [[feedback_defense_in_depth_failopen_when_lower_layer_proven]]
 *   - BALANCE: managed wallet must cover fee + tx overhead. We never touch
 *     anything but the borrower's own wallet.
 *   - COOLDOWN: one attempt per loan per ATTEMPT_COOLDOWN_MS, so a failing
 *     extend doesn't retry-spam fees or DMs inside one window.
 */

export const RULE_VERSION = "auto-extend-v1 (doc18 2026-08-14)";

export const WINDOW_CEILING_MS = 2 * 60 * 60 * 1000; // start trying at T-2h
export const WINDOW_FLOOR_MS = 30 * 60 * 1000; // never inside T-30m (Q-02 margin)
export const MAX_AUTO_EXTENDS = 2;
export const MIN_HEALTH_RATIO = 1.1;
export const ATTEMPT_COOLDOWN_MS = 15 * 60 * 1000;
// Fee-payment overhead beyond the extend fee itself: tx fee + priority fee +
// temporary wSOL ATA rent (recovered on close, but must be fundable upfront).
export const BALANCE_BUFFER_LAMPORTS = 5_000_000n; // 0.005 SOL

/**
 * Decide whether ONE loan gets auto-extended right now.
 *
 * @param {{
 *   status: string,
 *   dueMs: number,                       // loan due timestamp (ms epoch)
 *   optIn: boolean,
 *   autoExtendCount: number,
 *   feeLamports: bigint,                 // live extend fee for this loan
 *   walletBalanceLamports: bigint,       // borrower managed-wallet SOL
 *   healthRatio: number | null,          // collateral value / owed; null = unavailable
 *   lastAttemptMs: number | null,        // last auto-extend attempt for this loan
 * }} loan
 * @param {number} nowMs
 * @returns {{ action: "extend" } | { action: "skip", reason: string }}
 */
export function decideAutoExtend(loan, nowMs) {
  try {
    if (loan.status !== "active") return { action: "skip", reason: "not_active" };
    if (!loan.optIn) return { action: "skip", reason: "not_opted_in" };

    // Explicit input validation. Garbage inputs don't throw in JS relational
    // ops — NaN comparisons and BigInt-vs-bad-string both quietly evaluate
    // false — so without these guards a malformed row would fall THROUGH the
    // window/balance checks and auto-move money. Caught by check:auto-extend.
    if (typeof loan.feeLamports !== "bigint" || typeof loan.walletBalanceLamports !== "bigint") {
      return { action: "skip", reason: "decision_error" };
    }
    const untilDue = loan.dueMs - nowMs;
    if (!Number.isFinite(untilDue)) return { action: "skip", reason: "decision_error" };
    if (untilDue <= WINDOW_FLOOR_MS) {
      // Includes already-overdue. Never brush the Q-02 boundary.
      return { action: "skip", reason: "past_window_floor" };
    }
    if (untilDue > WINDOW_CEILING_MS) return { action: "skip", reason: "before_window" };

    if (loan.autoExtendCount >= MAX_AUTO_EXTENDS) return { action: "skip", reason: "cap_reached" };

    if (loan.lastAttemptMs != null && nowMs - loan.lastAttemptMs < ATTEMPT_COOLDOWN_MS) {
      return { action: "skip", reason: "cooldown" };
    }

    if (loan.healthRatio != null && loan.healthRatio < MIN_HEALTH_RATIO) {
      return { action: "skip", reason: "underwater" };
    }

    if (loan.walletBalanceLamports < loan.feeLamports + BALANCE_BUFFER_LAMPORTS) {
      return { action: "skip", reason: "insufficient_balance" };
    }

    return { action: "extend" };
  } catch {
    // A malformed row must never crash the watcher loop — and must never
    // auto-move money either. Skip, loudly classifiable.
    return { action: "skip", reason: "decision_error" };
  }
}

/**
 * Extend fee for a loan, mirroring executeExtendLoan's tier math exactly
 * (Express 30% LTV → 3%, Quick 25% → 2%, Standard → 1.5% of live owed).
 * Kept here (pure) so the balance check and the execution can never drift.
 */
export function extendFeeLamports(ltvPercentage, owedLiveLamports) {
  const feeBps = ltvPercentage >= 30 ? 300n : ltvPercentage >= 25 ? 200n : 150n;
  return (owedLiveLamports * feeBps) / 10_000n;
}
