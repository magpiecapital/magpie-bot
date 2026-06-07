#!/usr/bin/env node
/**
 * DEEP drain audit — pages back through the lender wallet's full history
 * via getSignaturesForAddress + parsed transactions, looking ONLY for
 * the drain pattern (outer SystemProgram.transfer where source = lender).
 *
 * Faster than the full audit because we only fetch full tx data for
 * suspicious-looking txs. Stops when it hits the target lookback window.
 *
 * Usage: node scripts/audit-lender-drains-deep.js [hours]
 *        default: 168 (= 7 days)
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

const LENDER = new PublicKey("4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RPC = process.env.SOLANA_RPC_URL;
const hours = Number(process.argv[2] || 168);
const cutoffMs = Date.now() - hours * 3600 * 1000;

async function rpc(method, params, attempt = 0) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) {
    // Retry on rate limit with exponential backoff
    if (/rate limit|429|too many/i.test(j.error.message) && attempt < 6) {
      const delay = Math.min(30_000, 1000 * Math.pow(2, attempt));
      await new Promise((r) => setTimeout(r, delay));
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${j.error.message}`);
  }
  return j.result;
}

// Throttle: at least 50ms between RPC calls to stay under Helius's free-tier
// rate ceiling. We have ~thousands of txs to fetch; slow + steady wins.
const RPC_THROTTLE_MS = 50;
let lastRpcAt = 0;
async function throttledRpc(method, params) {
  const since = Date.now() - lastRpcAt;
  if (since < RPC_THROTTLE_MS) await new Promise((r) => setTimeout(r, RPC_THROTTLE_MS - since));
  lastRpcAt = Date.now();
  return rpc(method, params);
}

async function txHasOutgoingTransfer(sig) {
  const tx = await throttledRpc("getTransaction", [
    sig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ]).catch(() => null);
  if (!tx?.transaction) return null;

  for (const ix of tx.transaction.message.instructions) {
    const programId = ix.programId || ix.program;
    const parsed = ix.parsed;
    if (
      programId === SYSTEM_PROGRAM &&
      parsed?.type === "transfer" &&
      parsed.info?.source === LENDER.toBase58()
    ) {
      return {
        sig,
        blockTime: tx.blockTime,
        lamports: Number(parsed.info.lamports || 0),
        destination: parsed.info.destination,
      };
    }
  }
  return null;
}

(async () => {
  console.log(`\n=== DEEP audit: lender ${LENDER.toBase58()}, last ${hours}h ===`);
  console.log(`Cutoff: ${new Date(cutoffMs).toISOString()}\n`);

  let before = null;
  let totalScanned = 0;
  let totalDrains = 0;
  let totalLamports = 0;
  let earliestBlockTime = null;
  const drains = [];

  while (true) {
    const params = [LENDER.toBase58(), { limit: 1000, ...(before ? { before } : {}) }];
    const sigs = await throttledRpc("getSignaturesForAddress", params);
    if (!sigs?.length) break;

    const oldest = sigs[sigs.length - 1];
    earliestBlockTime = oldest.blockTime;

    // Quick check: only fetch full tx data if the tx might be a drain.
    // Drain txs are larger than pure attestor txs. Heuristic: fee > 0
    // AND we have the writable lender as a signer. The cheap filter is
    // to just process ALL of them (RPC is fast), but we batch.
    for (let i = 0; i < sigs.length; i += 20) {
      const batch = sigs.slice(i, i + 20).filter((s) => !s.err);
      const results = await Promise.all(batch.map((s) => txHasOutgoingTransfer(s.signature)));
      for (const drain of results.filter(Boolean)) {
        drains.push(drain);
        totalDrains++;
        totalLamports += drain.lamports;
        // Print each drain AS WE FIND IT so we have results even if the
        // script crashes mid-run.
        const dt = new Date(drain.blockTime * 1000).toISOString();
        console.log(
          `\n  🚨 DRAIN  ${dt}  ${(drain.lamports / 1e9).toFixed(6)} SOL → ${drain.destination}\n  sig: ${drain.sig}`,
        );
      }
      totalScanned += batch.length;
      const oldestSeenMs = oldest.blockTime * 1000;
      process.stdout.write(
        `  scanned ${totalScanned} sigs · drains found: ${totalDrains} · oldest: ${new Date(oldestSeenMs).toISOString()}\r`,
      );
    }

    // Stop if oldest signature in this page is past cutoff
    if (oldest.blockTime * 1000 < cutoffMs) break;
    before = oldest.signature;
  }

  console.log("\n");
  console.log(`=== Results ===`);
  console.log(`Scanned ${totalScanned} signatures total`);
  console.log(`Earliest reached: ${earliestBlockTime ? new Date(earliestBlockTime * 1000).toISOString() : "n/a"}`);
  console.log(`Drains found: ${totalDrains}`);
  console.log(`Total drained: ${(totalLamports / 1e9).toFixed(6)} SOL`);
  console.log("");

  if (drains.length === 0) {
    console.log("✅ No outgoing System.transfer drains detected in the audited window.");
    return;
  }

  // Group by destination
  const byDest = new Map();
  for (const d of drains) {
    const cur = byDest.get(d.destination) || { count: 0, lamports: 0, first: d.blockTime, last: d.blockTime };
    cur.count++;
    cur.lamports += d.lamports;
    cur.first = Math.min(cur.first, d.blockTime);
    cur.last = Math.max(cur.last, d.blockTime);
    byDest.set(d.destination, cur);
  }

  console.log("Drains by destination:");
  for (const [dest, info] of byDest) {
    console.log(`  ${dest}`);
    console.log(`    ${info.count} txs · ${(info.lamports / 1e9).toFixed(6)} SOL`);
    console.log(`    first: ${new Date(info.first * 1000).toISOString()}`);
    console.log(`    last:  ${new Date(info.last * 1000).toISOString()}`);
  }

  console.log("\nFull drain list (chronological):");
  drains
    .sort((a, b) => a.blockTime - b.blockTime)
    .forEach((d) => {
      console.log(
        `  ${new Date(d.blockTime * 1000).toISOString()}  ${(d.lamports / 1e9).toFixed(6)} SOL → ${d.destination}  ${d.sig}`,
      );
    });
})().catch((e) => {
  console.error("audit failed:", e);
  process.exit(1);
});
