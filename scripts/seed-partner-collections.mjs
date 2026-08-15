#!/usr/bin/env node
/**
 * Seed the DAS-verified partner collections for the tokenized-collectible
 * inventory indexer (addresses verified on-chain 2026-08-15: sized
 * collection counters + verified-collection flags + 4+ published sources).
 * Idempotent. Run: railway run node scripts/seed-partner-collections.mjs
 */
import pg from "pg";
const ROWS = [
  ["CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf", "Collector Crypt", "Token Metadata pNFT collection (~63k)"],
  ["CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac", "Collector Crypt", "MPL Core collection (~62k)"],
  ["phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC", "Phygitals", "MPL Core collection (~47k)"],
  ["BSG6DyEihFFtfvxtL9mKYsvTwiZXB1rq5gARMTJC2xAM", "Phygitals", "Token Metadata cNFT collection (~80k)"],
];
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(`CREATE TABLE IF NOT EXISTS collectible_partner_collections (
  collection_address TEXT PRIMARY KEY, platform TEXT NOT NULL, label TEXT,
  enabled BOOLEAN DEFAULT TRUE, added_at TIMESTAMPTZ DEFAULT NOW())`);
for (const [addr, platform, label] of ROWS) {
  await c.query(
    `INSERT INTO collectible_partner_collections (collection_address, platform, label)
     VALUES ($1, $2, $3) ON CONFLICT (collection_address) DO UPDATE SET platform = $2, label = $3, enabled = TRUE`,
    [addr, platform, label],
  );
}
const { rows } = await c.query(`SELECT platform, COUNT(*) FROM collectible_partner_collections WHERE enabled GROUP BY platform`);
console.log("seeded:", JSON.stringify(rows));
await c.end();
