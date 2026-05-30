/**
 * One-shot: backfill credit_events for loans that were repaid before the
 * markLoanRepaid() → recordCreditEvent() fix landed. Idempotent — skips
 * any loan that already has a repay_* event recorded.
 *
 * Usage: railway run --service=magpie-bot node scripts/backfill-repay-credit.js
 */
import { query } from "../src/db/pool.js";
import { recordCreditEvent } from "../src/services/credit-score.js";

const SQL = `
  SELECT l.id, l.user_id, l.due_timestamp, l.updated_at, sm.symbol
    FROM loans l
    LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
    LEFT JOIN credit_events ce
      ON ce.loan_id = l.id
     AND ce.event_type IN ('repay_ontime', 'repay_early', 'repay_late')
   WHERE l.status = 'repaid'
     AND ce.id IS NULL
   ORDER BY l.updated_at DESC
`;

async function main() {
  const { rows } = await query(SQL);
  console.log(`Repaid loans missing credit event: ${rows.length}`);

  for (const r of rows) {
    const repaidAt = new Date(r.updated_at).getTime();
    const dueAt = new Date(r.due_timestamp).getTime();
    const eventType =
      repaidAt > dueAt ? "repay_late"
      : (dueAt - repaidAt) > 24 * 60 * 60 * 1000 ? "repay_early"
      : "repay_ontime";
    try {
      await recordCreditEvent(r.user_id, eventType, r.id);
      console.log(`  ✓ loan ${r.id} (${r.symbol ?? "?"}) → ${eventType}`);
    } catch (err) {
      console.error(`  ✗ loan ${r.id}: ${err.message}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
