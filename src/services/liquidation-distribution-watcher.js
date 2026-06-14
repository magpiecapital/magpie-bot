/**
 * Liquidation distribution watcher (Phase 2).
 *
 * Picks up liquidation_economics rows that are in 'awaiting_distribution'
 * state (a sale tx has been detected, net profit computed, splits
 * pre-recorded) and credits the rewards pool ledgers with the
 * pre-computed share amounts. Marks the row 'distributed' on success.
 *
 * What this service does NOT do
 * ─────────────────────────────
 *   - Move any SOL on-chain. The actual SOL stays in the lender
 *     wallet (which IS the distributor wallet). The accrual is to
 *     DB ledgers — magpie_holder_pool / lp_loyalty_pool /
 *     protocol_reserve_pool / referral_earnings. The existing
 *     distributor services (magpie-holder-rewards, lp-loyalty,
 *     referral-payouts) read those ledgers at snapshot time and do
 *     the on-chain transfers.
 *   - Run the snapshot itself. That stays on its existing 5–10 day
 *     random cadence.
 *   - Burn $MAGPIE. Rows with collateral_mint = MAGPIE_MINT are in
 *     'magpie_burn_pending' state, not 'awaiting_distribution', so
 *     the watcher never touches them. Operator burns those manually.
 *
 * Referrer fallback
 * ─────────────────
 * The pre-computed splits in liquidation_economics were filled at
 * watcher-detection time without knowing the borrower's referrer.
 * Here we look up users.referred_by and:
 *   - if a referrer exists: credit the referrer slice as a row in
 *     referral_earnings (status='accrued', event_type='default_profit')
 *   - if no referrer: roll the referrer slice into the holder credit
 *     (so holders effectively get 80% of net profit)
 *
 * Either way the protocol-reserve and LP-loyalty slices are credited
 * the same as the per-row pre-computation.
 *
 * Idempotency
 * ───────────
 *   - The watcher only picks up rows whose distribution_status =
 *     'awaiting_distribution'. The status update at the end of a
 *     successful credit moves the row to 'distributed', so the next
 *     tick won't pick it up again.
 *   - The UPDATE on the status uses
 *     `WHERE distribution_status = 'awaiting_distribution'` so a
 *     concurrent tick that beat us to it will match zero rows and
 *     we'll skip the credit.
 *   - The protocol-reserve credit's event_type='default_profit' plus
 *     the (loan_db_id, event_type) UNIQUE prevents double-bumping
 *     the reserve counter even if a row somehow gets credited twice.
 *   - referral_earnings has its own ON CONFLICT (loan_db_id, event_type)
 *     DO NOTHING; we use 'default_profit' there too.
 *   - The holder + LP-loyalty pool credits are NOT individually
 *     idempotent at the pool-counter level, so we lean entirely on the
 *     row-status transition to gate them. The status transition is the
 *     ONLY gate; everything else is best-effort behind it.
 *
 * Configuration
 * ─────────────
 *   LIQUIDATION_DISTRIBUTION_DISABLED=1 — kill switch
 *   LIQUIDATION_DISTRIBUTION_TICK_MS    — default 90_000 (1.5 min)
 */
import { query } from "../db/pool.js";

const TICK_MS = Number(process.env.LIQUIDATION_DISTRIBUTION_TICK_MS) || 90_000;
const FIRST_TICK_DELAY_MS = 180_000; // wait 3 min after boot so other services init
const DISABLED = /^(1|true|yes|on)$/i.test(process.env.LIQUIDATION_DISTRIBUTION_DISABLED || "");

const DEFAULT_PROFIT_EVENT_TYPE = "default_profit";

let _running = false;
let _ticking = false;

/**
 * Look up the borrower's user_id from the wallets table, then their
 * referrer (users.referred_by). Returns null if either lookup misses.
 */
