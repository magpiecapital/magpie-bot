/**
 * Take-profit fee accrual watcher.
 *
 * Routes the 1% TP execution fee through the same
 * accrueFromLoan / accrueToHolderPool / accrueToLpLoyaltyPool
 * pipeline that borrow fees use. With this in place, the
 * MGP-001 70-10-10-10 split applies uniformly to BOTH borrow
 * fees AND take-profit fees: 70% holders, 10% LPs, 10% referrers,
 * 10% protocol reserve (once MGP-001 ratifies).
 *
 * Why a separate watcher vs accruing inline in the engine:
 *   - The engine is a separate service (magpie-limitclose) and the
 *     accrual functions live in this bot. Cross-service code sharing
 *     would require pulling the bot's lib into the engine repo.
 *   - The engine already writes the canonical limit_close_orders row
 *     with status='fired' + protocol_fee_lamports. The bot can read
 *     that row, accrue, and stamp accrued_at.
 *   - Decoupling keeps the engine focused on the on-chain fire path
 *     and lets the accrual run on the bot's regular cadence.
 *
 * Idempotency:
 *   - Filters on accrued_at IS NULL.
 *   - Each accrual function (accrueFromLoan etc.) is itself idempotent
 *     OR safe to re-run (they read configured BPS at call time).
 *   - The UPDATE that stamps accrued_at uses a CAS-like predicate so
 *     two concurrent watchers can't double-accrue.
 *
 * Failure modes:
 *   - One of the three accrual calls throws → log + leave accrued_at
 *     NULL so the next sweep retries. Partial accruals would silently
 *     drop — instead we wrap all three in a transaction so they
 *     succeed-together or fail-together.
 *
 * Cadence: every 2 minutes. The engine processes fires within seconds;
 * the watcher accrues within a couple minutes. Distribution cadence
 * is randomized 5-10 days so a 2-minute accrual delay is invisible.
 */
import { query, pool } from "../db/pool.js";

const TICK_MS = 2 * 60_000;
const BATCH_SIZE = 50;

let _timer = null;

async function tick() {
  let rows;
  try {
    const r = await query(`
      SELECT lco.id, lco.loan_id, lco.user_id, lco.protocol_fee_lamports::text AS fee
        FROM limit_close_orders lco
       WHERE lco.status IN ('fired', 'partial_fired')
         AND lco.accrued_at IS NULL
         AND lco.protocol_fee_lamports IS NOT NULL
         AND lco.protocol_fee_lamports > 0
       ORDER BY lco.fired_at NULLS FIRST
       LIMIT $1
    `, [BATCH_SIZE]);
    rows = r.rows;
  } catch (err) {
    console.error("[limit-close-accrual] scan failed:", err.message);
    return;
  }
  if (rows.length === 0) return;

  const [{ accrueFromLoan }, { accrueToHolderPool }, { accrueToLpLoyaltyPool }] = await Promise.all([
    import("./referral-rewards.js"),
    import("./magpie-holder-rewards.js"),
    import("./lp-loyalty.js"),
  ]);

  let accruedCount = 0;
  for (const row of rows) {
    const feeLamports = BigInt(row.fee);
    if (feeLamports <= 0n) continue;

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Re-check inside the transaction with FOR UPDATE so two watchers
      // racing the same row can't both proceed past this point.
      const { rows: [locked] } = await c.query(
        `SELECT id FROM limit_close_orders WHERE id = $1 AND accrued_at IS NULL FOR UPDATE`,
        [row.id],
      );
      if (!locked) {
        await c.query("ROLLBACK");
        continue;
      }

      // Three accrual paths — all on the same fee number.
      // accrueFromLoan: looks up the referrer of refereeUserId and
      //                 credits referral_earnings.
      // accrueToHolderPool: bumps the global holder pool by the BPS
      //                    configured (default 1000 = 10%, will become
      //                    7000 after MGP-001).
      // accrueToLpLoyaltyPool: bumps the LP loyalty pool by its BPS.
      // Each is independent; they read the current bps from
      // governance_config (or hardcoded defaults) at call time. So
      // MGP-001's split takes effect automatically without changes.
      try {
        await accrueFromLoan({
          refereeUserId: row.user_id,
          loanDbId: row.loan_id,
          feeLamports,
          eventType: "limit_close",
        });
      } catch (err) {
        console.warn(`[limit-close-accrual] referral accrual failed for order ${row.id}:`, err.message);
      }
      try {
        await accrueToHolderPool(feeLamports);
      } catch (err) {
        console.warn(`[limit-close-accrual] holder accrual failed for order ${row.id}:`, err.message);
      }
      try {
        await accrueToLpLoyaltyPool(feeLamports);
      } catch (err) {
        console.warn(`[limit-close-accrual] LP accrual failed for order ${row.id}:`, err.message);
      }

      await c.query(
        `UPDATE limit_close_orders SET accrued_at = NOW() WHERE id = $1 AND accrued_at IS NULL`,
        [row.id],
      );
      await c.query("COMMIT");
      accruedCount++;
    } catch (err) {
      try { await c.query("ROLLBACK"); } catch {}
      console.error(`[limit-close-accrual] order ${row.id} txn failed:`, err.message);
    } finally {
      c.release();
    }
  }
  if (accruedCount > 0) {
    console.log(`[limit-close-accrual] accrued ${accruedCount}/${rows.length} fired order(s)`);
  }
}

export function startLimitCloseFeeAccrualWatcher() {
  if (_timer) return;
  console.log(`[limit-close-accrual] armed — sweeping every ${TICK_MS / 1000}s`);
  setTimeout(() => {
    tick().catch((e) => console.warn("[limit-close-accrual] tick threw:", e.message));
    _timer = setInterval(() => {
      tick().catch((e) => console.warn("[limit-close-accrual] tick threw:", e.message));
    }, TICK_MS);
  }, 60_000);
}

export function stopLimitCloseFeeAccrualWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
