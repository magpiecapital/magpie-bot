import { query } from "../db/pool.js";

// ─── Loan limit tiers ───────────────────────────────────────────────────────
// All values in lamports (1 SOL = 1e9 lamports).
//
// Two qualification axes:
//   - On-time repay count (loans repaid before due_timestamp)
//   - Credit-score tier (300-850, mapped to bronze/silver/gold/platinum
//     in services/credit-score.js)
//
// The user's effective tier is the BEST of either qualification. A
// Gold-credit user with only 1 on-time repay still gets Gold limits.
//
// Tier progression (operator-set 2026-06-08, Gold/Platinum cap raised
// to 40 SOL the same day — rewarding sustained on-time repayers):
//   new      — 3 SOL / 3 SOL    (zero repay history)
//   trusted  — 5 SOL / 10 SOL   (3+ on-time repays; pre-Gold credit)
//   gold     — 10 SOL / 40 SOL  (credit score 650+)
//   platinum — 10 SOL / 40 SOL  (credit score 750+)
//
// Outstanding cap is per-USER (aggregated across every linked wallet),
// not per-wallet — matches our credit-scoring aggregation model.
const SOL = 1_000_000_000n;

const LIMIT_TIERS = {
  new:      { maxPerLoan: 3n  * SOL, maxOutstanding: 3n  * SOL, minOnTimeRepays: 0 },
  trusted:  { maxPerLoan: 5n  * SOL, maxOutstanding: 10n * SOL, minOnTimeRepays: 3 },
  gold:     { maxPerLoan: 10n * SOL, maxOutstanding: 40n * SOL, minOnTimeRepays: 0 },
  platinum: { maxPerLoan: 10n * SOL, maxOutstanding: 40n * SOL, minOnTimeRepays: 0 },
};

/**
 * Determine which loan-limit tier a user qualifies for. The qualification
 * is the BEST of (on-time-repay-count tier) and (credit-score tier) —
 * so a high-credit-score user gets their tier benefits even before
 * accumulating 3 on-time repays on this protocol.
 */
async function getUserLimitTier(userId) {
  // 1. On-time repay count (legacy qualification, still in effect)
  const [{ rows: [stats] }, { rows: [credit] }] = await Promise.all([
    query(
      `SELECT COUNT(*) AS repaid_ontime
       FROM loans
       WHERE user_id = $1
         AND status = 'repaid'
         AND updated_at <= due_timestamp`,
      [userId],
    ),
    // 2. Credit-score tier (if the user has one; null otherwise)
    query(
      `SELECT tier FROM credit_scores WHERE user_id = $1 LIMIT 1`,
      [userId],
    ).catch(() => ({ rows: [] })),
  ]);

  const onTimeRepays = Number(stats?.repaid_ontime || 0);
  const creditTier = credit?.tier; // "bronze" | "silver" | "gold" | "platinum" | undefined

  // Credit-tier qualification — Gold+ unlocks the new 20 SOL limits.
  if (creditTier === "platinum") {
    return { tier: "platinum", ...LIMIT_TIERS.platinum };
  }
  if (creditTier === "gold") {
    return { tier: "gold", ...LIMIT_TIERS.gold };
  }
  // Repay-count qualification — pre-Gold but with on-time history.
  if (onTimeRepays >= LIMIT_TIERS.trusted.minOnTimeRepays) {
    return { tier: "trusted", ...LIMIT_TIERS.trusted };
  }
  return { tier: "new", ...LIMIT_TIERS.new };
}

/**
 * Get the user's total outstanding loan amount (active loans only).
 */
async function getOutstandingLamports(userId) {
  const { rows: [result] } = await query(
    `SELECT COALESCE(SUM(original_loan_amount_lamports::numeric), 0) AS total
     FROM loans
     WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return BigInt(Math.floor(Number(result.total)));
}

/**
 * Check whether a proposed loan amount is within the user's limits.
 *
 * @param {number|string} userId
 * @param {bigint|number} proposedLoanLamports - the pre-fee loan amount
 * @returns {{ allowed: boolean, reason?: string, tier: string, maxPerLoan: bigint, maxOutstanding: bigint, currentOutstanding: bigint }}
 */
export async function checkLoanLimits(userId, proposedLoanLamports) {
  const limits = await getUserLimitTier(userId);
  const outstanding = await getOutstandingLamports(userId);
  const proposed = BigInt(proposedLoanLamports);

  const fmtSol = (lamports) => (Number(lamports) / 1e9).toFixed(4);

  if (proposed > limits.maxPerLoan) {
    return {
      allowed: false,
      reason: `Max loan size is ${fmtSol(limits.maxPerLoan)} SOL for ${limits.tier} tier. Choose less collateral or a lower LTV.`,
      tier: limits.tier,
      maxPerLoan: limits.maxPerLoan,
      maxOutstanding: limits.maxOutstanding,
      currentOutstanding: outstanding,
    };
  }

  if (outstanding + proposed > limits.maxOutstanding) {
    const available = limits.maxOutstanding - outstanding;
    return {
      allowed: false,
      reason: available <= 0n
        ? `You've reached your max outstanding limit of ${fmtSol(limits.maxOutstanding)} SOL (${limits.tier} tier). Repay an existing loan first.`
        : `This loan would exceed your ${fmtSol(limits.maxOutstanding)} SOL outstanding limit (${limits.tier} tier). You can borrow up to ${fmtSol(available)} SOL more.`,
      tier: limits.tier,
      maxPerLoan: limits.maxPerLoan,
      maxOutstanding: limits.maxOutstanding,
      currentOutstanding: outstanding,
    };
  }

  return {
    allowed: true,
    tier: limits.tier,
    maxPerLoan: limits.maxPerLoan,
    maxOutstanding: limits.maxOutstanding,
    currentOutstanding: outstanding,
  };
}

/**
 * Get a user's current limits (for display in /me or /credit).
 */
export async function getLoanLimits(userId) {
  const limits = await getUserLimitTier(userId);
  const outstanding = await getOutstandingLamports(userId);
  const available = limits.maxOutstanding - outstanding;

  return {
    tier: limits.tier,
    maxPerLoan: limits.maxPerLoan,
    maxOutstanding: limits.maxOutstanding,
    currentOutstanding: outstanding,
    availableToBorrow: available > 0n ? available : 0n,
  };
}
