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

export async function incrementBorrowed(userId, lamports) {
  await query(
    `UPDATE users
       SET total_borrowed_lamports = total_borrowed_lamports + $2::numeric,
           updated_at = NOW()
     WHERE id = $1`,
    [userId, String(lamports)],
  );
}

export async function incrementRepaid(userId) {
  await query(
    `UPDATE users SET repaid_count = repaid_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [userId],
  );
}

export async function incrementLiquidated(userId) {
  await query(
    `UPDATE users SET liquidated_count = liquidated_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [userId],
  );
}

export async function getUserStats(userId) {
  const { rows } = await query(
    `SELECT repaid_count, liquidated_count, total_borrowed_lamports
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0];
}
