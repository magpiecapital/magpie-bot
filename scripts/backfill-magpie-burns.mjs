#!/usr/bin/env node
/**
 * Backfill the magpie_burns ledger with EVERY historical $MAGPIE burn
 * conducted from the lender wallet.
 *
 * Operator burns seized $MAGPIE collateral (and conducts other manual
 * burns) directly from the lender wallet
 * 4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx. This script walks the
 * wallet's history and records every $MAGPIE burn into magpie_burns.
 *
 * TWO-STAGE DETECTION (the important bit)
 * ───────────────────────────────────────
 * The first version of this script used only Helius's top-level
 * `tx.type === "BURN"` signal. It missed every real lender-wallet burn
 * (verified 2026-06-14 against 4 known burns) because the operator's
 * burns go through a custom burn program that CPIs into Token-2022 —
 * Helius classifies the top-level type as "UNKNOWN" and surfaces no
 * burn event. tokenTransfers stays empty for burns too.
 *
 * Fix: a two-stage scan.
 *
 *   STAGE 1 — FAST PREFILTER (Helius enhanced API, 100 txs/req):
 *     Walk the wallet's history via /v0/addresses/{addr}/transactions
 *     (paginated). For each tx, mark it a CANDIDATE if ANY outer or
 *     inner instruction's programId is the Token-2022 program. Most
 *     lender-wallet activity (SOL transfers, loan accounting, lamport
 *     drains) never touches Token-2022 at all — this filter typically
 *     eliminates >99% of txs.
 *
 *   STAGE 2 — EXACT DECODE (JSON-RPC getParsedTransaction, candidate-only):
 *     For each candidate, fetch the fully-parsed transaction and walk
 *     every parsed instruction looking for spl-token type=burn or
 *     burnChecked targeting MAGPIE_MINT with authority=LENDER. Pull
 *     amount + blockTime. Insert into magpie_burns idempotently.
 *
 * Because Stage 2 only fires on candidates, the slow per-tx RPC path
 * is bounded by the wallet's actual Token-2022 activity, not the full
 * sig firehose. Months of history → minutes instead of hours.
 *
 * IDEMPOTENT
 * ──────────
 * recordBurn() uses INSERT … ON CONFLICT (burn_tx_sig) DO NOTHING,
 * so any tx already in the ledger is skipped. Safe to re-run.
 *
 * USAGE
 * ─────
 *   railway run --service magpie-bot -- node scripts/backfill-magpie-burns.mjs [--dry-run] [--max-pages=N] [--since=YYYY-MM-DD]
 */
import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { recordBurn, getBurnSummary, rawToHumanString } from "../src/services/magpie-burns.js";

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_PAGES_ARG = process.argv.find((a) => a.startsWith("--max-pages="));
const MAX_PAGES = MAX_PAGES_ARG ? Number(MAX_PAGES_ARG.split("=")[1]) : 1000;
const SINCE_ARG = process.argv.find((a) => a.startsWith("--since="));
const SINCE_MS = SINCE_ARG
  ? new Date(SINCE_ARG.split("=")[1]).getTime()
  : new Date("2026-03-01").getTime();

const LENDER = process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";
const MAGPIE_MINT = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const RPC = process.env.SOLANA_RPC_URL || "";
const apiKeyMatch = RPC.match(/api-key=([a-f0-9-]+)/i);
const API_KEY = apiKeyMatch ? apiKeyMatch[1] : process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Helius API key not found in SOLANA_RPC_URL or HELIUS_API_KEY");
  process.exit(1);
}

const HELIUS_TX_URL = `https://api.helius.xyz/v0/addresses/${LENDER}/transactions`;
const RPC_URL = RPC || `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const conn = new Connection(RPC_URL, "confirmed");

async function fetchPage(before = null) {
  const url = new URL(HELIUS_TX_URL);
  url.searchParams.set("api-key", API_KEY);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  const res = await fetch(url.toString());
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return fetchPage(before);
  }
  if (!res.ok) {
    throw new Error(`Helius ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Stage 1 prefilter: does this Helius-enhanced tx touch the Token-2022
 * program anywhere in its outer or inner instructions? We use this as
 * a cheap "worth decoding" signal because Token-2022 invocation is rare
 * in this wallet's traffic but mandatory for any $MAGPIE burn.
 */
function touchesToken2022(tx) {
  const outer = tx.instructions || [];
  for (const ix of outer) {
    if (ix.programId === TOKEN_2022_PROGRAM_ID) return true;
    for (const inner of (ix.innerInstructions || [])) {
      if (inner.programId === TOKEN_2022_PROGRAM_ID) return true;
    }
  }
  return false;
}

/**
 * Stage 2: decode a candidate tx via JSON-RPC parsed format and pull
 * every Token-2022 burn / burnChecked targeting MAGPIE_MINT where the
 * authority is the lender wallet. Returns array of { amountRaw, type }.
 */
