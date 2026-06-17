import "dotenv/config";
const { query } = await import("../src/db/pool.js");

const V2 = process.env.PROGRAM_ID_V2;
console.log("PROGRAM_ID_V2:", V2);

// 1. Loan counts by status
const byStatus = await query(
  `SELECT status, COUNT(*) AS n, COALESCE(SUM(original_loan_amount_lamports::numeric),0)::text AS lifetime_lamports
     FROM loans WHERE program_id = $1 GROUP BY status ORDER BY status`,
  [V2],
);
console.log("\n-- V2 loans by status --");
for (const r of byStatus.rows) console.log(" ", r.status, "count=" + r.n, "lifetime SOL borrowed=" + (Number(r.lifetime_lamports)/1e9).toFixed(4));

// 2. Active V2 loans detail (who, mint, owed, due)
const active = await query(
  `SELECT loan_id, loan_pda, borrower_wallet, collateral_mint, original_loan_amount_lamports::text AS owed, due_timestamp
     FROM loans WHERE program_id = $1 AND status = 'active' ORDER BY due_timestamp ASC`,
  [V2],
);
console.log("\n-- V2 active loans (" + active.rowCount + ") --");
for (const r of active.rows) {
  console.log("  loan_id=" + r.loan_id, "borrower=" + r.borrower_wallet.slice(0,8) + "..", "mint=" + r.collateral_mint.slice(0,8)+"..", "owed=" + (Number(r.owed)/1e9).toFixed(4)+" SOL", "due=" + r.due_timestamp?.toISOString?.()?.slice(0,10));
}

// 3. Any V2 limit-close orders or arm intents?
const orders = await query(
  `SELECT status, COUNT(*) AS n FROM limit_close_orders WHERE program_id = $1 GROUP BY status`,
  [V2],
).catch(err => ({ rows: [], err: err.message }));
console.log("\n-- V2 limit_close_orders --");
if (orders.err) console.log("  (table query err:", orders.err.slice(0,80) + ")");
else for (const r of orders.rows) console.log(" ", r.status, r.n);

// 4. V2 depositor positions (LPs)?
// Can't read on-chain accounts here without solana imports — flag for separate script.

process.exit(0);
