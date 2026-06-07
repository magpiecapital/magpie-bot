#!/usr/bin/env node
/**
 * FAST 7-day drain audit using Helius's enhanced parsed-transactions API.
 *
 * Helius's /v0/addresses/<addr>/transactions endpoint returns up to 100
 * parsed transactions per call with separate rate limits from the
 * standard JSON-RPC. Walking back through 7 days takes ~30-60 seconds
 * instead of 30+ minutes.
 *
 * Usage: node scripts/audit-lender-drains-helius.js [hours]
 *        default: 168 (= 7 days)
 */
import "dotenv/config";

const LENDER = "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";
const RPC = process.env.SOLANA_RPC_URL || "";
const apiKeyMatch = RPC.match(/api-key=([a-f0-9-]+)/i);
const API_KEY = apiKeyMatch ? apiKeyMatch[1] : process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Helius API key not found in SOLANA_RPC_URL or HELIUS_API_KEY");
  process.exit(1);
}

const hours = Number(process.argv[2] || 168);
const cutoffMs = Date.now() - hours * 3600 * 1000;
const HELIUS_TX_URL = `https://api.helius.xyz/v0/addresses/${LENDER}/transactions`;

async function fetchPage(before = null) {
  const url = new URL(HELIUS_TX_URL);
  url.searchParams.set("api-key", API_KEY);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  const res = await fetch(url.toString());
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      return fetchPage(before);
    }
    throw new Error(`Helius ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function findOutgoingTransfers(tx) {
  // Helius enhanced format: nativeTransfers array, each entry has
  // fromUserAccount, toUserAccount, amount (lamports as number)
  const out = [];
  if (Array.isArray(tx.nativeTransfers)) {
    for (const t of tx.nativeTransfers) {
      if (t.fromUserAccount === LENDER && Number(t.amount || 0) > 0) {
        out.push({
          lamports: Number(t.amount),
          to: t.toUserAccount,
          signature: tx.signature,
          timestamp: tx.timestamp,
        });
      }
    }
  }
  return out;
}

(async () => {
  console.log(`\n=== HELIUS DEEP audit: lender ${LENDER}, last ${hours}h ===`);
  console.log(`Cutoff: ${new Date(cutoffMs).toISOString()}\n`);

  let before = null;
  let totalScanned = 0;
  const drains = [];
  let earliestSeen = null;

  while (true) {
    let page;
    try {
      page = await fetchPage(before);
    } catch (e) {
      console.error(`\nFETCH FAILED: ${e.message}`);
      break;
    }
    if (!page?.length) break;

    for (const tx of page) {
      totalScanned++;
      earliestSeen = tx.timestamp;
      if (tx.transactionError) continue;
      const transfersOut = findOutgoingTransfers(tx);
      for (const t of transfersOut) {
        drains.push(t);
        const dt = new Date(t.timestamp * 1000).toISOString();
        console.log(
          `🚨 DRAIN  ${dt}  ${(t.lamports / 1e9).toFixed(6)} SOL → ${t.to}\n   sig: ${t.signature}`,
        );
      }
    }

    process.stdout.write(
      `... scanned ${totalScanned} txs · drains: ${drains.length} · oldest: ${new Date(earliestSeen * 1000).toISOString()}\n`,
    );

    // Stop conditions
    if (earliestSeen * 1000 < cutoffMs) break;
    if (page.length < 100) break; // ran out
    before = page[page.length - 1].signature;
  }

  console.log("\n=== FINAL RESULTS ===");
  console.log(`Scanned ${totalScanned} transactions`);
  console.log(`Earliest reached: ${earliestSeen ? new Date(earliestSeen * 1000).toISOString() : "n/a"}`);
  console.log(`Drains found: ${drains.length}`);
  const totalLamports = drains.reduce((s, d) => s + d.lamports, 0);
  console.log(`Total SOL drained: ${(totalLamports / 1e9).toFixed(6)} SOL`);

  if (drains.length === 0) {
    console.log("\n✅ No outgoing SOL transfers from the lender wallet in the audited window.");
    return;
  }

  // Group by destination
  const byDest = new Map();
  for (const d of drains) {
    const cur = byDest.get(d.to) || { count: 0, lamports: 0, first: d.timestamp, last: d.timestamp };
    cur.count++;
    cur.lamports += d.lamports;
    cur.first = Math.min(cur.first, d.timestamp);
    cur.last = Math.max(cur.last, d.timestamp);
    byDest.set(d.to, cur);
  }

  console.log("\nBy destination:");
  for (const [dest, info] of [...byDest.entries()].sort((a, b) => b[1].lamports - a[1].lamports)) {
    console.log(`  ${dest}`);
    console.log(`    ${info.count} txs · ${(info.lamports / 1e9).toFixed(6)} SOL`);
    console.log(`    first: ${new Date(info.first * 1000).toISOString()}`);
    console.log(`    last:  ${new Date(info.last * 1000).toISOString()}`);
  }

  console.log("\nChronological list:");
  drains
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((d) => {
      console.log(
        `  ${new Date(d.timestamp * 1000).toISOString()}  ${(d.lamports / 1e9).toFixed(6)} SOL → ${d.to.slice(0, 8)}...${d.to.slice(-4)}  ${d.signature}`,
      );
    });
})().catch((e) => {
  console.error("audit failed:", e);
  process.exit(1);
});
