/**
 * Liquidation economics watcher (Phase 1A).
 *
 * Reads-only, populates the liquidation_economics table. Phase 2 will
 * add the actual SOL routing path on top.
 *
 * Operator policy (2026-06-14):
 *   - When a non-$MAGPIE collateralized loan defaults and the operator
 *     sells the seized collateral, the NET PROFIT (sale proceeds
 *     minus the SOL principal the protocol disbursed) is split:
 *       70%  → $MAGPIE holder rewards
 *       10%  → LP loyalty
 *       10%  → referrer (rolls back to holders if the borrower has no referrer)
 *       10%  → protocol reserve
 *   - When $MAGPIE itself is the collateral, the seized $MAGPIE is
 *     burned on-chain. The OPERATOR conducts these burns manually
 *     (confirmed 2026-06-14); the watcher only records the
 *     `magpie_burn_pending` row state. Operator transitions it to
 *     `magpie_burned` via the manual confirm path once the burn tx
 *     lands. No autonomous burn-instruction code.
 *
 * What this watcher does
 * ──────────────────────
 *   1. Loads liquidated loans without a liquidation_economics row.
 *      Inserts initial rows with distribution_status='pending_sale'
 *      (or 'magpie_burn_pending' for $MAGPIE collateral).
 *   2. For pending_sale rows, polls the lender wallet's recent token
 *      transfer history (via Helius) looking for outgoing collateral
 *      that matches the row's lender_share_raw amount.
 *      When a match is found, records sale_tx_sig + sale_proceeds_lamports
 *      + net_profit_lamports + pre-computed split shares.
 *      State moves to 'awaiting_distribution' or 'loss'.
 *   3. Never moves funds. Phase 2 will pick up 'awaiting_distribution'
 *      rows and call the existing distributor primitives.
 *
 * Idempotency
 * ───────────
 *   - UNIQUE(loan_id) on liquidation_economics means INSERTs are
 *     ON CONFLICT DO NOTHING safe.
 *   - Sale-detection updates use `WHERE sale_tx_sig IS NULL` so a
 *     row that already has its sale recorded is never re-written.
 *   - The lender wallet's tx history is paginated by signature; the
 *     watcher keeps a high-water mark per collateral_mint to avoid
 *     reading the full history every tick.
 *
 * Configuration
 * ─────────────
 *   LENDER_PUBKEY                — already used by the keeper bot
 *   HELIUS_API_KEY               — for signature/transaction reads
 *   LIQUIDATION_ECONOMICS_DISABLED=1 — operator kill switch
 *   LIQUIDATION_ECONOMICS_TICK_MS   — default 60_000 (1 min)
 *
 * Honest scope
 * ────────────
 *   This is Phase 1 — DATA CAPTURE ONLY. No fund movement. No on-chain
 *   instructions. Read-only enrichment of the liquidations the protocol
 *   already executed via the keeper bot. Phase 2 adds the SOL routing
 *   path; Phase 3 adds the $MAGPIE burn instruction.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const TICK_MS = Number(process.env.LIQUIDATION_ECONOMICS_TICK_MS) || 60_000;
const DEFAULT_FIRST_TICK_DELAY_MS = 120_000;
const DISABLED = /^(1|true|yes|on)$/i.test(process.env.LIQUIDATION_ECONOMICS_DISABLED || "");

// The $MAGPIE mint — collateral-burn path lives separately. Anything
// else uses the SOL-distribution path.
const MAGPIE_MINT = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";

// Lender wallet (operator's authority). Used to query token outflows
// when looking for the sale tx that liquidated collateral was sold in.
const LENDER_PUBKEY = process.env.LENDER_PUBKEY || null;

// MGP-001 ratified split. Stored here as constants for the per-row
// pre-computed share columns. The actual fund movement in Phase 2
// must re-read getRuntimeConfigBps() at distribution time so a future
// MGP-XXX bps change is honored automatically.
const MGP001_HOLDER_BPS = 7000;
const MGP001_LP_LOYALTY_BPS = 1000;
const MGP001_REFERRER_BPS = 1000;
const MGP001_PROTOCOL_RESERVE_BPS = 1000;

// Tolerance when matching seized-collateral amount against an outgoing
// token transfer. Operator may sell partial / batched holdings, so an
// EXACT match is too strict. Match when the outgoing amount is between
// 80% and 120% of the row's lender_share_raw — wider than that and we
// surface as ambiguous for operator review.
const SALE_MATCH_TOLERANCE_LOW  = 0.80;
const SALE_MATCH_TOLERANCE_HIGH = 1.20;

let _running = false;
let _ticking = false;

/**
 * Read keeper_reward_bps from the lending pool's on-chain state. The
 * keeper takes a fraction of the collateral as bounty during the
 * liquidate_loan instruction. Used to derive lender_share_raw from
 * the total collateral_amount on the loan row.
 *
 * Fallback default: 500 bps (5%) — matches what was observed in the
 * 2026-06-14 $PUMP default. If the actual on-chain value differs, this
 * fallback will be slightly off; the audit log surfaces the diff.
 */
