/**
 * Near-trigger watcher — proactive DM when an armed limit order is
 * within striking distance of its trigger.
 *
 * Users arm a TP / SL and then either monitor the chart obsessively
 * OR forget the order exists. Both are bad UX. This watcher splits
 * the difference: a single, one-time DM when current price gets
 * within NEAR_TRIGGER_PCT (default 10%) of the trigger so the user
 * knows the engine is about to act AND has a chance to adjust or
 * cancel if the market context has changed.
 *
 * Cadence: every NEAR_CHECK_INTERVAL_MS (default 5 min). More frequent
 * than the staleness watcher because the actionable window is short —
 * a 10% gap on a moving token can close fast.
 *
 * Once-only via `near_trigger_dm_sent_at` column (migration 056).
 * Reset to NULL on modify so a user editing the trigger gets a fresh
 * nudge if they re-enter the near band.
 *
 * Operator-stated rule [[feedback_tg_changes_careful]]: never spam
 * existing users. Respects proactive_dms_disabled, bails silently on
 * any error, marks the timestamp BEFORE enqueueing so a duplicate
 * tick can't double-send.
 *
 * 2026-06-13.
 */
import { query } from "../db/pool.js";

const NEAR_CHECK_INTERVAL_MS = Number(process.env.LIMIT_CLOSE_NEAR_INTERVAL_MS) || 5 * 60 * 1000; // 5 min
// Width of the "near-trigger" band. 10% means "within 10% of firing".
// Tunable via env so the operator can dial sensitivity without a deploy.
const NEAR_TRIGGER_PCT = Number(process.env.LIMIT_CLOSE_NEAR_PCT) || 10;
const NEAR_BATCH_LIMIT = 50; // soft cap per cycle so a backlog can't slam Jupiter

/**
 * Distance to trigger as a SIGNED percent, normalized so positive =
 * "still need to move toward trigger".
 *
 * Above (TP): pct = (trigger - current) / current × 100. Positive
 * when trigger is above current (still need to move up).
 *
 * Below (SL): pct = (current - trigger) / current × 100. Positive
 * when current is above trigger (still need to move down).
 *
 * Negative or zero means the trigger has already been crossed —
 * the engine should have fired this tick or last. We do NOT nudge
 * in that case (it'd be redundant noise).
 */
function distanceToTriggerPct(triggerMicros, currentMicros, direction) {
  if (currentMicros == null || currentMicros === 0n) return null;
  const diff = direction === "above"
    ? triggerMicros - currentMicros   // need price to rise
    : currentMicros - triggerMicros;  // need price to fall
  return Number(diff) / Number(currentMicros) * 100;
}

async function fetchCandidates() {
  // Same shape as the staleness watcher's fetcher, but without the
  // armed-for-X-days clause — near-trigger is independent of age.
  // `near_trigger_dm_sent_at IS NULL` is the one-time gate.
  const { rows } = await query(
    `SELECT o.id, o.user_id, o.loan_id, o.trigger_kind,
            o.trigger_value_micro::text AS trigger_value_micro,
            COALESCE(o.trigger_direction, 'above') AS trigger_direction,
            o.armed_at, o.slippage_bps,
            o.sell_destination,
            o.engine_program_id,
            l.collateral_mint, l.loan_id AS loan_id_chain,
            l.original_loan_amount_lamports::text AS owed_lamports,
            m.symbol AS collateral_symbol,
            u.telegram_id, u.proactive_dms_disabled
       FROM limit_close_orders o
       JOIN loans l ON l.id = o.loan_id
       LEFT JOIN supported_mints m ON m.mint = l.collateral_mint
       JOIN users u ON u.id = o.user_id
      WHERE o.status = 'armed'
        AND o.near_trigger_dm_sent_at IS NULL
        AND o.trigger_kind IN ('price_usd', 'mc_usd')
      ORDER BY o.armed_at DESC
      LIMIT $1`,
    [NEAR_BATCH_LIMIT],
  );
  return rows;
}

async function currentMicrosFor(row) {
  try {
    const { getPriceInUsdCrossSourced } = await import("./price.js");
    const usd = await getPriceInUsdCrossSourced(row.collateral_mint);
    if (!usd || usd <= 0) return null;
    if (row.trigger_kind === "price_usd") {
      return BigInt(Math.round(usd * 1e6));
    }
    // mc_usd: multiply by circulating supply when available; otherwise
    // skip (we can't compare a USD-price-only oracle to a MC trigger).
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
  // already set; user just doesn't get THIS nudge but won't be
  // spammed.
  await query(
    `UPDATE limit_close_orders SET near_trigger_dm_sent_at = NOW() WHERE id = $1`,
    [order.id],
  );
  await query(
    `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
       VALUES ($1, 'tg', 'limit_close_near_trigger', $2::jsonb, 'pending')`,
    [order.user_id, JSON.stringify({
      order_id: order.id,
      loan_id_chain: order.loan_id_chain,
      trigger_kind: order.trigger_kind,
      trigger_direction: order.trigger_direction,
      trigger_value_micro: order.trigger_value_micro,
      collateral_symbol: order.collateral_symbol || "your token",
      slippage_bps: order.slippage_bps,
      distance_pct: Math.round(distancePct * 10) / 10, // 1 decimal
      // V4-aware DM text: the renderer swaps "auto-repay+sell" → "convert
      // in-vault" wording AND appends a liquid-SOL reminder so the user
      // can fund the eventual repay. Pass through the program id + the
      // original owed amount; the renderer derives the message.
      engine_program_id: order.engine_program_id || null,
      owed_lamports: order.owed_lamports || null,
    })],
  );
}

async function tick() {
  let candidates;
  try {
    candidates = await fetchCandidates();
  } catch (err) {
    console.warn("[lc-near-trigger] fetch failed:", err.message?.slice(0, 80));
    return;
  }
  if (candidates.length === 0) return;
  let nudged = 0;
  for (const order of candidates) {
    if (order.proactive_dms_disabled) continue;
    const currentMicros = await currentMicrosFor(order);
    if (currentMicros == null) continue;
    const triggerMicros = BigInt(order.trigger_value_micro);
    const distancePct = distanceToTriggerPct(triggerMicros, currentMicros, order.trigger_direction);
    if (distancePct == null) continue;
    // distancePct <= 0 means the trigger has already been hit (engine
    // should fire on its next tick). Don't nudge — it'd land milliseconds
    // before the fired-confirmation DM.
    if (distancePct <= 0) continue;
    if (distancePct > NEAR_TRIGGER_PCT) continue;
    try {
      await enqueueNudge(order, distancePct);
      nudged++;
    } catch (err) {
      console.warn(`[lc-near-trigger] nudge ${order.id} failed:`, err.message?.slice(0, 80));
    }
  }
  if (nudged > 0) {
    console.log(`[lc-near-trigger] nudged ${nudged} near-trigger order(s) of ${candidates.length} candidates`);
  }
}

export function startLimitCloseNearTriggerWatcher() {
  console.log(`[lc-near-trigger] armed — sweeping every ${NEAR_CHECK_INTERVAL_MS / 60_000} min for orders within ${NEAR_TRIGGER_PCT}% of trigger`);
  // First sweep waits 2 min so it doesn't run during boot-storm.
  setTimeout(() => tick().catch((e) => console.warn("[lc-near-trigger] first tick threw:", e.message?.slice(0, 80))), 2 * 60 * 1000);
  setInterval(() => tick().catch((e) => console.warn("[lc-near-trigger] tick threw:", e.message?.slice(0, 80))), NEAR_CHECK_INTERVAL_MS);
}