async function lookupReferrerForBorrower(borrowerWallet) {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.referred_by
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      LIMIT 1`,
    [borrowerWallet],
  );
  if (!rows[0]) return { userId: null, referrerUserId: null };
  return {
    userId: rows[0].user_id,
    referrerUserId: rows[0].referred_by ?? null,
  };
}

/**
 * Distribute one liquidation_economics row.
 *
 * Returns { ok: boolean, reason?: string } — never throws to caller.
 */
async function distributeOne(row) {
  const refLookup = await lookupReferrerForBorrower(row.borrower_wallet).catch(() => ({
    userId: null, referrerUserId: null,
  }));

  // Step 1: claim the row by flipping status. If a concurrent tick
  // beat us to it, we get zero rows back and bail.
  const claim = await query(
    `UPDATE liquidation_economics
        SET distribution_status = 'distributing',
            updated_at = NOW(),
            referrer_user_id = $2
      WHERE id = $1
        AND distribution_status = 'awaiting_distribution'
      RETURNING id`,
    [row.id, refLookup.referrerUserId],
  );
  if (claim.rowCount === 0) {
    return { ok: false, reason: "claim_lost_race" };
  }

  // From here on: do best-effort credits + flip to 'distributed' or
  // 'distribute_error' at the end.
  let holderShare = BigInt(row.holder_share_lamports || "0");
  const lpShare = BigInt(row.lp_loyalty_share_lamports || "0");
  let refShare = BigInt(row.referrer_share_lamports || "0");
  const reserveShare = BigInt(row.protocol_reserve_share_lamports || "0");

  // Referrer rollover. If the borrower has no referrer, fold the
  // referrer slice into the holder credit. The 80%-to-holders rule
  // documented in the changelog and Pip.
  const hasReferrer = refLookup.referrerUserId != null;
  if (!hasReferrer && refShare > 0n) {
    holderShare = holderShare + refShare;
    refShare = 0n;
  }

  const errors = [];

  // Credit holder pool
  try {
    const { creditHolderPoolDirect } = await import("./magpie-holder-rewards.js");
    if (holderShare > 0n) await creditHolderPoolDirect(holderShare);
  } catch (err) {
    errors.push(`holder: ${err.message?.slice(0, 80)}`);
  }
  // Credit LP loyalty pool
  try {
    const { creditLpLoyaltyPoolDirect } = await import("./lp-loyalty.js");
    if (lpShare > 0n) await creditLpLoyaltyPoolDirect(lpShare);
  } catch (err) {
    errors.push(`lp: ${err.message?.slice(0, 80)}`);
  }
  // Credit protocol reserve
  try {
    const { creditProtocolReserveDirect } = await import("./protocol-reserve.js");
    if (reserveShare > 0n) {
      await creditProtocolReserveDirect({
        loanDbId: row.loan_id,
        lamports: reserveShare,
        eventType: DEFAULT_PROFIT_EVENT_TYPE,
      });
    }
  } catch (err) {
    errors.push(`reserve: ${err.message?.slice(0, 80)}`);
  }
  // Insert referral row (only if there's a referrer)
  if (hasReferrer && refShare > 0n) {
    try {
      await query(
        `INSERT INTO referral_earnings
           (referrer_user_id, referee_user_id, loan_db_id, event_type,
            fee_lamports, reward_lamports, reward_bps, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'accrued')
         ON CONFLICT (loan_db_id, event_type) DO NOTHING`,
        [
          refLookup.referrerUserId,
          refLookup.userId,
          row.loan_id,
          DEFAULT_PROFIT_EVENT_TYPE,
          row.net_profit_lamports?.toString() || "0",
          refShare.toString(),
          // Stored bps for transparency. Pre-computed against MGP-001's 1000.
          1000,
        ],
      );
    } catch (err) {
      errors.push(`referral: ${err.message?.slice(0, 80)}`);
    }
  }

  // Final status flip
  const finalStatus = errors.length === 0 ? "distributed" : "distribute_error";
  await query(
    `UPDATE liquidation_economics
        SET distribution_status = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [finalStatus, row.id],
  );

  if (errors.length > 0) {
    console.warn(`[liq-distribute] loan ${row.loan_id}: partial credit, errors=${errors.join("; ")}`);
    return { ok: false, reason: errors.join("; ") };
  }

  const totalCredited = holderShare + lpShare + refShare + reserveShare;
  console.log(
    `[liq-distribute] loan ${row.loan_id} ${row.collateral_symbol || row.collateral_mint.slice(0, 8)}: ` +
      `credited ${(Number(totalCredited) / 1e9).toFixed(4)} SOL ` +
      `(H ${(Number(holderShare) / 1e9).toFixed(4)} / ` +
      `L ${(Number(lpShare) / 1e9).toFixed(4)} / ` +
      `R ${(Number(refShare) / 1e9).toFixed(4)}${hasReferrer ? "" : " rolled"} / ` +
      `P ${(Number(reserveShare) / 1e9).toFixed(4)})`,
  );
  return { ok: true };
}

async function tick() {
  if (_ticking) return;
  if (DISABLED) return;
  _ticking = true;
  try {
    const { rows } = await query(
      `SELECT id, loan_id, collateral_mint, collateral_symbol,
              borrower_wallet, net_profit_lamports::text AS net_profit_lamports,
              holder_share_lamports::text AS holder_share_lamports,
              lp_loyalty_share_lamports::text AS lp_loyalty_share_lamports,
              referrer_share_lamports::text AS referrer_share_lamports,
              protocol_reserve_share_lamports::text AS protocol_reserve_share_lamports
         FROM liquidation_economics
        WHERE distribution_status = 'awaiting_distribution'
        ORDER BY sale_detected_at ASC NULLS FIRST
        LIMIT 25`,
    );
    if (rows.length === 0) return;
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      const r = await distributeOne(row).catch((err) => ({
        ok: false,
        reason: `unexpected: ${err.message?.slice(0, 80)}`,
      }));
      if (r.ok) succeeded++; else failed++;
    }
    console.log(`[liq-distribute] tick: distributed=${succeeded} failed=${failed}`);
  } catch (err) {
    console.warn(`[liq-distribute] tick failed: ${err.message?.slice(0, 200)}`);
  } finally {
    _ticking = false;
  }
}

export function startLiquidationDistributionWatcher() {
  if (_running) return;
  if (DISABLED) {
    console.log("[liq-distribute] disabled via LIQUIDATION_DISTRIBUTION_DISABLED");
    return;
  }
  _running = true;
  console.log(`[liq-distribute] watcher starting — tick every ${Math.round(TICK_MS / 1000)}s`);
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_TICK_DELAY_MS).unref?.();
}