const KEEPER_REWARD_BPS_FALLBACK = 500;
async function getKeeperRewardBps() {
  try {
    const { getReadOnlyProgram } = await import("../solana/program.js");
    const { lendingPoolPda } = await import("../solana/pdas.js");
    const program = getReadOnlyProgram();
    const [poolPda] = lendingPoolPda(new PublicKey(LENDER_PUBKEY));
    const pool = await program.account.lendingPool.fetch(poolPda);
    const bps = Number(pool.keeperRewardBps);
    if (Number.isFinite(bps) && bps > 0 && bps < 5000) return bps;
  } catch (err) {
    console.warn(`[liq-econ] keeper_reward_bps fetch failed, using fallback ${KEEPER_REWARD_BPS_FALLBACK}: ${err.message?.slice(0, 80)}`);
  }
  return KEEPER_REWARD_BPS_FALLBACK;
}

/**
 * Compute the lender_share_raw + keeper_bounty_raw from the loan's
 * collateral_amount and the pool's keeper_reward_bps.
 */
function deriveSeizureSplits(collateralAmountRaw, keeperBps) {
  const total = BigInt(collateralAmountRaw);
  const keeperShare = (total * BigInt(keeperBps)) / 10000n;
  const lenderShare = total - keeperShare;
  return {
    collateralSeizedRaw: total.toString(),
    keeperBountyRaw: keeperShare.toString(),
    lenderShareRaw: lenderShare.toString(),
  };
}

/**
 * Step 1 of the watcher tick — enroll any liquidated loans that don't
 * yet have a liquidation_economics row.
 *
 * Returns count of newly enrolled rows.
 */
