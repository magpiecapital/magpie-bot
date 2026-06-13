/**
 * Order-staleness watcher — soft-cleanup for forgotten limit orders.
 *
 * Users arm an order, the trigger is far from current price, weeks
 * pass, market moves elsewhere — the order is now dead weight in the
 * engine's armed-orders scan and the user has forgotten it exists.
 *
 * Once every STALE_CHECK_INTERVAL_MS this watcher:
 *   1. Pulls limit_close_orders rows that are
 *        status='armed' AND armed_at < NOW() - STALE_AGE_DAYS
 *      AND have never been nudged (staleness_nudged_at IS NULL).
 *   2. For each, fetches the current price (via the shared
 *      cross-sourced oracle) and computes the distance to trigger.
 *   3. If the trigger is more than FAR_FROM_TRIGGER_PCT away from
 *      current price IN THE DIRECTION the trigger is supposed to
 *      fire (so a TP that's still 50% above current = stale, but a
 *      TP that's already 5% above current is NOT stale because it
 *      could realistically fire), enqueues a 'limit_close_staleness_nudge'
 *      DM with inline [Keep active] / [Cancel] buttons.
 *   4. Marks staleness_nudged_at = NOW() so we don't re-nudge the
 *      same order until 30+ days later.
 *
 * Cadence: every 6 hours. These nudges are not time-sensitive — a few
 * hours' delay is fine — and a low cadence keeps notification volume
 * sane.
 *
 * Operator-stated rule [[feedback_tg_changes_careful]]: never spam
 * existing users. The watcher bails silently on any error, never
 * sends to users with proactive_dms_disabled, and writes the
 * staleness_nudged_at timestamp BEFORE enqueueing so a duplicate
 * tick on a slow cycle still can't re-nudge.
 */
import { query } from "../db/pool.js";

const STALE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const STALE_AGE_DAYS = Number(process.env.LIMIT_CLOSE_STALE_AGE_DAYS) || 7;
const FAR_FROM_TRIGGER_PCT = Number(process.env.LIMIT_CLOSE_STALE_FAR_PCT) || 30;
const NUDGE_BATCH_LIMIT = 50; // soft cap per cycle so a backlog can't slam Jupiter

function bandedPct(triggerMicros, currentMicros, direction) {
  // Distance % from current price to trigger, signed for direction.
  // For 'above' (TP), positive = trigger is above current. We want
  // POSITIVE >= FAR_FROM_TRIGGER_PCT to flag stale (price needs to
  // move UP a lot to hit trigger). For 'below' (SL), negative =
  // trigger is below current; abs >= FAR flags stale.
  if (currentMicros == null || currentMicros === 0n) return null;
  // BigInt-safe percentage difference: (trigger - current) * 100 / current
  const diff = triggerMicros - currentMicros;
  const pct = Number(diff) / Number(currentMicros) * 100;
  if (direction === "above") return pct;          // positive = trigger above current
  /* direction === "below" */    return -pct;     // make positive = trigger below current
}

async function fetchStaleOrders() {
  const { rows } = await query(
    `SELECT o.id, o.user_id, o.loan_id, o.trigger_kind,
            o.trigger_value_micro::text AS trigger_value_micro,
            COALESCE(o.trigger_direction, 'above') AS trigger_direction,
            o.armed_at, o.slippage_bps,
            o.sell_destination,
            l.collateral_mint, l.loan_id AS loan_id_chain,
            m.symbol AS collateral_symbol,
            u.telegram_id, u.proactive_dms_disabled
       FROM limit_close_orders o
       JOIN loans l ON l.id = o.loan_id
       LEFT JOIN supported_mints m ON m.mint = l.collateral_mint
       JOIN users u ON u.id = o.user_id
      WHERE o.status = 'armed'
        AND o.armed_at < NOW() - ($1 || ' days')::INTERVAL
        AND o.staleness_nudged_at IS NULL
      ORDER BY o.armed_at ASC
      LIMIT $2`,
    [String(STALE_AGE_DAYS), NUDGE_BATCH_LIMIT],
  );
  return rows;
}

