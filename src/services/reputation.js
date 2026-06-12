/**
 * Reputation tier calculation and counter updates.
 *
 * Tiers are derived from (repaid_count, liquidated_count) — no separate
 * `tier` column — so the same function can be used anywhere we have a user.
 *
 * Tiers:
 *   NEW      — the default; 0-2 successful repayments
 *   SILVER   — 3+ repayments AND liquidation rate < 15%
 *   GOLD     — 10+ repayments AND liquidation rate < 7%
 *   PLATINUM — 25+ repayments AND liquidation rate < 3%
 */
import { query } from "../db/pool.js";
import { recordCreditEvent } from "./credit-score.js";

export const TIERS = {
  NEW:      { label: "NEW",      emoji: "🆕", min: 0 },
  SILVER:   { label: "SILVER",   emoji: "🥈", min: 3,  maxLiqRate: 0.15 },
  GOLD:     { label: "GOLD",     emoji: "🥇", min: 10, maxLiqRate: 0.07 },
  PLATINUM: { label: "PLATINUM", emoji: "💎", min: 25, maxLiqRate: 0.03 },
};

export function tierFor({ repaid_count, liquidated_count }) {
  const total = Number(repaid_count) + Number(liquidated_count);
  const rate = total > 0 ? Number(liquidated_count) / total : 0;

  if (repaid_count >= TIERS.PLATINUM.min && rate < TIERS.PLATINUM.maxLiqRate) {
    return TIERS.PLATINUM;
  }
  if (repaid_count >= TIERS.GOLD.min && rate < TIERS.GOLD.maxLiqRate) {
    return TIERS.GOLD;
  }
  if (repaid_count >= TIERS.SILVER.min && rate < TIERS.SILVER.maxLiqRate) {
    return TIERS.SILVER;
  }
  return TIERS.NEW;
}

export function nextTierHint({ repaid_count, liquidated_count }) {
  const current = tierFor({ repaid_count, liquidated_count });
  if (current === TIERS.PLATINUM) return null;
  const next =
    current === TIERS.NEW ? TIERS.SILVER :
    current === TIERS.SILVER ? TIERS.GOLD :
    TIERS.PLATINUM;
  const need = Math.max(0, next.min - repaid_count);
  return { next, repaysNeeded: need };
}

/**
 * @deprecated The total_borrowed_lamports bump + the borrow credit event
 * are now emitted from loans.recordLoan() so that BOTH the TG path and
 * the site path get a single, consistent set of side effects. This
 * function is now a NO-OP — left as an exported symbol so existing TG
 * callers don't crash mid-deploy. Remove next major.
 *
 * Removing the body avoids double-counting (recordLoan now does the work)
 * AND removes the silent divergence where site-native users were missing
 * borrow credit events entirely. See loans.recordLoan().
 */
export async function incrementBorrowed(_userId, _lamports, _loanDbId = null) {
  // Intentional no-op. See JSDoc above.
}

export async function incrementRepaid(userId) {
  await query(
    `UPDATE users SET repaid_count = repaid_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [userId],
  );
  // Credit event is recorded by markLoanRepaid in loans.js (authoritative
  // path — it has the due_timestamp to classify early/ontime/late and
  // links the event to loan_id). Recording here too produced duplicates.
}

export async function incrementLiquidated(userId, loanDbId = null) {
  await query(
    `UPDATE users SET liquidated_count = liquidated_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [userId],
  );
  try {
    await recordCreditEvent(userId, "liquidated", loanDbId);
  } catch (err) {
    console.error("[reputation] credit event error:", err.message);
  }
}

export async function getUserStats(userId) {
  const { rows } = await query(
    `SELECT repaid_count, liquidated_count, total_borrowed_lamports
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0];
}
