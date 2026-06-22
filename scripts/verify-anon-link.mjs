import "dotenv/config";
const { query } = await import("../src/db/pool.js");
// Try the EXACT insert pattern from wallet-owner-resolver.js
try {
  await query("BEGIN");
  const r = await query(`INSERT INTO users (telegram_id, created_at) VALUES (NULL, NOW()) RETURNING id`);
  console.log("INSERT OK, id:", r.rows[0].id);
  await query("ROLLBACK");
} catch (err) {
  console.log("INSERT FAILED:", err.message.slice(0, 200));
  await query("ROLLBACK");
}
// Also check what the actual telegram_id constraint says
const { rows } = await query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='users' AND column_name='telegram_id'`);
console.log("schema:", rows);
process.exit(0);
