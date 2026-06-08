/**
 * Magpie Credit Score Engine
 *
 * Composable credit primitive: computes a 300-850 credit score from six
 * weighted factors. Designed for on-chain publication and cross-protocol
 * integration.
 *
 * Factors (weights):
 *   1. Repayment History  (35%) — on-time vs late vs liquidated
 *   2. Loan Volume        (20%) — total SOL borrowed lifetime
 *   3. Account Age        (15%) — time since first interaction
 *   4. Collateral Diversity (15%) — unique collateral mints used
 *   5. Liquidation Ratio  (10%) — liquidation rate
 *   6. Protocol Engagement (5%) — referrals, features used, activity
 *
 * Score range: 300 (min) – 850 (max)
 * Tier mapping (feeRate = minimum fee for Standard tier at this credit level):
 *   Bronze:   300-499 → 30% max LTV, 1.5–3% fee (tier-dependent), 7 day max
 *   Silver:   500-649 → 32% max LTV, 1.5–3% fee (tier-dependent), 7 day max
 *   Gold:     650-749 → 35% max LTV, 1.25–2.75% fee, 14 day max
 *   Platinum: 750-850 → 38% max LTV, 1.0–2.5% fee, 30 day max
 *
 * Loan tier base fees: Express 3%, Quick 2%, Standard 1.5%
 * Credit score can reduce these (Gold ~17% off, Platinum ~33% off)
 */
import { query } from "../db/pool.js";

// ─── Tier definitions ───────────────────────────────────────────────────────
const TIER_DEFS = {
  bronze:   { min: 300, max: 499, maxLtv: 30, feeRate: 0.015, maxDays: 7  },
  silver:   { min: 500, max: 649, maxLtv: 32, feeRate: 0.015, maxDays: 7  },
  gold:     { min: 650, max: 749, maxLtv: 35, feeRate: 0.0125, maxDays: 14 },
  platinum: { min: 750, max: 850, maxLtv: 38, feeRate: 0.01, maxDays: 30 },
};

export function tierFromScore(score) {
  if (score >= 750) return "platinum";
  if (score >= 650) return "gold";
  if (score >= 500) return "silver";
  return "bronze";
}

export function tierBenefits(tier) {
  return TIER_DEFS[tier] || TIER_DEFS.bronze;
}

// ─── Factor computation ─────────────────────────────────────────────────────

/**
 * Compute all six factor scores (0-100) for a user.
 */
