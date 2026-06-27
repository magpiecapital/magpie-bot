/**
 * points-backfill.js — one-shot, fully idempotent retroactive points.
 * ─────────────────────────────────────────────────────────────────────────
 * Re-runnable any number of times with ZERO double-credit: every credit goes
 * through creditPoints()'s ON CONFLICT (source_type, source_id) DO NOTHING. The
 * source_ids are computed deterministically so this backfill and the live
 * forward-sync produce IDENTICAL ids (no drift, no duplicates).
 *
 * Covers BORROW (every loan), FIRST_LOAN (+500, once per user), and REPAY
 * bonuses (early +25% / on-time +10% of the loan's base). Streak + diversity
 * bonuses are layered in by the reconciler/forward-sync. Reads only; never
 * touches loan/collateral state.
 *
 * Run standalone: `railway run node src/services/points-backfill.js`
 */
import { query } from "../db/pool.js";
import { ensurePointsTables, creditPoints, borrowPoints, repayBonusPoints, FIRST_LOAN_BONUS } from "./points.js";

export async function backfillPoints({ log = console.log } = {}) {
  await ensurePointsTables();
  let borrowN = 0, firstN = 0, repayN = 0;

  // (1) BORROW — every loan ever opened earns base borrow points.
  const loans = await query(
    `SELECT user_id, loan_pda, loan_amount_lamports, duration_days
       FROM loans ORDER BY start_timestamp ASC`,
  );
  for (const l of loans.rows) {
    const pts = borrowPoints({ loanLamports: l.loan_amount_lamports, durationDays: l.duration_days });
    const res = await creditPoints({
      userId: l.user_id,
      sourceType: "borrow",
      sourceId: `borrow:${l.loan_pda}`,
      category: "lending",
      points: pts,
      metadata: { loan_pda: l.loan_pda, duration_days: l.duration_days },
    });
    if (res !== null) borrowN++;
  }

  // (2) FIRST_LOAN — +500, once per user, attributed to their earliest loan.
  const firsts = await query(
    `SELECT DISTINCT ON (user_id) user_id, loan_pda
       FROM loans ORDER BY user_id, start_timestamp ASC`,
  );
  for (const f of firsts.rows) {
    const res = await creditPoints({
      userId: f.user_id,
      sourceType: "first_loan",
      sourceId: `first_loan:${f.user_id}`,
      category: "bonus",
      points: FIRST_LOAN_BONUS,
      metadata: { loan_pda: f.loan_pda },
    });
    if (res !== null) firstN++;
  }

  // (3) REPAY — early/on-time bonus as a fraction of the loan's base, one per
  // repaid loan, variant taken from credit_events (early beats on-time).
  const repays = await query(
    `SELECT l.user_id, l.loan_pda, l.loan_amount_lamports, l.duration_days,
            CASE WHEN bool_or(ce.event_type = 'repay_early')  THEN 'repay_early'
                 WHEN bool_or(ce.event_type = 'repay_ontime') THEN 'repay_ontime'
                 ELSE NULL END AS variant
       FROM loans l
       JOIN credit_events ce
         ON ce.loan_id = l.id
        AND ce.event_type IN ('repay_early','repay_ontime','repay_late')
      WHERE l.status = 'repaid'
      GROUP BY l.user_id, l.loan_pda, l.loan_amount_lamports, l.duration_days`,
  );
  for (const r of repays.rows) {
    if (!r.variant) continue;
    const base = borrowPoints({ loanLamports: r.loan_amount_lamports, durationDays: r.duration_days });
    const bonus = repayBonusPoints(base, r.variant);
    const res = await creditPoints({
      userId: r.user_id,
      sourceType: "repay",
      sourceId: `repay:${r.loan_pda}`,
      category: "repayment",
      points: bonus,
      metadata: { loan_pda: r.loan_pda, variant: r.variant },
    });
    if (res !== null) repayN++;
  }

  const summary = { loans: loans.rows.length, borrowN, firstN, repayN };
  log(`[points-backfill] credited ${borrowN} borrow + ${firstN} first-loan + ${repayN} repay events (of ${loans.rows.length} loans)`);
  return summary;
}

// Run directly via `node src/services/points-backfill.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  backfillPoints()
    .then((r) => { console.log("backfill done:", JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error("backfill failed:", e); process.exit(1); });
}