async function currentMicrosFor(row) {
  // Only price_usd and mc_usd have a single-number price we can compare
  // directly to trigger_value_micro. price_sol triggers are skipped —
  // SOL denominator moves and a stale-detection algorithm on a moving
  // baseline is brittle. The hot path for stale orders is almost
  // entirely USD-denominated triggers anyway.
  try {
    if (row.trigger_kind !== "price_usd" && row.trigger_kind !== "mc_usd") return null;
    const { getPriceInUsdCrossSourced } = await import("./price.js");
    const usd = await getPriceInUsdCrossSourced(row.collateral_mint);
    if (!usd || usd <= 0) return null;
    if (row.trigger_kind === "price_usd") {
      return BigInt(Math.round(usd * 1e6));
    }
    // mc_usd needs supply — best effort; skip if we can't compute
    const { rows: [mintRow] } = await query(
      `SELECT supply FROM supported_mints WHERE mint = $1`,
      [row.collateral_mint],
    );
    if (!mintRow?.supply) return null;
    return BigInt(Math.round(usd * 1e6)) * BigInt(mintRow.supply);
  } catch {
    return null;
  }
}

async function enqueueNudge(order, distancePct) {
  // Mark BEFORE enqueueing — duplicate ticks on a slow cycle never
  // re-nudge. If the notification enqueue fails the timestamp is
  // already set; user just doesn't get THIS nudge but won't be re-
  // nudged for 30 days. Acceptable failure mode given the soft
  // "this is a courtesy" nature of the message.
  await query(
    `UPDATE limit_close_orders SET staleness_nudged_at = NOW() WHERE id = $1`,
    [order.id],
  );
  await query(
    `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
       VALUES ($1, 'tg', 'limit_close_staleness_nudge', $2::jsonb, 'pending')`,
    [order.user_id, JSON.stringify({
      order_id: order.id,
      loan_id_chain: order.loan_id_chain,
      trigger_kind: order.trigger_kind,
      trigger_direction: order.trigger_direction,
      trigger_value_micro: order.trigger_value_micro,
      collateral_symbol: order.collateral_symbol || "your token",
      days_old: Math.round((Date.now() - new Date(order.armed_at).getTime()) / 86_400_000),
      distance_pct: Math.round(distancePct),
    })],
  );
}

async function tick() {
  let stale;
  try {
    stale = await fetchStaleOrders();
  } catch (err) {
    console.warn("[lc-staleness] fetch failed:", err.message?.slice(0, 80));
    return;
  }
  if (stale.length === 0) return;
  let nudged = 0;
  for (const order of stale) {
    if (order.proactive_dms_disabled) continue;
    const currentMicros = await currentMicrosFor(order);
    if (currentMicros == null) continue;
    const triggerMicros = BigInt(order.trigger_value_micro);
    const distancePct = bandedPct(triggerMicros, currentMicros, order.trigger_direction);
    if (distancePct == null) continue;
    if (distancePct < FAR_FROM_TRIGGER_PCT) continue;
    try {
      await enqueueNudge(order, distancePct);
      nudged++;
    } catch (err) {
      console.warn(`[lc-staleness] nudge ${order.id} failed:`, err.message?.slice(0, 80));
    }
  }
  if (nudged > 0) {
    console.log(`[lc-staleness] nudged ${nudged} stale order(s) of ${stale.length} candidates`);
  }
}

export function startLimitCloseStalenessWatcher() {
  console.log(`[lc-staleness] armed — sweeping every ${STALE_CHECK_INTERVAL_MS / 3_600_000}h for armed orders > ${STALE_AGE_DAYS}d old`);
  // First sweep waits 10 min so it doesn't run during boot-storm activity.
  setTimeout(() => tick().catch((e) => console.warn("[lc-staleness] first tick threw:", e.message?.slice(0, 80))), 10 * 60 * 1000);
  setInterval(() => tick().catch((e) => console.warn("[lc-staleness] tick threw:", e.message?.slice(0, 80))), STALE_CHECK_INTERVAL_MS);
}
