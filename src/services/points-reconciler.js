/**
 * points-reconciler.js — periodic self-heal for the points ledger.
 * ─────────────────────────────────────────────────────────────────────────
 * The live forward-sync (loans.js recordLoan/markLoanRepaid) credits points
 * INLINE the same turn a borrow/repay lands. This reconciler is the backstop
 * the points mandate requires: if the bot crashed mid-tx (or was down during a
 * borrow), the inline credit could be missed. Re-running the fully-idempotent
 * backfill — every credit goes through creditPoints' ON CONFLICT(source_type,
 * source_id) DO NOTHING — self-heals any gap with zero double-credit.
 *
 * It also clears the historical backlog: every loan opened between the
 * 2026-06-27 manual backfill and the forward-sync deploy (audit 2026-06-28 P0/
 * P1) gets credited on the first run after deploy.
 *
 * Read-only on loan/collateral/vault state; writes ONLY points_events +
 * user_points_balance. Best-effort — a failed run never affects loans.
 */
import { backfillPoints } from "./points-backfill.js";

const INTERVAL_MS = Number(process.env.POINTS_RECONCILE_INTERVAL_MS) || 2 * 60 * 60_000; // 2h
const FIRST_RUN_DELAY_MS = Number(process.env.POINTS_RECONCILE_FIRST_DELAY_MS) || 90_000; // 90s after boot

async function run() {
  try {
    const s = await backfillPoints({ log: () => {} });
    // Only log when it actually healed something — quiet at steady state.
    if (s.borrowN || s.firstN || s.repayN) {
      console.log(
        `[points-reconciler] healed ${s.borrowN} borrow + ${s.firstN} first-loan + ${s.repayN} repay point-event(s) (of ${s.loans} loans)`,
      );
    }
  } catch (e) {
    console.warn("[points-reconciler] run failed:", e.message?.slice(0, 140));
  }
}

export function startPointsReconciler() {
  setTimeout(run, FIRST_RUN_DELAY_MS);
  setInterval(run, INTERVAL_MS);
  console.log(
    `[points-reconciler] armed — first run in ${Math.round(FIRST_RUN_DELAY_MS / 1000)}s, then every ${Math.round(INTERVAL_MS / 60_000)} min`,
  );
}
