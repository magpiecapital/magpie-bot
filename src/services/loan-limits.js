import { query } from "../db/pool.js";

// ─── Loan limit tiers ───────────────────────────────────────────────────────
// All values in lamports (1 SOL = 1e9 lamports)
const SOL = 1_000_000_000n;

const LIMIT_TIERS = {
  new:     { maxPerLoan: 3n * SOL, maxOutstanding: 3n * SOL, minOnTimeRepays: 0 },
  trusted: { maxPerLoan: 5n * SOL, maxOutstanding: 10n * SOL, minOnTimeRepays: 3 },
};

/**
 * Determine which loan-limit tier a user qualifies for.
 */
async function getUserLimitTier(userId) {
  const { rows: [stats] } = await query(
    `SELECT COUNT(*) AS repaid_ontime
     FROM loans
     WHERE user_id = $1
       AND status = 'repaid'
       AND updated_at <= due_timestamp`,
    [userId],
  );

  const onTimeRepays = Number(stats?.repaid_ontime || 0);

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
