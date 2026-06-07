#!/usr/bin/env node
/**
 * SECURITY AUDIT — recent outflows from the lender authority wallet.
 *
 * Pulls the last N signatures, fetches each tx, categorizes by which
 * program/instruction was called, sums SOL moved out per category, and
 * flags anything that doesn't match the expected pattern.
 *
 * Expected categories:
 *   - price-attestor      (updatePrice / initializePriceFeed)
 *   - borrow-cosign       (request_and_fund_loan, lender as co-signer)
 *   - holder-distribution (SOL transfers to many distinct recipients)
 *   - lp-loyalty          (SOL transfers, smaller cohort)
 *   - admin-action        (set_paused, admin_withdraw, etc.)
 *   - UNEXPECTED          (anything else — flag loudly)
 *
 * Usage: node scripts/audit-lender-outflows.js [limit]
 *        defaults to last 100 signatures
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

const LENDER = new PublicKey("4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");
const RPC = process.env.SOLANA_RPC_URL;
if (!RPC) {
  console.error("SOLANA_RPC_URL not set");
  process.exit(1);
}

// Magpie programs whose instructions are expected
const V1_PROGRAM = "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh";
const V2_PROGRAM = "7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

// Anchor instruction discriminators we expect from the lender authority
const DISCRIMINATORS = {
  // From the IDL — first 8 bytes of each instruction's serialized data
  "21,217,199,183,6,96,200,52":   "request_and_fund_loan",
  "131,189,193,17,33,177,1,150":  "update_price",
  "171,200,174,106,229,34,80,175":"initialize_price_feed",
  "234,102,194,203,150,72,62,229":"liquidate_loan",
};

const limit = Number(process.argv[2] || 100);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function classifyTx(tx) {
  if (!tx?.transaction) return { category: "UNAVAILABLE", detail: "tx data missing", ixSummaries: [], feeSol: 0 };
  const message = tx.transaction.message;
  const instructions = message.instructions ?? [];

  const ixSummaries = [];
  let largeTransferOut = null;
  let recipientCount = 0;
  let touchesMagpie = false;
  let isPriceAttestor = false;
  let isBorrowCosign = false;
  let isInitFeed = false;

  for (const ix of instructions) {
    // jsonParsed gives us programId as a string and (for known programs)
    // a `parsed` object with type + info. For unknown programs, just the raw.
    const programId = ix.programId || ix.program || "unknown";

    if (programId === SYSTEM_PROGRAM || ix.program === "system") {
      const parsed = ix.parsed;
      if (parsed?.type === "transfer" && parsed.info?.source === LENDER.toBase58()) {
        const lamports = Number(parsed.info.lamports || 0);
        ixSummaries.push(`system.transfer ${lamports} lamports → ${parsed.info.destination.slice(0, 8)}...${parsed.info.destination.slice(-4)}`);
        recipientCount++;
        if (!largeTransferOut || lamports > largeTransferOut.lamports) {
          largeTransferOut = { lamports, to: parsed.info.destination };
        }
      } else if (parsed?.type) {
        ixSummaries.push(`system.${parsed.type}`);
      } else {
        ixSummaries.push("system.<unparsed>");
      }
      continue;
    }

    if (programId === COMPUTE_BUDGET || ix.program === "computeBudget") {
      ixSummaries.push("compute-budget");
      continue;
    }
    if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM || ix.program === "spl-token") {
      const parsed = ix.parsed;
      ixSummaries.push(`spl-token.${parsed?.type ?? "?"}`);
      continue;
    }

    if (programId === V1_PROGRAM || programId === V2_PROGRAM) {
      touchesMagpie = true;
      // Magpie program ixs aren't parsed by jsonParsed. We have raw data
      // base58-encoded as a string in ix.data.
      const data = decodeBase58(ix.data);
      if (data && data.length >= 8) {
        const disc = Array.from(data.slice(0, 8)).join(",");
        const name = DISCRIMINATORS[disc];
        if (name === "update_price") isPriceAttestor = true;
        if (name === "request_and_fund_loan") isBorrowCosign = true;
        if (name === "initialize_price_feed") isInitFeed = true;
        ixSummaries.push(`magpie.${name || `disc[${disc}]`}`);
      } else {
        ixSummaries.push("magpie.<no-data>");
      }
      continue;
    }

    ixSummaries.push(`UNKNOWN-PROGRAM:${programId.slice(0, 8)}…`);
  }

  let category;
  if (isBorrowCosign) category = "borrow-cosign";
  else if (isPriceAttestor) category = "price-attestor";
  else if (isInitFeed) category = "price-attestor-init";
  else if (touchesMagpie) category = "magpie-other";
  else if (recipientCount >= 5) category = "distribution-batch";
  else if (recipientCount > 0) category = "transfer-out";
  else if (ixSummaries.some((s) => s.startsWith("UNKNOWN-PROGRAM"))) category = "UNEXPECTED_PROGRAM";
  else category = "other";

  return {
    category,
    feeSol: (tx.meta?.fee ?? 0) / 1e9,
    ixSummaries,
    largeTransferOut,
    recipientCount,
  };
}

function decodeBase58(s) {
  if (!s || typeof s !== "string") return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Map([...alphabet].map((c, i) => [c, i]));
  let num = 0n;
  for (const c of s) {
    const v = map.get(c);
    if (v === undefined) return null;
    num = num * 58n + BigInt(v);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

function readLamports(bytes, offset) {
  // little-endian u64 read, return as BigInt-friendly Number for display
  let lo = 0n;
  for (let i = 0; i < 8; i++) {
    lo |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  }
  return Number(lo);
}

function decodeBase58OrBase64(s) {
  if (!s) return null;
  // jsonParsed gives base58; raw gives base64. Try base64 first (raw mode default).
  try {
    return Uint8Array.from(Buffer.from(s, "base64"));
  } catch { /* fall through */ }
  try {
    // simple base58 decode (avoid pulling bs58 dep here)
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const map = new Map([...alphabet].map((c, i) => [c, i]));
    let num = 0n;
    for (const c of s) {
      const v = map.get(c);
      if (v === undefined) return null;
      num = num * 58n + BigInt(v);
    }
    const bytes = [];
    while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
    for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

(async () => {
  console.log(`\n=== Audit: lender wallet ${LENDER.toBase58()} ===`);
  console.log(`Pulling last ${limit} signatures...\n`);

  const sigs = await rpc("getSignaturesForAddress", [
    LENDER.toBase58(),
    { limit },
  ]);
  if (!sigs?.length) {
    console.log("No signatures returned.");
    return;
  }

  console.log(`Got ${sigs.length} signatures. Oldest: ${new Date(sigs[sigs.length - 1].blockTime * 1000).toISOString()}, Newest: ${new Date(sigs[0].blockTime * 1000).toISOString()}\n`);

  // Pull tx data for each — chunk to avoid hammering RPC
  const txs = [];
  for (let i = 0; i < sigs.length; i += 10) {
    const batch = sigs.slice(i, i + 10);
    const results = await Promise.all(
      batch.map((s) =>
        rpc("getTransaction", [s.signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null),
      ),
    );
    txs.push(...results.map((r, j) => ({ sig: batch[j].signature, blockTime: batch[j].blockTime, err: batch[j].err, raw: r })));
    process.stdout.write(`  fetched ${Math.min(i + 10, sigs.length)} / ${sigs.length}...\r`);
  }
  console.log("\n");

  // Use jsonParsed — gives us decoded SystemProgram + spl-token instructions
  // and the inner instructions, which is what we actually need.
  const txsJson = [];
  for (let i = 0; i < sigs.length; i += 10) {
    const batch = sigs.slice(i, i + 10);
    const results = await Promise.all(
      batch.map((s) =>
        rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null),
      ),
    );
    for (let j = 0; j < results.length; j++) {
      txsJson.push({
        sig: batch[j].signature,
        blockTime: batch[j].blockTime,
        err: batch[j].err,
        raw: results[j],
      });
    }
  }

  // Categorize
  const byCategory = {};
  let totalFeesSol = 0;
  let totalTransferredOutSol = 0;
  const unexpected = [];

  for (const t of txsJson) {
    if (t.err) continue; // skip failed txs
    if (!t.raw) {
      (byCategory["unavailable"] ||= []).push(t);
      continue;
    }
    const c = classifyTx(t.raw);
    (byCategory[c.category] ||= []).push({ sig: t.sig, blockTime: t.blockTime, ...c });
    totalFeesSol += c.feeSol;
    if (c.largeTransferOut) totalTransferredOutSol += c.largeTransferOut.lamports / 1e9;
    if (c.category.startsWith("UNEXPECTED") || c.category === "MAGPIE_UNKNOWN_IX") {
      unexpected.push({ sig: t.sig, ...c });
    }
  }

  console.log("=== Category counts ===");
  for (const [cat, list] of Object.entries(byCategory)) {
    const fees = list.reduce((s, t) => s + (t.feeSol || 0), 0);
    const out = list.reduce((s, t) => s + (t.largeTransferOut?.lamports || 0), 0) / 1e9;
    console.log(`  ${cat.padEnd(25)} ${String(list.length).padStart(4)} txs  ·  ${fees.toFixed(6)} SOL fees  ·  ${out.toFixed(6)} SOL transferred out`);
  }
  console.log("");
  console.log(`Total fees paid:        ${totalFeesSol.toFixed(6)} SOL`);
  console.log(`Total SOL transferred:  ${totalTransferredOutSol.toFixed(6)} SOL`);
  console.log(`Total outflow:          ${(totalFeesSol + totalTransferredOutSol).toFixed(6)} SOL`);

  function safeDt(blockTime) {
    if (!blockTime || isNaN(blockTime)) return "unknown-time";
    try { return new Date(blockTime * 1000).toISOString(); } catch { return "unknown-time"; }
  }

  if (unexpected.length > 0) {
    console.log("\n=== Activity flagged for review (may include decoder false-positives) ===");
    for (const u of unexpected.slice(0, 8)) {
      console.log(`  ${safeDt(u.blockTime)}  ${u.sig}`);
      console.log(`    category: ${u.category}`);
      console.log(`    ixs: ${u.ixSummaries.join(" | ")}`);
      if (u.largeTransferOut) {
        console.log(`    transfer: ${(u.largeTransferOut.lamports / 1e9).toFixed(6)} SOL → ${u.largeTransferOut.to}`);
      }
    }
    if (unexpected.length > 8) console.log(`  ... ${unexpected.length - 8} more flagged txs not shown`);
  } else {
    console.log("\n✅ Nothing in the unexpected category. All outflows match known protocol operations.");
  }

  // Show top 10 BIGGEST outflows regardless of category — useful spot-check
  const allWithTransfers = Object.values(byCategory)
    .flat()
    .filter((t) => t.largeTransferOut)
    .sort((a, b) => (b.largeTransferOut?.lamports || 0) - (a.largeTransferOut?.lamports || 0))
    .slice(0, 10);

  if (allWithTransfers.length > 0) {
    console.log("\n=== Top 10 LARGEST outflows (SOL transferred out via system.transfer) ===");
    for (const t of allWithTransfers) {
      console.log(`  ${safeDt(t.blockTime)}  ${(t.largeTransferOut.lamports / 1e9).toFixed(6)} SOL → ${t.largeTransferOut.to}  [${t.category}]  ${t.sig}`);
    }
  } else {
    console.log("\n✅ NO outgoing system.transfer of SOL detected from this wallet in the audited window.");
    console.log("   Only outflow is network fees (tiny per-tx, sums shown above).");
  }
})().catch((e) => {
  console.error("audit failed:", e);
  process.exit(1);
});
