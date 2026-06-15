/**
 * Read-only diagnostic: list every limit_close_orders row for a
 * wallet's loans, regardless of status. Used to debug "I armed a
 * ladder but the dashboard shows nothing" cases — distinguishes
 * arm-failure (no rows at all), wrong-loan (rows on a different
 * loan_id), and fire-already-happened (rows with status='fired').
 *
 * Usage:
 *   node scripts/inspect-limit-close-for-wallet.mjs <wallet>
 */
import { query } from "../src/db/pool.js";

const wallet = process.argv[2];
if (!wallet) {
  console.error("usage: node scripts/inspect-limit-close-for-wallet.mjs <wallet>");
  process.exit(1);
}

const u = await query(
  `SELECT u.id AS user_id, u.telegram_id
     FROM users u
     JOIN wallets w ON w.user_id = u.id
    WHERE w.public_key = $1`,
  [wallet],
);
if (u.rows.length === 0) {
  console.log("no user for wallet");
  process.exit(0);
}
const userId = u.rows[0].user_id;
console.log("user_id:", userId, "telegram_id:", u.rows[0].telegram_id);

const loans = await query(
  `SELECT id, loan_id, collateral_mint, status, borrower_wallet, start_timestamp
     FROM loans
    WHERE user_id = $1 AND borrower_wallet = $2
    ORDER BY id DESC
    LIMIT 30`,
  [userId, wallet],
);
console.log(`\nLOANS (${loans.rows.length}):`);
for (const l of loans.rows) {
  console.log(`  id=${l.id} chain=${l.loan_id} mint=${l.collateral_mint?.slice(0,8)} status=${l.status}`);
}

const loanIds = loans.rows.map((r) => r.id);
if (loanIds.length === 0) {
  console.log("no loans");
  process.exit(0);
}

const orders = await query(
  `SELECT id, loan_id, trigger_kind, trigger_value_micro::text AS val,
          trigger_direction, status, slice_pct, ladder_group_id,
          armed_at, fired_at, source,
          proceeds_lamports::text AS proceeds,
          tx_signature_swap, tx_signature_repay,
          failure_reason
     FROM limit_close_orders
    WHERE loan_id = ANY($1::bigint[])
    ORDER BY armed_at DESC NULLS LAST
    LIMIT 100`,
  [loanIds],
);

console.log(`\nORDERS (${orders.rows.length}):`);
for (const o of orders.rows) {
  console.log(
    `  id=${o.id} loan=${o.loan_id} dir=${o.trigger_direction} status=${o.status} kind=${o.trigger_kind} val=${o.val} slice=${o.slice_pct} group=${o.ladder_group_id ? o.ladder_group_id.slice(0,8) : '-'} src=${o.source} armed=${o.armed_at?.toISOString?.()} fired=${o.fired_at?.toISOString?.() || '-'} proceeds=${o.proceeds || '-'} swap=${o.tx_signature_swap?.slice(0,8) || '-'} fail=${o.failure_reason || '-'}`,
  );
}

process.exit(0);
