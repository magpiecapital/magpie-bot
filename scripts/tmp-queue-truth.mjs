import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const a = await c.query("SELECT symbol, source, category, auto_approved, liquidity_usd, screened_at FROM supported_mints WHERE enabled = true AND screened_at > NOW() - INTERVAL '24 hours' ORDER BY screened_at");
console.log("ENABLED last 24h:", a.rows.length);
for (const r of a.rows) console.log("  ", r.screened_at.toISOString().slice(5, 16), r.symbol, r.source || "", "liq=$"+Math.floor(r.liquidity_usd||0), r.auto_approved ? "fast" : "review");
const q = await c.query("SELECT status, COUNT(*)::int AS n FROM token_screen_queue GROUP BY status");
console.log("QUEUE:", JSON.stringify(q.rows));
try {
  const ann = await c.query("SELECT mint, last_enabled, updated_at FROM token_catalog_announce_state ORDER BY updated_at DESC LIMIT 12");
  console.log("ANNOUNCE recent:", ann.rows.map(r => `${r.mint.slice(0,6)}:${r.last_enabled}@${r.updated_at.toISOString().slice(5,16)}`).join(" "));
} catch (e) { console.log("ANNOUNCE err:", e.message); }
await c.end();
