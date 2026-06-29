/**
 * ONE shared, session-pinned advisory lock across EVERY service that spends
 * the lender (4JSS) key: distribution-auto-funder, fee-wallet-sweeper,
 * x402-fee-sweeper, liquidation-distribution-watcher, treasury-sweeper,
 * lp-excess-sweeper.
 *
 * Why a SHARED lock (not per-service): the privileged-sign-guard maxDecrease
 * check is per-tx — it CANNOT see a sibling service's concurrent in-flight
 * tx. So four+ timers spending the same key under separate (or zero) locks
 * each read an independent stale balance, and the aggregate draw can breach
 * the lender's 5-SOL gas reserve (the exact live "4.43 < 5" condition). The
 * ONLY structural guarantee the reserve holds ACROSS writers is: at most one
 * lender-spending tx in flight in the process. This lock + availableLenderNative()
 * (in lender-reserve.js, which debits unconfirmed in-flight spends) provide it.
 *
 * Ports the funder's pinned-client discipline: the advisory lock is SESSION-
 * scoped, so it must be acquired AND released on the SAME backend connection.
 * client.release() alone does NOT drop a session lock — if unlock can't be
 * confirmed we release with an Error so pg-pool DESTROYS the backend, and
 * Postgres drops the session lock on disconnect (prevents a silent halt where
 * a re-pooled lock-holding connection makes every future tick skip).
 *
 * Operator-mandated 2026-06-29 ("never a deficit"; lender gas never starved).
 */
import { getClient } from "../db/pool.js";

// ONE key shared by ALL lender-spending services (distinct from any
// per-service lock). Every 4JSS spender MUST wrap its tx in this.
export const LENDER_SPEND_LOCK_KEY = 73_002_606_280_629n;

/**
 * Run `fn` while holding the single shared lender-spend lock. If another
 * service holds it, returns `{ skipped: true, reason }` WITHOUT running `fn`
 * (the caller simply tries again next tick — never queues/blocks). Otherwise
 * returns `{ skipped: false, result: <fn's return> }`.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{skipped: true, reason: string} | {skipped: false, result: T}>}
 */
export async function withLenderSpendLock(fn) {
  const client = await getClient();
  let held = false;
  let unlocked = false;
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock($1::bigint) AS got`,
      [String(LENDER_SPEND_LOCK_KEY)],
    );
    if (rows[0]?.got !== true) {
      return { skipped: true, reason: "lender_spend_lock_held_by_another_service" };
    }
    held = true;
    try {
      const result = await fn();
      return { skipped: false, result };
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [
          String(LENDER_SPEND_LOCK_KEY),
        ]);
        unlocked = true;
      } catch (e) {
        console.error(
          `[lender-spend-lock] unlock failed — will evict client to force lock release: ${e.message?.slice(0, 120)}`,
        );
      }
    }
  } finally {
    // Session-scoped lock: if held but unlock unconfirmed, pass an Error so
    // pg-pool destroys the backend (Postgres releases the lock on disconnect).
    client.release(
      held && !unlocked
        ? new Error("lender-spend-lock: advisory unlock unconfirmed")
        : undefined,
    );
  }
}