async function decodeMagpieBurnsForTx(signature) {
  let tx;
  try {
    tx = await conn.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    return [];
  }
  if (!tx?.transaction?.message?.instructions) return [];
  const all = [
    ...tx.transaction.message.instructions,
    ...((tx.meta?.innerInstructions || []).flatMap((ii) => ii.instructions)),
  ];
  const found = [];
  for (const ix of all) {
    if (ix.program !== "spl-token") continue;
    const info = ix.parsed?.info;
    const type = ix.parsed?.type;
    if (!info || !type) continue;
    if (type !== "burn" && type !== "burnChecked") continue;
    if (info.mint !== MAGPIE_MINT) continue;
    const auth = info.authority || info.multisigAuthority;
    if (auth !== LENDER) continue;
    let amountRaw;
    if (type === "burn") amountRaw = info.amount;
    else amountRaw = info.tokenAmount?.amount;
    if (!amountRaw) continue;
    const amt = BigInt(amountRaw);
    if (amt <= 0n) continue;
    found.push({ amountRaw: amt, type });
  }
  return found;
}

async function main() {
  console.log(`[backfill-burns] start  dryRun=${DRY_RUN}  lender=${LENDER}`);
  console.log(`[backfill-burns] cutoff: ${new Date(SINCE_MS).toISOString()}  maxPages=${MAX_PAGES}`);
  console.log(`[backfill-burns] detection: two-stage (Helius prefilter + JSON-RPC decode of candidates)`);

  const t0 = Date.now();
  let before = null;
  let pages = 0;
  let totalTxScanned = 0;
  let candidates = 0;
  let burnsFound = 0;
  let burnsInserted = 0;
  let burnsSkippedDuplicate = 0;
  let totalAmountRaw = 0n;

  while (pages < MAX_PAGES) {
    let page;
    try {
      page = await fetchPage(before);
    } catch (err) {
      console.error(`[backfill-burns] fetch failed page ${pages + 1}:`, err.message);
      break;
    }
    if (!page?.length) {
      console.log(`[backfill-burns] no more pages — exhausted history at page ${pages}`);
      break;
    }
    pages++;
    totalTxScanned += page.length;
    const oldest = page[page.length - 1];
    before = oldest.signature;
    const oldestMs = (oldest.timestamp ?? 0) * 1000;

    // Stage 1: collect candidates from this page
    const pageCandidates = page.filter(touchesToken2022);
    candidates += pageCandidates.length;

    if (pages % 10 === 0 || page.length < 100 || pageCandidates.length > 0) {
      console.log(`[backfill-burns] page ${pages}: ${page.length} txs (oldest ${new Date(oldestMs).toISOString()})  candidates=${pageCandidates.length}  burns_so_far=${burnsFound}`);
    }

    // Stage 2: decode each candidate
    for (const tx of pageCandidates) {
      const burns = await decodeMagpieBurnsForTx(tx.signature);
      for (const b of burns) {
        burnsFound++;
        totalAmountRaw += b.amountRaw;
        const burnedAt = tx.timestamp ? new Date(tx.timestamp * 1000) : null;
        console.log(
          `  BURN  ${rawToHumanString(b.amountRaw)} \$MAGPIE  ` +
          `tx=${tx.signature.slice(0, 24)}…  ` +
          `at=${burnedAt?.toISOString() ?? "(unknown)"}  type=${b.type}`,
        );

        if (DRY_RUN) continue;

        try {
          const id = await recordBurn({
            amountRaw: b.amountRaw.toString(),
            source: "manual",
            relatedLoanId: null,
            burnTxSig: tx.signature,
            notes: `Backfilled lender-wallet \$MAGPIE burn — operator-conducted`,
            burnedAt,
          });
          if (id) burnsInserted++;
          else burnsSkippedDuplicate++;
        } catch (err) {
          console.warn(`  insert failed for ${tx.signature}: ${err.message?.slice(0, 100)}`);
        }
      }
    }

    if (oldestMs && oldestMs < SINCE_MS) {
      console.log(`[backfill-burns] crossed since cutoff at page ${pages} — stopping`);
      break;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log(`[backfill-burns] done in ${elapsed}s  pages=${pages}  txs_scanned=${totalTxScanned}  candidates=${candidates}  burns_found=${burnsFound}  inserted=${burnsInserted}  duplicates=${burnsSkippedDuplicate}`);
  console.log(`[backfill-burns] total amount across found burns: ${rawToHumanString(totalAmountRaw)} \$MAGPIE`);

  if (!DRY_RUN) {
    const summary = await getBurnSummary();
    console.log(`[backfill-burns] LEDGER total post-backfill: ${summary.total_tokens} \$MAGPIE  (${summary.burn_count} events)`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-burns] fatal:", err);
  process.exit(1);
});