async function computeFactors(userId) {
  // Fetch user base data
  const { rows: [user] } = await query(
    `SELECT u.id, u.repaid_count, u.liquidated_count, u.total_borrowed_lamports,
            u.created_at, u.referred_by,
            (SELECT COUNT(DISTINCT referred_by) FROM users WHERE referred_by = u.id) AS referral_count
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!user) return null;

  // Loan history details
  const { rows: loans } = await query(
    `SELECT id, status, collateral_mint, duration_days, ltv_percentage,
            start_timestamp, due_timestamp, loan_amount_lamports,
            original_loan_amount_lamports, created_at, updated_at
     FROM loans WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  // Credit events
  const { rows: events } = await query(
    `SELECT event_type, COUNT(*) as cnt FROM credit_events
     WHERE user_id = $1 GROUP BY event_type`,
    [userId],
  );
  const eventCounts = Object.fromEntries(events.map(e => [e.event_type, Number(e.cnt)]));

  // Preferences
  const { rows: [prefs] } = await query(
    `SELECT auto_repay, notify_health FROM user_prefs WHERE user_id = $1`,
    [userId],
  );

  const totalLoans = loans.length;
  const repaid = Number(user.repaid_count);
  const liquidated = Number(user.liquidated_count);
  const totalBorrowed = Number(user.total_borrowed_lamports || 0);
  const accountAgeDays = Math.floor(
    (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24),
  );
  const uniqueMints = new Set(loans.map(l => l.collateral_mint)).size;

  // ── Factor 1: Repayment History (35%) ──
  // Perfect on-time repayments = 100, each late or liquidated reduces score
  let f1 = 0;
  if (totalLoans === 0) {
    f1 = 30; // new users get baseline
  } else {
    const onTimeRepays = (eventCounts.repay_ontime || 0) + (eventCounts.repay_early || 0);
    const lateRepays = eventCounts.repay_late || 0;
    const earlyRepays = eventCounts.repay_early || 0;
    const extensions = eventCounts.extend || 0;

    // Base: % of loans repaid successfully
    const repayRate = repaid / Math.max(totalLoans, 1);
    f1 = repayRate * 70; // up to 70 from repay rate

    // Bonus for early repayments
    f1 += Math.min(earlyRepays * 3, 15);

    // Bonus for partial repays (shows proactive behavior)
    f1 += Math.min((eventCounts.partial_repay || 0) * 2, 10);

    // Penalty for late repays
    f1 -= lateRepays * 5;

    // Mild penalty for extensions (not terrible but not great)
    f1 -= extensions * 1;

    // Heavy penalty for liquidations
    f1 -= liquidated * 15;

    f1 = Math.max(0, Math.min(100, f1));
  }

  // ── Factor 2: Loan Volume (20%) ──
  // More borrowing = more trust established, logarithmic scale
  let f2 = 0;
  if (totalBorrowed > 0) {
    const solBorrowed = totalBorrowed / 1e9;
    // 0.1 SOL = ~20, 1 SOL = ~40, 10 SOL = ~60, 100 SOL = ~80, 1000 SOL = 100
    f2 = Math.min(100, Math.log10(solBorrowed + 1) * 33.3);
  }

  // ── Factor 3: Account Age (15%) ──
  // Longer account = more trustworthy, diminishing returns
  // 7 days = ~30, 30 days = ~50, 90 days = ~70, 365 days = ~90, 730+ = 100
  let f3 = 0;
  if (accountAgeDays > 0) {
    f3 = Math.min(100, Math.sqrt(accountAgeDays / 730) * 100);
  }

  // ── Factor 4: Collateral Diversity (15%) ──
  // Using diverse tokens shows market understanding
  // 1 = 25, 2 = 45, 3 = 60, 5 = 75, 8+ = 100
  let f4 = 0;
  if (uniqueMints > 0) {
    f4 = Math.min(100, Math.sqrt(uniqueMints / 8) * 100);
  }

  // ── Factor 5: Liquidation Ratio (10%) ──
  // Lower liquidation rate = higher score (inverted)
  let f5 = 100; // perfect if no liquidations
  if (totalLoans > 0) {
    const liqRate = liquidated / totalLoans;
    f5 = Math.max(0, 100 - (liqRate * 200)); // 50% liq rate = 0 score
  }

  // ── Factor 6: Protocol Engagement (5%) ──
  // Referrals, notifications enabled, auto-repay, top-ups, etc.
  let f6 = 0;
  const referrals = Number(user.referral_count || 0);
  f6 += Math.min(referrals * 10, 30);
  f6 += (eventCounts.topup || 0) > 0 ? 15 : 0;
  if (prefs?.auto_repay) f6 += 15;
  if (prefs?.notify_health) f6 += 10;
  if (totalLoans >= 3) f6 += 15; // returning user
  if (eventCounts.collateral_diversity) f6 += 15;
  f6 = Math.min(100, f6);

  return {
    f_repayment_history: Math.round(f1 * 100) / 100,
    f_loan_volume: Math.round(f2 * 100) / 100,
    f_account_age: Math.round(f3 * 100) / 100,
    f_collateral_diversity: Math.round(f4 * 100) / 100,
    f_liquidation_ratio: Math.round(f5 * 100) / 100,
    f_protocol_engagement: Math.round(f6 * 100) / 100,
  };
}

/**
 * Compute the final weighted score from factors.
 */
function weightedScore(factors) {
  const raw =
    factors.f_repayment_history * 0.35 +
    factors.f_loan_volume * 0.20 +
    factors.f_account_age * 0.15 +
    factors.f_collateral_diversity * 0.15 +
    factors.f_liquidation_ratio * 0.10 +
    factors.f_protocol_engagement * 0.05;

  // Map 0-100 raw score to 300-850 range
  return Math.round(300 + (raw / 100) * 550);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a credit event and recompute the user's score.
 */
export async function recordCreditEvent(userId, eventType, loanId = null, metadata = {}) {
  const deltas = {
    repay_ontime: 15,
    repay_early: 20,
    repay_late: -10,
    partial_repay: 5,
    extend: -2,
    topup: 8,
    liquidated: -40,
    borrow: 3,
    collateral_diversity: 5,
  };

  const delta = deltas[eventType] || 0;

  const { rows: [event] } = await query(
    `INSERT INTO credit_events (user_id, loan_id, event_type, score_delta, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, loanId, eventType, delta, JSON.stringify(metadata)],
  );

  // Recompute score
  await recomputeScore(userId, event.id);

  return event.id;
}

/**
 * Full score recomputation for a user.
 */
export async function recomputeScore(userId, eventId = null) {
  const factors = await computeFactors(userId);
  if (!factors) return null;

  const score = weightedScore(factors);
  const tier = tierFromScore(score);
  const benefits = tierBenefits(tier);

  // Count scored loans
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*) FROM loans WHERE user_id = $1`,
    [userId],
  );

  await query(
    `INSERT INTO credit_scores (
       user_id, score, tier,
       f_repayment_history, f_loan_volume, f_account_age,
       f_collateral_diversity, f_liquidation_ratio, f_protocol_engagement,
       max_ltv, fee_rate, max_duration_days,
       loans_scored, last_event_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       score=$2, tier=$3,
       f_repayment_history=$4, f_loan_volume=$5, f_account_age=$6,
       f_collateral_diversity=$7, f_liquidation_ratio=$8, f_protocol_engagement=$9,
       max_ltv=$10, fee_rate=$11, max_duration_days=$12,
       loans_scored=$13, last_event_id=$14, updated_at=NOW()`,
    [
      userId, score, tier,
      factors.f_repayment_history, factors.f_loan_volume, factors.f_account_age,
      factors.f_collateral_diversity, factors.f_liquidation_ratio, factors.f_protocol_engagement,
      benefits.maxLtv, benefits.feeRate, benefits.maxDays,
      Number(count), eventId,
    ],
  );

  // Save snapshot
  await query(
    `INSERT INTO credit_score_history (user_id, score, tier, event_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, score, tier, eventId],
  );

  return { score, tier, factors, benefits };
}

/**
 * Get a user's current credit score (or compute if missing).
 */
export async function getCreditScore(userId) {
  const { rows: [existing] } = await query(
    `SELECT * FROM credit_scores WHERE user_id = $1`,
    [userId],
  );
  if (existing) return existing;

  // First-time computation
  return recomputeScore(userId);
}

/**
 * Get score history for a user (for trend charts).
 */
export async function getScoreHistory(userId, limit = 30) {
  const { rows } = await query(
    `SELECT score, tier, snapshot_at FROM credit_score_history
     WHERE user_id = $1 ORDER BY snapshot_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Get top credit scores (leaderboard).
 */
export async function getLeaderboard(limit = 20) {
  // Resolve the user's currently-active wallet pubkey (preferred) or
  // any wallet they have. The leaderboard handler uses this in place
  // of telegram_username for public display — keeps competitive
  // recognition without leaking TG identities.
  const { rows } = await query(
    `SELECT cs.user_id, cs.score, cs.tier, cs.loans_scored,
            COALESCE(
              (SELECT w.public_key FROM wallets w
                 WHERE w.user_id = cs.user_id AND w.is_active = TRUE
                 ORDER BY w.created_at ASC LIMIT 1),
              (SELECT w.public_key FROM wallets w
                 WHERE w.user_id = cs.user_id
                 ORDER BY w.created_at ASC LIMIT 1)
            ) AS public_key
     FROM credit_scores cs
     ORDER BY cs.score DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Determine the effective LTV and fee for a borrower based on their credit score
 * and the token's risk profile.
 */
export async function getEffectiveLoanTerms(userId, mint) {
  const creditScore = await getCreditScore(userId);
  const score = creditScore?.score || 300;
  const tier = tierFromScore(score);
  const benefits = tierBenefits(tier);

  // Check if risk engine has an LTV modifier for this token
  const { rows: [riskProfile] } = await query(
    `SELECT ltv_modifier, max_allowed_ltv, flagged FROM token_risk_profiles WHERE mint = $1`,
    [mint],
  );

  let effectiveMaxLtv = benefits.maxLtv;
  let effectiveFee = benefits.feeRate;

  if (riskProfile) {
    // Apply token risk modifier (can reduce LTV for risky tokens)
    effectiveMaxLtv = Math.min(
      effectiveMaxLtv + (Number(riskProfile.ltv_modifier) || 0),
      Number(riskProfile.max_allowed_ltv) || 30,
    );

    // If token is flagged, restrict heavily
    if (riskProfile.flagged) {
      effectiveMaxLtv = Math.min(effectiveMaxLtv, 15);
      effectiveFee = Math.max(effectiveFee, 0.025); // minimum 2.5% fee for flagged
    }
  }

  return {
    score,
    tier,
    maxLtv: effectiveMaxLtv,
    feeRate: effectiveFee,
    maxDurationDays: benefits.maxDays,
    tokenFlagged: riskProfile?.flagged || false,
  };
}

/**
 * External protocol API: query a user's credit score by Solana wallet address.
 * Used by the composable credit primitive API endpoint.
 */
export async function getScoreByWallet(walletAddress) {
  const { rows: [wallet] } = await query(
    `SELECT w.user_id FROM wallets w WHERE w.public_key = $1`,
    [walletAddress],
  );
  if (!wallet) return null;
  return getCreditScore(wallet.user_id);
}
