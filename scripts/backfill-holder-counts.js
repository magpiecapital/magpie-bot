#!/usr/bin/env node
/**
 * Backfill holder_count on enabled supported_mints rows where it's
 * currently 0 (the most common stale state — older approvals stored 0
 * because the lookup failed at approval time, and the tier system
 * needs an accurate count to classify a token above "small").
 *
 * Uses Helius v0 token-metadata.holderCount, same source the screener
 * uses in src/services/token-screener.js getHolderCount(). Rate-limits
 * itself to ~3 RPS to stay friendly with Helius.
 *
 * Idempotent. Safe to run repeatedly. Updates `screened_at` alongside
 * so we know when the row was last refreshed.
 *
 * Flags:
 *   --dry-run     report what would change, don't write
 *   --all         re-check ALL enabled mints, not just rows where count=0
 *   --mint=<MINT> single-mint mode (forces re-check even if count > 0)
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const all = args.has("--all");
const mintArg = [...args].find((a) => a.startsWith("--mint="))?.slice(7);

const rpcUrl = process.env.SOLANA_RPC_URL || "";
const heliusKey =
  process.env.HELIUS_API_KEY ||
  rpcUrl.match(/[?&]api-key=([a-f0-9-]+)/i)?.[1] ||
  null;

if (!heliusKey) {
  console.error("✗ HELIUS_API_KEY (or api-key in SOLANA_RPC_URL) is required");
  process.exit(1);
}

async function fetchHolderCount(mint) {
  // Helius DAS getTokenAccounts paginates token-account owners. We
  // walk pages of 1000 until we either run out OR pass a sanity cap
  // so a single bad mint can't burn the whole run. Returns the
  // distinct-owner count, which is what "holders" actually means
  // (token accounts with balance > 0). The legacy v0/token-metadata
  // path stopped populating holderCount for most mints, which is why
  // we paginate instead of asking for the field.
  const HARD_PAGE_CAP = 200; // 200 * 1000 = 200k owners — far above
                              // anything we'd realistically need to
                              // classify into tiers; tokens beyond
                              // this are blue-chip without question.
  try {
    const owners = new Set();
    let page = 1;
    for (let i = 0; i < HARD_PAGE_CAP; i += 1) {
      const res = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `backfill-${page}`,
            method: "getTokenAccounts",
            params: { mint, limit: 1000, page },
          }),
        },
      );
      if (!res.ok) return { count: null, err: `HTTP ${res.status} at page ${page}` };
      const data = await res.json();
      if (data.error) return { count: null, err: data.error.message || String(data.error) };
      const accs = data.result?.token_accounts ?? [];
      if (accs.length === 0) break;
      for (const a of accs) {
        // Owner is the wallet holding the token. Counting distinct
        // owners avoids double-counting wallets with multiple ATAs
        // (rare but possible — e.g., legacy + Token-2022).
        if (a.owner && Number(a.amount || 0) > 0) owners.add(a.owner);
      }
      if (accs.length < 1000) break;
      page += 1;
      // 4 RPS — Helius DAS handles this comfortably and large tokens
      // need many pages.
      await new Promise((res) => setTimeout(res, 250));
    }
    return { count: owners.size, err: null };
  } catch (e) {
    return { count: null, err: e.message };
  }
}

const sql = mintArg
  ? `SELECT mint, symbol, holder_count FROM supported_mints WHERE mint = $1`
  : all
    ? `SELECT mint, symbol, holder_count FROM supported_mints WHERE enabled = TRUE ORDER BY screened_at NULLS FIRST`
    : `SELECT mint, symbol, holder_count FROM supported_mints WHERE enabled = TRUE AND COALESCE(holder_count, 0) = 0 ORDER BY symbol`;

const { rows } = mintArg ? await query(sql, [mintArg]) : await query(sql);

if (rows.length === 0) {
  console.log("Nothing to backfill — no rows match the filter.");
  process.exit(0);
}

console.log(`${dryRun ? "[DRY RUN] " : ""}Backfilling ${rows.length} mint${rows.length === 1 ? "" : "s"}…\n`);

let updated = 0;
let skipped = 0;
let failed = 0;

for (const r of rows) {
  const { count, err } = await fetchHolderCount(r.mint);
  if (count === null) {
    console.log(`✗ ${r.symbol.padEnd(10)} ${r.mint.slice(0, 8)}… — lookup failed: ${err}`);
    failed += 1;
    await new Promise((res) => setTimeout(res, 350));
    continue;
  }
  if (count === r.holder_count) {
    console.log(`= ${r.symbol.padEnd(10)} ${r.mint.slice(0, 8)}… — unchanged (${count.toLocaleString()})`);
    skipped += 1;
  } else {
    if (!dryRun) {
      await query(
        `UPDATE supported_mints
            SET holder_count = $2, screened_at = NOW()
          WHERE mint = $1`,
        [r.mint, count],
      );
    }
    console.log(
      `${dryRun ? "~" : "✓"} ${r.symbol.padEnd(10)} ${r.mint.slice(0, 8)}… — ${r.holder_count || 0} → ${count.toLocaleString()}`,
    );
    updated += 1;
  }
  // ~3 RPS rate limit — Helius's v0 token-metadata is cheap but we don't
  // need to be impatient.
  await new Promise((res) => setTimeout(res, 350));
}

console.log(
  `\n${dryRun ? "[DRY RUN] " : ""}Done. ${updated} updated, ${skipped} unchanged, ${failed} lookup-failed.`,
);
process.exit(0);
