/**
 * overdue-loan-sentinel.js — surfaces overdue loans that were NOT liquidated.
 * ─────────────────────────────────────────────────────────────────────────
 * The product promises "past due → keeper auto-liquidates," but the keeper is a
 * SEPARATE, operator-gated service (it signs irreversible on-chain collateral
 * seizures with the lender keypair). If it isn't running, a real default would
 * sit PAST DUE with no alert — the lender silently fails to recover collateral.
 * Verification 2026-06-28 found 6 overdue loans, all dust, but a real default
 * must never be silent.
 *
 * This sentinel does NOT liquidate anything (seizure stays the operator's
 * explicit, manual decision — `railway run node src/services/keeper.js`). It is
 * READ-ONLY on loans: it scans for NON-DUST loans that are past due + still
 * active, and DMs the operator so they can decide to liquidate. Dust loans
 * (owed below the floor — uneconomic to liquidate, gas > recovery) are ignored
 * so the alert is signal, not noise.
 *
 * Throttled in-memory per loan; a redeploy re-surfaces an unhandled default,
 * which is desirable (keep reminding until it's resolved). Zero writes to
 * loan/collateral state.
 */
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";
import { markCycle } from "../lib/heartbeat.js";

const POLL_MS = Number(process.env.OVERDUE_SENTINEL_POLL_MS) || 30 * 60_000; // 30 min
const FIRST_DELAY_MS = Number(process.env.OVERDUE_SENTINEL_FIRST_DELAY_MS) || 60_000;
const GRACE_HOURS = Number(process.env.OVERDUE_SENTINEL_GRACE_HOURS) || 1; // alert after due + grace
// Dust floor: loans whose OWED principal is below this are uneconomic to
// liquidate (gas can exceed recovery), so they don't warrant an alert.
const DUST_LAMPORTS = BigInt(Math.floor(Number(process.env.OVERDUE_SENTINEL_DUST_SOL || 0.05) * 1e9));
const REALERT_MS = Number(process.env.OVERDUE_SENTINEL_REALERT_MS) || 6 * 60 * 60_000; // re-remind every 6h

const _alerted = new Map(); // loan db id -> last alerted ts

async function tick() {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT id, loan_id, loan_amount_lamports::text AS owed, program_id, borrower_wallet,
              ROUND(EXTRACT(EPOCH FROM (NOW() - due_timestamp)) / 3600, 1) AS hrs_overdue
         FROM loans
        WHERE status = 'active'
          AND due_timestamp < NOW() - ($1 || ' hours')::interval
          AND loan_amount_lamports >= $2
        ORDER BY due_timestamp ASC`,
      [String(GRACE_HOURS), DUST_LAMPORTS.toString()],
    ));
  } catch (e) {
    console.warn("[overdue-sentinel] scan failed:", e.message?.slice(0, 120));
    return;
  }

  const now = Date.now();
  let alerted = 0;
  for (const l of rows) {
    if (now - (_alerted.get(l.id) || 0) < REALERT_MS) continue;
    _alerted.set(l.id, now);
    alerted++;
    const sol = (Number(l.owed) / 1e9).toFixed(3);
    try {
      await notifyAdmin(
        `⚠️ OVERDUE LOAN not liquidated — loan ${l.id} (chain ${l.loan_id}): ${sol} SOL owed, ` +
          `${l.hrs_overdue}h past due, program ${(l.program_id || "?").slice(0, 6)}, ` +
          `borrower ${(l.borrower_wallet || "?").slice(0, 6)}. The keeper has NOT seized it.\n\n` +
          `This is your call (liquidation is an irreversible on-chain seizure). To liquidate: ` +
          `\`railway run node src/services/keeper.js\` — or confirm the keeper service is running.`,
      );
    } catch (e) {
      console.warn(`[overdue-sentinel] DM failed for loan ${l.id}:`, e.message?.slice(0, 80));
    }
  }
  if (alerted > 0) console.log(`[overdue-sentinel] alerted on ${alerted} non-dust overdue loan(s)`);
  markCycle("overdue-loan-sentinel");
}

export function startOverdueLoanSentinel() {
  setTimeout(() => tick().catch((e) => console.warn("[overdue-sentinel] tick:", e.message?.slice(0, 80))), FIRST_DELAY_MS);
  setInterval(() => tick().catch((e) => console.warn("[overdue-sentinel] tick:", e.message?.slice(0, 80))), POLL_MS);
  console.log(
    `[overdue-sentinel] armed — non-dust (≥${Number(DUST_LAMPORTS) / 1e9} SOL) overdue loans alerted every ${Math.round(POLL_MS / 60_000)}min; liquidation stays operator-gated`,
  );
}
