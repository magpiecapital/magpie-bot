#!/usr/bin/env node
/**
 * Backfill liquidation_economics for ALL historical liquidations.
 *
 * The watcher (src/services/liquidation-economics-watcher.js) is great
 * at picking up new liquidations and their matching sale txs, but it
 * only scans the lender wallet's most recent ~100 signatures per tick.
 * For the 43 historical liquidations the protocol has accumulated
 * before today's policy ship, the matching sale txs are deep in the
 * lender wallet's history — possibly thousands of sigs back.
 *
 * This script deepens that scan, paginating through the lender wallet's
 * signature history per token mint and matching each historical
 * pending_sale row to its sale tx.
 *
 * IDEMPOTENT
 * ──────────
 * - Skips rows that already have sale_tx_sig set
 * - Uses the same UPDATE ... WHERE sale_tx_sig IS NULL race guard
 *   as the watcher, so concurrent watcher ticks during backfill don't
 *   stomp on each other
 * - Safe to re-run after partial progress
 *
 * HOW IT WORKS
 * ────────────
 * 1. Load all liquidation_economics rows with distribution_status =
 *    'pending_sale' AND sale_tx_sig IS NULL
 * 2. Group by collateral_mint — one wallet scan per mint, not per loan
 * 3. For each mint, paginate the lender wallet's getSignaturesForAddress
 *    history walking BACKWARD from now until we've covered the oldest
 *    pending row's liquidation timestamp (or hit MAX_SIG_SCAN)
 * 4. For each candidate sig, decode the tx for token outflow on that
 *    mint + SOL inflow on the lender wallet
 * 5. Greedy chronological assignment: oldest pending row → oldest
 *    matching candidate that hasn't been claimed yet
 *
 * USAGE
 * ─────
 *   railway run --service magpie-bot -- node scripts/backfill-liquidation-economics.mjs [--dry-run] [--limit=N]
 *
 *   --dry-run     Don't write to the DB; just report what would change.
 *   --limit=N     Stop after processing N rows (default: all).
 *
 * RUNTIME EXPECTATIONS
 * ────────────────────
 * Each candidate scan is a getTransaction RPC call. With ~43 historical
 * liquidations across maybe 10 distinct mints, expect 500-2000 RPC
 * calls (~2-8 min on a Helius dev tier, much faster on paid). Set
 * HELIUS_API_KEY accordingly.
 *
 * HONEST SCOPE
 * ────────────
 * This script does NOT move funds. It only records per-liquidation
 * economics in the liquidation_economics table. Phase 2 picks up
 * 'awaiting_distribution' rows and routes the SOL to the rewards
 * pool ledgers via the existing accrueToHolderPool / accrueToLpLoyaltyPool
 * / accrueToProtocolReserve primitives.
 */
import "dotenv/config";
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split("=")[1]) : null;

const DATABASE_URL = process.env.DATABASE_URL;
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const LENDER_PUBKEY = process.env.LENDER_PUBKEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const SIG_PAGE_SIZE = 100;
const MAX_SIG_SCAN = 5000;
const SALE_MATCH_TOLERANCE_LOW = 0.80;
const SALE_MATCH_TOLERANCE_HIGH = 1.20;
// MGP-001 splits — must match what the live watcher uses. If MGP-XXX
// changes these, update both places.
const MGP001_HOLDER_BPS = 7000;
const MGP001_LP_LOYALTY_BPS = 1000;
const MGP001_REFERRER_BPS = 1000;
const MGP001_PROTOCOL_RESERVE_BPS = 1000;