async function enrollUntrackedLiquidations(keeperBps) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id,
            -- borrower_wallet was added in a later migration. For older
            -- TG-bot-only loans it's NULL; fall back to the user's
            -- custodial wallet public_key via the wallets join. Site
            -- borrows always have l.borrower_wallet populated directly.
            COALESCE(l.borrower_wallet, w.public_key) AS borrower_wallet,
            l.collateral_mint, l.collateral_amount,
            l.original_loan_amount_lamports::bigint AS principal_with_fee,
            -- actual_received_lamports was added recently; for historical
            -- loans it's NULL. Fall back to the headline loan_amount which
            -- is what actually hit the borrower's wallet (origination fee
            -- is already netted out of this field on the program side).
            COALESCE(l.actual_received_lamports, l.loan_amount_lamports)::bigint AS principal_lent,
            sm.symbol AS collateral_symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       LEFT JOIN wallets w ON w.user_id = l.user_id
      WHERE l.status = 'liquidated'
        AND NOT EXISTS (
          SELECT 1 FROM liquidation_economics le WHERE le.loan_id = l.id
        )
      ORDER BY l.updated_at ASC
      LIMIT 100`,
  );
  let enrolled = 0;
  let skipped = 0;
  for (const loan of rows) {
    // After the COALESCE fallbacks: if borrower_wallet is still NULL we
    // can't enroll (would violate liquidation_economics NOT NULL). Skip
    // silently — operator can backfill the loans row if needed.
    if (!loan.borrower_wallet) {
      skipped++;
      continue;
    }
    const splits = deriveSeizureSplits(loan.collateral_amount, keeperBps);
    const isMagpie = loan.collateral_mint === MAGPIE_MINT;
    const principalLent = loan.principal_lent != null
      ? loan.principal_lent
      : null;
    try {
      await query(
        `INSERT INTO liquidation_economics
           (loan_id, borrower_wallet, collateral_mint, collateral_symbol,
            principal_lent_lamports, principal_with_fee_lamports,
            collateral_seized_raw, lender_share_raw, keeper_bounty_raw,
            distribution_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (loan_id) DO NOTHING`,
        [
          loan.id,
          loan.borrower_wallet,
          loan.collateral_mint,
          loan.collateral_symbol,
          principalLent,
          loan.principal_with_fee,
          splits.collateralSeizedRaw,
          splits.lenderShareRaw,
          splits.keeperBountyRaw,
          isMagpie ? "magpie_burn_pending" : "pending_sale",
        ],
      );
      enrolled++;
    } catch (err) {
      console.warn(`[liq-econ] enroll failed for loan ${loan.loan_id}: ${err.message?.slice(0, 100)}`);
    }
  }
  if (skipped > 0) {
    console.log(`[liq-econ] enroll: ${enrolled} enrolled, ${skipped} skipped (NULL borrower_wallet — no wallets join match)`);
  }
  return enrolled;
}

/**
 * Step 2 — for each pending_sale row, search the lender wallet's
 * recent token outflows for a matching sale. When found, compute
 * proceeds + profit + splits and update the row.
 *
 * Strategy: for each unique collateral_mint with pending rows, fetch
 * the lender wallet's recent signatures, decode token-balance deltas,
 * match against pending rows by amount + chronology.
 *
 * This is Phase 1 — best-effort matching, no on-chain instructions.
 * Ambiguous matches stay 'pending_sale' for operator review.
 */
async function detectSalesForPending() {
  if (!LENDER_PUBKEY) {
    console.warn("[liq-econ] LENDER_PUBKEY unset — cannot scan for sales");
    return 0;
  }
  const { rows } = await query(
    `SELECT id, loan_id, collateral_mint, lender_share_raw,
            principal_lent_lamports, principal_with_fee_lamports,
            collateral_symbol
       FROM liquidation_economics
      WHERE distribution_status = 'pending_sale'
        AND sale_tx_sig IS NULL
      ORDER BY created_at ASC
      LIMIT 50`,
  );
  if (rows.length === 0) return 0;
  // For Phase 1 we lazily import the sale-detection helper so the
  // watcher can boot even if the Helius client isn't configured;
  // ENOENT or fetch failures degrade to "no sale found this tick".
  let detector;
  try {
    detector = await import("./liquidation-sale-detector.js");
  } catch (err) {
    console.warn(`[liq-econ] sale detector module not available, skipping detection: ${err.message?.slice(0, 80)}`);
    return 0;
  }
  let detected = 0;
  for (const row of rows) {
    try {
      const match = await detector.findSaleForLiquidation({
        lenderWallet: LENDER_PUBKEY,
        collateralMint: row.collateral_mint,
        lenderShareRaw: row.lender_share_raw,
        toleranceLow: SALE_MATCH_TOLERANCE_LOW,
        toleranceHigh: SALE_MATCH_TOLERANCE_HIGH,
      });
      if (!match) continue;

      const proceedsLamports = BigInt(match.solInflowLamports);
      const principalLamports = BigInt(row.principal_lent_lamports || row.principal_with_fee_lamports || 0);
      const netProfit = proceedsLamports - principalLamports;
      // Compute the split shares ahead of time so the audit trail is
      // immutable. Phase 2 picks them up and routes the SOL.
      let nextStatus;
      let holderShare = 0n, lpShare = 0n, refShare = 0n, reserveShare = 0n;
      if (netProfit <= 0n) {
        nextStatus = "loss";
      } else {
        nextStatus = "awaiting_distribution";
        holderShare = (netProfit * BigInt(MGP001_HOLDER_BPS)) / 10000n;
        lpShare = (netProfit * BigInt(MGP001_LP_LOYALTY_BPS)) / 10000n;
        refShare = (netProfit * BigInt(MGP001_REFERRER_BPS)) / 10000n;
        reserveShare = (netProfit * BigInt(MGP001_PROTOCOL_RESERVE_BPS)) / 10000n;
        // Rounding remainder rolls to holders (the largest slice already)
        const allocated = holderShare + lpShare + refShare + reserveShare;
        if (allocated < netProfit) {
          holderShare += (netProfit - allocated);
        }
      }
      // WHERE sale_tx_sig IS NULL — if a concurrent tick beat us to it,
      // the UPDATE matches zero rows and we move on.
      const upd = await query(
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
          match.txSig,
          proceedsLamports.toString(),
          netProfit.toString(),
          nextStatus,
          holderShare.toString(),
          lpShare.toString(),
          refShare.toString(),
          reserveShare.toString(),
          row.id,
        ],
      );
      if (upd.rowCount > 0) {
        detected++;
        console.log(
          `[liq-econ] loan ${row.loan_id} (${row.collateral_symbol || row.collateral_mint.slice(0, 8)}): ` +
            `sale ${match.txSig.slice(0, 12)}…, proceeds=${(Number(proceedsLamports) / 1e9).toFixed(4)} SOL, ` +
            `net_profit=${(Number(netProfit) / 1e9).toFixed(4)} SOL → ${nextStatus}`,
        );
      }
    } catch (err) {
      console.warn(`[liq-econ] sale detect for loan ${row.loan_id} threw: ${err.message?.slice(0, 120)}`);
    }
  }
  return detected;
}

async function tick() {
  if (_ticking) return;
  if (DISABLED) return;
  _ticking = true;
  try {
    const keeperBps = await getKeeperRewardBps();
    const enrolled = await enrollUntrackedLiquidations(keeperBps);
    const detected = await detectSalesForPending();
    if (enrolled > 0 || detected > 0) {
      console.log(`[liq-econ] tick: enrolled=${enrolled} sales_detected=${detected}`);
    }
  } catch (err) {
    console.warn(`[liq-econ] tick failed: ${err.message?.slice(0, 200)}`);
  } finally {
    _ticking = false;
  }
}

export function startLiquidationEconomicsWatcher() {
  if (_running) return;
  if (DISABLED) {
    console.log("[liq-econ] disabled via LIQUIDATION_ECONOMICS_DISABLED");
    return;
  }
  _running = true;
  console.log(`[liq-econ] watcher starting — tick every ${Math.round(TICK_MS / 1000)}s`);
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, DEFAULT_FIRST_TICK_DELAY_MS).unref?.();
}
