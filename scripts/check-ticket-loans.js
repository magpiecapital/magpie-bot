#!/usr/bin/env node
/**
 * Look up the on-chain/DB state of the specific loans referenced in
 * the open bug-report tickets, so we know what the truth is before
 * drafting any reply.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const LOANS_OF_INTEREST = [
  "1780563685430",  // #15 wowloco
  "1780588335817",  // #19 Deezwear
];

async function main() {
  for (const loanId of LOANS_OF_INTEREST) {
    console.log(`\n──── Loan #${loanId} ────`);
    const { rows } = await query(
      `SELECT * FROM loans WHERE id = $1`,
      [loanId],
    );
    if (!rows[0]) {
      console.log("  NOT FOUND in loans table");
      continue;
    }
    const l = rows[0];
    for (const k of Object.keys(l)) console.log(`  ${k}: ${l[k]}`);
  }

  console.log("\n──── /topup DB error context (V's ticket) ────");
  // Look for recent failed topup events / errors related to Vanbronckhorst
  const { rows: vRows } = await query(
    `SELECT id, telegram_username, telegram_id FROM users
      WHERE telegram_username = $1 OR telegram_id = $2`,
    ["Vanbronckhorst", 7249270258],
  );
  console.log("  user record:", vRows[0] || "not found");
  if (vRows[0]) {
    const { rows: loans } = await query(
      `SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [vRows[0].id],
    );
    console.log(`  recent loans:`);
    for (const l of loans) console.log("   ", JSON.stringify(l));
  }

  console.log("\n──── B_T_F_D (LP yield reporter) ────");
  const { rows: bRows } = await query(
    `SELECT id, telegram_username, telegram_id FROM users
      WHERE telegram_username = $1 OR telegram_id = $2`,
    ["B_T_F_D", 1563189181],
  );
  console.log("  user record:", bRows[0] || "not found");
  if (bRows[0]) {
    // LP positions live in lp_positions or similar — check what tables exist
    const { rows: lpExists } = await query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%lp%'`,
    );
    console.log("  LP-related tables:", lpExists.map(r => r.table_name).join(", "));
    for (const t of lpExists) {
      const { rows } = await query(
        `SELECT * FROM ${t.table_name} WHERE user_id = $1 LIMIT 3`,
        [bRows[0].id],
      ).catch((e) => ({ rows: [], err: e.message }));
      console.log(`  ${t.table_name}:`, JSON.stringify(rows));
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