if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
if (!HELIUS_KEY) { console.error("HELIUS_API_KEY not set"); process.exit(1); }
if (!LENDER_PUBKEY) { console.error("LENDER_PUBKEY not set"); process.exit(1); }

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Helius ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Helius ${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Walk the lender wallet's signature history backward in pages until
 * we either cover the cutoff timestamp or hit MAX_SIG_SCAN.
 */
async function paginatedSignatures({ wallet, untilTime }) {
  const all = [];
  let before;
  while (all.length < MAX_SIG_SCAN) {
    const params = [wallet, { limit: SIG_PAGE_SIZE, ...(before ? { before } : {}) }];
    let page;
    try {
      page = await rpc("getSignaturesForAddress", params);
    } catch (err) {
      console.warn(`  sig page fetch failed (continuing with what we have): ${err.message?.slice(0, 80)}`);
      break;
    }
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    const oldest = page[page.length - 1];
    if (!oldest) break;
    before = oldest.signature;
    if (untilTime != null && oldest.blockTime != null && oldest.blockTime <= untilTime) break;
  }
  return all;
}

/**
 * For each signature, decode the tx and emit candidates that look like
 * a sale of the target mint from the lender wallet.
 */
async function emitCandidatesForSigs({ sigs, lenderWallet, collateralMint }) {
  const cands = [];
  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    const sig = sigInfo.signature;
    let tx;
    try {
      tx = await rpc("getTransaction", [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch {
      continue;
    }
    if (!tx) continue;
    const meta = tx.meta;
    if (!meta || meta.err) continue;
    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    let preAmt = null, postAmt = null;
    for (const t of pre) {
      if (t.mint === collateralMint && t.owner === lenderWallet) {
        preAmt = BigInt(t.uiTokenAmount?.amount || "0");
        break;
      }
    }
    for (const t of post) {
      if (t.mint === collateralMint && t.owner === lenderWallet) {
        postAmt = BigInt(t.uiTokenAmount?.amount || "0");
        break;
      }
    }
    if (preAmt == null && postAmt == null) continue;
    if (preAmt == null) preAmt = 0n;
    if (postAmt == null) postAmt = 0n;
    if (postAmt >= preAmt) continue;
    const tokenOutflow = preAmt - postAmt;

    const accs = tx.transaction?.message?.accountKeys || [];
    let solDelta = 0n;
    for (let i = 0; i < accs.length; i++) {
      const pk = typeof accs[i] === "string" ? accs[i] : accs[i]?.pubkey;
      if (pk === lenderWallet) {
        const preLamports = BigInt(meta.preBalances[i] ?? 0);
        const postLamports = BigInt(meta.postBalances[i] ?? 0);
        solDelta = postLamports - preLamports;
        break;
      }
    }
    if (solDelta <= 0n) continue;
    cands.push({
      txSig: sig,
      blockTime: sigInfo.blockTime || tx.blockTime || 0,
      tokenOutflow,
      solInflowLamports: solDelta,
    });
  }
  // Oldest-first so the greedy assigner matches in chronological order
  cands.sort((a, b) => a.blockTime - b.blockTime);
  return cands;
}

function computeSplits(netProfitLamports) {
  if (netProfitLamports <= 0n) return null;
  const holder = (netProfitLamports * BigInt(MGP001_HOLDER_BPS)) / 10000n;
  const lp = (netProfitLamports * BigInt(MGP001_LP_LOYALTY_BPS)) / 10000n;
  const ref = (netProfitLamports * BigInt(MGP001_REFERRER_BPS)) / 10000n;
  const reserve = (netProfitLamports * BigInt(MGP001_PROTOCOL_RESERVE_BPS)) / 10000n;
  // Rounding remainder folds into the holder slice (largest already)
  const allocated = holder + lp + ref + reserve;
  const adjHolder = allocated < netProfitLamports
    ? holder + (netProfitLamports - allocated)
    : holder;
  return { holder: adjHolder, lp, ref, reserve };
}

async function main() {
  console.log(`[backfill-liq-econ] start  dryRun=${DRY_RUN}  limit=${LIMIT ?? "none"}`);

  // Load all pending rows. Watcher should have already enrolled them
  // on boot, but if not we enroll here defensively.
  const { rows: pending } = await pool.query(
    `SELECT le.id, le.loan_id, le.collateral_mint, le.collateral_symbol,
            le.lender_share_raw,
            COALESCE(le.principal_lent_lamports, le.principal_with_fee_lamports)::bigint AS principal,
            l.updated_at AS liquidated_at, l.borrower_wallet
       FROM liquidation_economics le
       JOIN loans l ON l.id = le.loan_id
      WHERE le.distribution_status = 'pending_sale'
        AND le.sale_tx_sig IS NULL
      ORDER BY l.updated_at ASC`,
  );
  console.log(`  ${pending.length} pending_sale row(s) to backfill`);
  if (pending.length === 0) { await pool.end(); return; }

  // Group by mint so we scan the lender wallet's history once per mint
  const byMint = new Map();
  for (const row of pending) {
    if (!byMint.has(row.collateral_mint)) byMint.set(row.collateral_mint, []);
    byMint.get(row.collateral_mint).push(row);
  }

  let processed = 0;
  let matched = 0;
  for (const [mint, rows] of byMint.entries()) {
    if (LIMIT != null && processed >= LIMIT) break;
    const oldestLiqTime = Math.floor(new Date(rows[0].liquidated_at).getTime() / 1000);
    console.log(`\n  mint ${rows[0].collateral_symbol || mint.slice(0, 8)} — ${rows.length} pending row(s)`);
    console.log(`    walking sigs back to ${new Date(oldestLiqTime * 1000).toISOString()}`);

    const sigs = await paginatedSignatures({ wallet: LENDER_PUBKEY, untilTime: oldestLiqTime });
    console.log(`    fetched ${sigs.length} sigs`);
    const cands = await emitCandidatesForSigs({ sigs, lenderWallet: LENDER_PUBKEY, collateralMint: mint });
    console.log(`    found ${cands.length} candidate sale tx(s)`);

    // Greedy chronological match. For each pending row (oldest first),
    // pick the oldest candidate whose token outflow is in the tolerance
    // window AND hasn't been claimed by a previous row.
    const claimedSigs = new Set();
    for (const row of rows) {
      if (LIMIT != null && processed >= LIMIT) break;
      const target = BigInt(row.lender_share_raw);
      if (target === 0n) {
        console.log(`    loan ${row.loan_id}: zero lender_share_raw — skipping`);
        processed++;
        continue;
      }
      const liqTime = Math.floor(new Date(row.liquidated_at).getTime() / 1000);
      let chosen = null;
      for (const c of cands) {
        if (claimedSigs.has(c.txSig)) continue;
        if (c.blockTime < liqTime) continue; // sale must be AFTER liquidation
        const ratio = Number(c.tokenOutflow) / Number(target);
        if (ratio < SALE_MATCH_TOLERANCE_LOW || ratio > SALE_MATCH_TOLERANCE_HIGH) continue;
        chosen = c;
        break;
      }
      if (!chosen) {
        console.log(`    loan ${row.loan_id}: no matching sale found`);
        processed++;
        continue;
      }
      claimedSigs.add(chosen.txSig);

      const principal = BigInt(row.principal || 0);
      const netProfit = chosen.solInflowLamports - principal;
      const status = netProfit > 0n ? "awaiting_distribution" : "loss";
      const splits = computeSplits(netProfit);

      console.log(
        `    loan ${row.loan_id}: matched ${chosen.txSig.slice(0, 12)}… ` +
        `proceeds=${(Number(chosen.solInflowLamports) / 1e9).toFixed(4)} SOL ` +
        `profit=${(Number(netProfit) / 1e9).toFixed(4)} SOL → ${status}`,
      );

      if (!DRY_RUN) {
        const r = await pool.query(
          `UPDATE liquidation_economics
              SET sale_tx_sig = $1,
                  sale_proceeds_lamports = $2,
                  sale_detected_at = NOW(),
                  net_profit_lamports = $3,
                  distribution_status = $4,
                  holder_share_lamports = $5,
                  lp_loyalty_share_lamports = $6,
                  referrer_share_lamports = $7,
                  protocol_reserve_share_lamports = $8,
                  updated_at = NOW()
            WHERE id = $9 AND sale_tx_sig IS NULL
            RETURNING id`,
          [
            chosen.txSig,
            chosen.solInflowLamports.toString(),
            netProfit.toString(),
            status,
            splits ? splits.holder.toString() : "0",
            splits ? splits.lp.toString() : "0",
            splits ? splits.ref.toString() : "0",
            splits ? splits.reserve.toString() : "0",
            row.id,
          ],
        );
        if (r.rowCount > 0) matched++;
      }
      processed++;
    }
  }

  console.log(`\n[backfill-liq-econ] done — processed=${processed} matched=${matched} (dryRun=${DRY_RUN})`);
  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
