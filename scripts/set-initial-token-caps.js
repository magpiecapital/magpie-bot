#!/usr/bin/env node
/**
 * One-shot: set per-token open-loan cap overrides for known
 * high-quality / protocol tokens.
 *
 *   $MAGPIE   → unlimited (0)         protocol's own token
 *   $FARTCOIN → 100 SOL               ~$120m mcap, deep pool
 *
 * Operator can manage live via /set_token_cap. This is just the
 * initial seed for the launch of the per-token cap system.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const SEEDS = [
  { mint: "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump", symbol: "MAGPIE", cap_sol: "unlimited" },
  { mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", symbol: "FARTCOIN", cap_sol: 100 },
];

for (const s of SEEDS) {
  let val;
  if (s.cap_sol === "unlimited") val = "0";
  else val = String(Math.floor(s.cap_sol * 1e9));
  const { rowCount } = await query(
    `UPDATE supported_mints SET max_open_lamports = $2 WHERE mint = $1`,
    [s.mint, val],
  );
  if (rowCount) {
    console.log(`✓ ${s.symbol} (${s.mint.slice(0, 8)}…) → ${s.cap_sol}${s.cap_sol === "unlimited" ? "" : " SOL"}`);
  } else {
    console.log(`⚠ ${s.symbol} (${s.mint.slice(0, 8)}…) — no supported_mints row, skipping`);
  }
}
process.exit(0);
