/**
 * One-off backfill: reconstruct historical pool_credit_events from
 * primary-source data (loans, extends, limit_close_orders,
 * liquidation_economics, recovery_credits) so every SOL in the three
 * pools (holder / lp_loyalty / protocol_reserve) is fully traceable.
 *
 * IMPORTANT — what this script does NOT do:
 *   - It does NOT touch any pool balance (accrued_lamports). Those
 *     are already correct.
 *   - It does NOT re-apply credits. The pool counters already reflect
 *     these credits via the legacy bare-UPDATE path.
 *
 * What it DOES do:
 *   - Inserts rows into pool_credit_events with ON CONFLICT DO NOTHING.
 *     Each event has a stable (source_type, source_id, pool_kind) so a
 *     re-run is fully idempotent.
 *   - source_type is prefixed with `backfill_` so the ledger can
 *     distinguish reconstructed history from live events going forward.
 *
 * Bps lookup is timestamp-aware:
 *   - Before MGP-001 ratification (2026-06-13 21:01:46Z):
 *       holder=10%, lp=2%, reserve=N/A (didn't exist)
 *   - After MGP-001:
 *       holder=70%, lp=10%, reserve=10%
 *
 * Run with:
 *   node scripts/backfill-pool-credit-events.mjs
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const MGP001_AT = new Date("2026-06-13T21:01:46.571Z").getTime();

function bpsForEvent(timestampMs) {
  if (timestampMs >= MGP001_AT) {
    return { holder: 7000, lp: 1000, reserve: 1000 };
  } else {
    return { holder: 1000, lp: 200, reserve: 0 };
  }
}

async function insertEvent({ sourceType, sourceId, poolKind, lamports, metadata, createdAt }) {
  if (lamports <= 0n) return false;
  const r = await query(
    `INSERT INTO pool_credit_events (source_type, source_id, pool_kind, lamports, metadata, created_at)
     VALUES ($1, $2, $3, $4::numeric, $5::jsonb, $6)
     ON CONFLICT (source_type, source_id, pool_kind) DO NOTHING
     RETURNING id`,
    [sourceType, sourceId, poolKind, lamports.toString(), JSON.stringify({ ...metadata, backfilled: true }), createdAt],
  );
  return r.rowCount > 0;
}

console.log("=== STAGE 1: borrow fees (loans table) ===");
{
  // Use original - amt as the gross fee. Loans where this is 0 or
  // negative are skipped (likely missing data).
  const { rows } = await query(
    `SELECT id, created_at,
            COALESCE(original_loan_amount_lamports::numeric, loan_amount_lamports::numeric)
              - loan_amount_lamports::numeric AS gross_fee,
            collateral_mint, status, program_id
       FROM loans
      WHERE created_at >= '2026-06-10 21:54:00+00'`,
  );
  let inserted = 0, skipped = 0;
  for (const row of rows) {
    const grossFee = BigInt(row.gross_fee);
    if (grossFee <= 0n) { skipped++; continue; }
    const bps = bpsForEvent(new Date(row.created_at).getTime());
    const sourceType = "backfill_borrow_fee";
    const sourceId = `loan_${row.id}`;
    const meta = { loan_id: row.id, gross_fee_lamports: grossFee.toString(), collateral_mint: row.collateral_mint, bps_at_time: bps };
    if (bps.holder > 0) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "holder", lamports: (grossFee * BigInt(bps.holder)) / 10_000n, metadata: meta, createdAt: row.created_at })) inserted++;
    }
    if (bps.lp > 0) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "lp_loyalty", lamports: (grossFee * BigInt(bps.lp)) / 10_000n, metadata: meta, createdAt: row.created_at })) inserted++;
    }
    if (bps.reserve > 0) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "protocol_reserve", lamports: (grossFee * BigInt(bps.reserve)) / 10_000n, metadata: meta, createdAt: row.created_at })) inserted++;
    }
  }
  console.log(`  borrow fees: scanned=${rows.length} skipped=${skipped} inserted_events=${inserted}`);
}

console.log("\n=== STAGE 2: limit-close fees (limit_close_orders) ===");
{
  const { rows } = await query(
    `SELECT id, fired_at, protocol_fee_lamports::text fee, loan_id
       FROM limit_close_orders
      WHERE status = 'fired' AND protocol_fee_lamports IS NOT NULL AND fired_at IS NOT NULL`,
  );
  let inserted = 0, skipped = 0;
  for (const row of rows) {
    const fee = BigInt(row.fee || "0");
    if (fee <= 0n) { skipped++; continue; }
    const bps = bpsForEvent(new Date(row.fired_at).getTime());
    const sourceType = "backfill_limit_close_fee";
    const sourceId = `lc_order_${row.id}`;
    const meta = { lc_order_id: row.id, loan_id: row.loan_id, gross_fee_lamports: fee.toString(), bps_at_time: bps };
    if (bps.holder > 0) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "holder", lamports: (fee * BigInt(bps.holder)) / 10_000n, metadata: meta, createdAt: row.fired_at })) inserted++;
    }
    if (bps.lp > 0) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "lp_loyalty", lamports: (fee * BigInt(bps.lp)) / 10_000n, metadata: meta, createdAt: row.fired_at })) inserted++;
    }
    if (bps.reserve > 0) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "protocol_reserve", lamports: (fee * BigInt(bps.reserve)) / 10_000n, metadata: meta, createdAt: row.fired_at })) inserted++;
    }
  }
  console.log(`  limit-close fees: scanned=${rows.length} skipped=${skipped} inserted_events=${inserted}`);
}

console.log("\n=== STAGE 3: liquidation_economics (profitable defaults) ===");
{
  const { rows } = await query(
    `SELECT id, loan_id, sale_detected_at, collateral_symbol, distribution_status,
            net_profit_lamports::text npf,
            holder_share_lamports::text hs,
            lp_loyalty_share_lamports::text lps,
            protocol_reserve_share_lamports::text rss,
            referrer_share_lamports::text refs,
            borrower_wallet
       FROM liquidation_economics
      WHERE distribution_status = 'distributed'
        AND net_profit_lamports > 0`,
  );
  let inserted = 0;
  for (const row of rows) {
    const sourceType = "backfill_liquidation_default_profit";
    const sourceId = `liq_econ_${row.id}`;
    // Determine if referrer slice rolled into holder (no referrer)
    let rolled = false;
    if (row.borrower_wallet) {
      const ref = await query(
        `SELECT u.referred_by FROM wallets w JOIN users u ON u.id=w.user_id WHERE w.public_key=$1 LIMIT 1`,
        [row.borrower_wallet],
      ).catch(() => ({ rows: [] }));
      rolled = !ref.rows[0]?.referred_by;
    } else {
      rolled = true;
    }
    const holderShare = BigInt(row.hs || "0") + (rolled ? BigInt(row.refs || "0") : 0n);
    const lpShare = BigInt(row.lps || "0");
    const reserveShare = BigInt(row.rss || "0");
    const meta = { loan_id: row.loan_id, collateral_symbol: row.collateral_symbol, net_profit: row.npf, referrer_rolled_into_holder: rolled };
    if (holderShare > 0n) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "holder", lamports: holderShare, metadata: meta, createdAt: row.sale_detected_at })) inserted++;
    }
    if (lpShare > 0n) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "lp_loyalty", lamports: lpShare, metadata: meta, createdAt: row.sale_detected_at })) inserted++;
    }
    if (reserveShare > 0n) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "protocol_reserve", lamports: reserveShare, metadata: meta, createdAt: row.sale_detected_at })) inserted++;
    }
  }
  console.log(`  liquidation default profit: scanned=${rows.length} inserted_events=${inserted}`);
}

console.log("\n=== STAGE 4: recovery_credits ===");
{
  const { rows } = await query(
    `SELECT id, kind, created_at, distributed_at, distribution_status,
            amount_lamports::text amt,
            holder_share_lamports::text hs,
            lp_loyalty_share_lamports::text lps,
            protocol_reserve_share_lamports::text rss
       FROM recovery_credits
      WHERE distribution_status = 'distributed'`,
  );
  let inserted = 0;
  for (const row of rows) {
    const sourceType = `backfill_recovery_${row.kind}`;
    const sourceId = `recovery_credit_${row.id}`;
    const holderShare = BigInt(row.hs || "0");
    const lpShare = BigInt(row.lps || "0");
    const reserveShare = BigInt(row.rss || "0");
    const meta = { recovery_credit_id: row.id, kind: row.kind, total_amount: row.amt };
    const ts = row.distributed_at || row.created_at;
    if (holderShare > 0n) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "holder", lamports: holderShare, metadata: meta, createdAt: ts })) inserted++;
    }
    if (lpShare > 0n) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "lp_loyalty", lamports: lpShare, metadata: meta, createdAt: ts })) inserted++;
    }
    if (reserveShare > 0n) {
      if (await insertEvent({ sourceType, sourceId, poolKind: "protocol_reserve", lamports: reserveShare, metadata: meta, createdAt: ts })) inserted++;
    }
  }
  console.log(`  recovery credits: scanned=${rows.length} inserted_events=${inserted}`);
}

console.log("\n=== STAGE 5: reconciliation event for the gap ===");
{
  // Extends + magpie-burn-pool inflows + other pre-ledger credits we
  // can't enumerate from primary sources. Insert ONE event per pool
  // labeled clearly so future drift analysis can spot it.
  // Idempotent via fixed source_id; safe to re-run.
  const RECON_SOURCE_TYPE = "backfill_pre_ledger_reconciliation";
  const RECON_SOURCE_ID = "pre_ledger_2026_06_18";
  const RECON_TS = "2026-06-18T22:30:00Z"; // ~30 min before recovery_credit creation
  for (const kind of ["holder", "lp_loyalty", "protocol_reserve"]) {
    const poolTable = { holder: "magpie_holder_pool", lp_loyalty: "lp_loyalty_pool", protocol_reserve: "protocol_reserve_pool" }[kind];
    const ledgerSum = await query(`SELECT COALESCE(SUM(lamports), 0)::text v FROM pool_credit_events WHERE pool_kind = $1`, [kind]);
    const poolNow = await query(`SELECT accrued_lamports::text v FROM ${poolTable} WHERE id=1`);
    const gap = BigInt(poolNow.rows[0].v) - BigInt(ledgerSum.rows[0].v);
    if (gap <= 0n) {
      console.log(`  ${kind}: gap is ${gap} — no reconciliation needed`);
      continue;
    }
    const inserted = await insertEvent({
      sourceType: RECON_SOURCE_TYPE,
      sourceId: RECON_SOURCE_ID,
      poolKind: kind,
      lamports: gap,
      metadata: {
        note: "Pre-ledger miscellaneous credits — likely extends, magpie burn pool inflows, and any other source not derivable from primary tables. Single reconciliation event so ledger sum matches pool counter at backfill time.",
        backfill_timestamp: new Date().toISOString(),
        pool_at_backfill_lamports: poolNow.rows[0].v,
        ledger_sum_before_recon: ledgerSum.rows[0].v,
      },
      createdAt: RECON_TS,
    });
    if (inserted) {
      console.log(`  ${kind}: inserted reconciliation event for gap ${(Number(gap) / 1e9).toFixed(4)} SOL`);
    } else {
      console.log(`  ${kind}: reconciliation already exists (re-run) — recomputing would double-count, skipped`);
    }
  }
}

console.log("\n=== POST-BACKFILL RECONCILIATION ===");
for (const kind of ["holder", "lp_loyalty", "protocol_reserve"]) {
  const ledgerSum = await query(
    `SELECT COALESCE(SUM(lamports), 0)::text v FROM pool_credit_events WHERE pool_kind = $1`,
    [kind],
  );
  const poolTable = { holder: "magpie_holder_pool", lp_loyalty: "lp_loyalty_pool", protocol_reserve: "protocol_reserve_pool" }[kind];
  const poolNow = await query(`SELECT accrued_lamports::text v FROM ${poolTable} WHERE id=1`);
  const ledger = BigInt(ledgerSum.rows[0].v);
  const pool = BigInt(poolNow.rows[0].v);
  const delta = pool - ledger;
  console.log(`  ${kind.padEnd(18)} pool=${(Number(pool) / 1e9).toFixed(4).padStart(8)} SOL  ledger=${(Number(ledger) / 1e9).toFixed(4).padStart(8)} SOL  delta=${(Number(delta) / 1e9).toFixed(4).padStart(8)} SOL`);
}
console.log("\nDelta should be ≤ small live-bot accruals since backfill ran. If significantly positive, re-run.");

process.exit(0);
