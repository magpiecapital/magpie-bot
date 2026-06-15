import { query } from "../src/db/pool.js";
const wallet = process.argv[2];
if (!wallet) { console.error("usage: node scripts/recent-arm-attempts.mjs <wallet>"); process.exit(1); }
const u = await query(`SELECT u.id FROM users u JOIN wallets w ON w.user_id=u.id WHERE w.public_key=$1`, [wallet]);
if (!u.rows.length) { console.log("no user"); process.exit(0); }
const r = await query(
  `SELECT id, loan_id_chain, direction, target_kind, target_value_micro::text AS val,
          slice_pct, outcome, error_code, error_detail, source, created_at
     FROM limit_close_arm_attempts
    WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [u.rows[0].id]);
console.log(`attempts: ${r.rows.length}`);
for (const a of r.rows) console.log(JSON.stringify(a, null, 1));
process.exit(0);
