#!/usr/bin/env node
/**
 * Onboard tokenized real-world assets (Stocks, ETFs, Metals) as collateral.
 *
 * Three jobs in one script:
 *
 *   1. Refresh the existing Backed Finance xStock entries in the DB
 *      (currently stored with stale $0 liquidity from when they were
 *      first deployed). Pull live numbers and properly categorize.
 *
 *   2. Add new ETF + Metal collateral entries with proper category
 *      labels ('etf', 'metal') so they're distinguishable from stocks.
 *
 *   3. Reclassify the ~30 polluted "stock" memecoins back to 'memecoin'
 *      so the stock category actually contains stocks.
 *
 * Each candidate is vetted live against DexScreener with thresholds
 * tuned for RWA assets (different from memecoin thresholds — see PR
 * notes for the rationale).
 *
 * Usage:
 *   railway run node scripts/onboard-rwa-collateral.js           # dry run
 *   railway run node scripts/onboard-rwa-collateral.js --execute # apply
 *
 * Idempotent — safe to re-run. Will just refresh data on subsequent runs.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const execute = process.argv.includes("--execute");

// RWA-specific thresholds — different from memecoin screener.
// Lower minimum liquidity (these aren't community-LP'd) but require
// real 24h volume so liquidation isn't a disaster.
const MIN_LIQUIDITY_USD = 100_000;
const MIN_VOLUME_24H_USD = 5_000;

// ─── CURATED ALLOWLIST ────────────────────────────────────────────────────
// Each entry: known-good Solana mint + intended category + display name.
// Symbol comes from the live token name on Solana (not always the same as
// the underlying stock's ticker). Decimals from DexScreener.
const CANDIDATES = [
  // ─── STOCKS (Backed Finance xStocks) ───
  { mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", category: "stock", name: "NVIDIA xStock" },
  { mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", category: "stock", name: "Tesla xStock" },
  { mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", category: "stock", name: "MicroStrategy xStock" },
  { mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", category: "stock", name: "Coinbase xStock" },
  { mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", category: "stock", name: "Amazon xStock" },
  { mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", category: "stock", name: "Alphabet xStock" },
  { mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", category: "stock", name: "Apple xStock" },
  // The ones DexScreener showed with the <TICKER>x pattern — try by symbol below
  { searchSymbol: "MSFTx", category: "stock", name: "Microsoft xStock" },
  { searchSymbol: "METAx", category: "stock", name: "Meta xStock" },
  { searchSymbol: "HOODx", category: "stock", name: "Robinhood xStock" },
  { searchSymbol: "NFLXx", category: "stock", name: "Netflix xStock" },
  { searchSymbol: "PLTRx", category: "stock", name: "Palantir xStock" },

  // ─── ETFs ───
  { searchSymbol: "SPYx", category: "etf", name: "S&P 500 ETF xStock" },
  { searchSymbol: "QQQx", category: "etf", name: "Nasdaq 100 ETF xStock" },

  // ─── METALS ───
  // VNX Gold — actually-trading gold-backed token on Solana
  { searchSymbol: "VNXAU", category: "metal", name: "VNX Gold" },
];

// Memecoin pollution to reclassify back to memecoin. Identified by
// holders=-1 + non-Xs-prefix mint + obvious meme name.
const POLLUTED_STOCK_SYMBOLS = [
  "APPLE", "STOCKCOIN", "PLOI", "COIN", "JARS", "TSLA", "STOCK", "AGI",
  "BAKSO", "NVIDIA", "SSEC", "TESLAFC", "EACC", "COINBASE", "FINDER",
  "BIB", "NVDA", "XSTOCKS", "TESLACAUST", "KOOLPILL", "STRC", "AI",
  "TSM6900", "xMETA", "xMSFT",
];

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function fetchSolPriceUsd() {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const pairs = Array.isArray(j) ? j : (j.pairs || []);
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return best ? parseFloat(best.priceUsd) : null;
}

async function fetchMintData(mintOrSymbol, byMint = false) {
  try {
    const url = byMint
      ? `https://api.dexscreener.com/tokens/v1/solana/${mintOrSymbol}`
      : `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(mintOrSymbol)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = byMint
      ? (Array.isArray(j) ? j : (j.pairs || []))
      : (j.pairs || []).filter((p) => p.chainId === "solana");
    if (pairs.length === 0) return null;
    // For symbol search, require exact symbol match
    let candidates = pairs;
    if (!byMint) {
      candidates = pairs.filter((p) => p.baseToken?.symbol === mintOrSymbol);
      if (candidates.length === 0) return null;
    }
    candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const top = candidates[0];
    return {
      mint: top.baseToken.address,
      symbol: top.baseToken.symbol,
      name: top.baseToken.name,
      liquidityUsd: top.liquidity?.usd || 0,
      volume24hUsd: top.volume?.h24 || 0,
      priceUsd: parseFloat(top.priceUsd),
      // Decimals not in DexScreener response; need to look up on-chain
    };
  } catch {
    return null;
  }
}

async function fetchDecimals(mint) {
  // Use Helius / Solana RPC via the bot's connection
  const { connection } = await import("../src/solana/connection.js");
  const { PublicKey } = await import("@solana/web3.js");
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint), "confirmed");
    const data = info.value?.data;
    if (data && "parsed" in data) {
      return data.parsed.info?.decimals ?? null;
    }
  } catch {}
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
console.log(execute ? "LIVE — will write to DB" : "DRY RUN — no DB writes\n");

const solPriceUsd = await fetchSolPriceUsd();
if (!solPriceUsd) {
  console.error("Couldn't fetch SOL/USD price. Aborting.");
  process.exit(1);
}
console.log(`SOL/USD: $${solPriceUsd.toFixed(2)}\n`);

const results = [];
console.log("═══ Probing candidates ═══");
for (const c of CANDIDATES) {
  let live;
  if (c.mint) {
    live = await fetchMintData(c.mint, true);
  } else if (c.searchSymbol) {
    live = await fetchMintData(c.searchSymbol, false);
  }
  if (!live) {
    console.log(`  ✗ ${(c.searchSymbol || c.mint?.slice(0, 12)).padEnd(12)} — no Solana pair found`);
    results.push({ ...c, status: "no-market" });
    continue;
  }
  const passLiq = live.liquidityUsd >= MIN_LIQUIDITY_USD;
  const passVol = live.volume24hUsd >= MIN_VOLUME_24H_USD;
  const verdict = passLiq && passVol ? "✓ APPROVE" : "✗ skip";
  console.log(
    `  ${verdict.padEnd(11)} ${live.symbol.padEnd(10)} ` +
    `liq:$${Math.round(live.liquidityUsd).toLocaleString().padStart(10)} ` +
    `vol24h:$${Math.round(live.volume24hUsd).toLocaleString().padStart(10)} ` +
    `· ${live.mint.slice(0, 16)}...` +
    (!passLiq ? ` (liq<${MIN_LIQUIDITY_USD/1000}k)` : "") +
    (!passVol ? ` (vol<${MIN_VOLUME_24H_USD/1000}k)` : ""),
  );
  if (passLiq && passVol) {
    const decimals = await fetchDecimals(live.mint);
    results.push({
      ...c,
      live,
      decimals,
      status: "approve",
    });
  } else {
    results.push({ ...c, live, status: "skip-thresholds" });
  }
  await new Promise((r) => setTimeout(r, 200));
}

const approved = results.filter((r) => r.status === "approve");
console.log(`\n${approved.length} approved · ${results.filter(r => r.status !== "approve").length} skipped`);

// ─── Reclassification of polluted memecoin-as-stock entries ──────────────
console.log("\n═══ Memecoin-as-stock reclassification ═══");
const { rows: polluted } = await query(
  `SELECT mint, symbol, name FROM supported_mints
    WHERE category = 'stock' AND symbol = ANY($1::text[])`,
  [POLLUTED_STOCK_SYMBOLS],
);
console.log(`  Found ${polluted.length} polluted entries to reclassify back to 'memecoin':`);
for (const p of polluted) {
  console.log(`    ${p.symbol.padEnd(12)} ${p.name?.slice(0, 40)}`);
}

// ─── Apply or report ──────────────────────────────────────────────────────
if (!execute) {
  console.log("\nDRY RUN. To apply, re-run with --execute.");
  process.exit(0);
}

console.log("\n═══ Applying changes ═══");

// 1. Upsert approved tokens
for (const r of approved) {
  const liq = r.live.liquidityUsd;
  const vol = r.live.volume24hUsd;
  const priceSol = r.live.priceUsd / solPriceUsd;
  const marketCapUsd = 0; // not always provided by DexScreener; leave 0
  await query(
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url,
        liquidity_usd, holder_count, market_cap_usd,
        has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected)
     VALUES ($1, $2, $3, $4, $5, NULL,
             $6, 0, $7,
             TRUE, TRUE, FALSE,
             999, FALSE, NOW(), 'manual_rwa',
             TRUE, FALSE)
     ON CONFLICT (mint) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       name = EXCLUDED.name,
       decimals = COALESCE(EXCLUDED.decimals, supported_mints.decimals),
       category = EXCLUDED.category,
       liquidity_usd = EXCLUDED.liquidity_usd,
       market_cap_usd = EXCLUDED.market_cap_usd,
       screened_at = NOW(),
       enabled = TRUE`,
    [r.live.mint, r.live.symbol, r.name, r.decimals, r.category, liq, marketCapUsd],
  );
  console.log(`  ✓ Upserted ${r.live.symbol} as '${r.category}' — liq $${Math.round(liq).toLocaleString()}`);
}

// 2. Reclassify polluted entries
let reclassified = 0;
for (const p of polluted) {
  await query(
    `UPDATE supported_mints SET category = 'memecoin' WHERE mint = $1 AND category = 'stock'`,
    [p.mint],
  );
  reclassified++;
}
console.log(`  ✓ Reclassified ${reclassified} polluted "stock" entries back to 'memecoin'`);

// 3. Final summary
const { rows: byCategory } = await query(
  `SELECT category, COUNT(*)::int AS n FROM supported_mints WHERE enabled = TRUE GROUP BY category ORDER BY n DESC`,
);
console.log("\n═══ Final state — enabled mints by category ═══");
for (const r of byCategory) console.log(`  ${(r.category || "?").padEnd(12)} ${r.n}`);

process.exit(0);
