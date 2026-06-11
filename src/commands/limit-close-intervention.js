/**
 * Layer 3 — TG callback handler for limit-close intervention DMs.
 *
 * Callback data formats:
 *   lcint:approve:<order_id>:<new_slippage_bps>
 *   lcint:decline:<order_id>
 *   lcint:cancel:<order_id>
 *
 * Security model:
 *
 *   1. Ownership — the order MUST belong to the user that pressed the
 *      button. We re-derive user_id from ctx.from.id and require the
 *      UPDATE to match. A leaked screenshot of a keyboard cannot be
 *      replayed by a different account because the callback runs
 *      WHERE user_id = ctx.from.id.
 *
 *   2. State-machine guard — the UPDATE only fires WHERE
 *      status = 'awaiting_user' AND intervention_state = 'requested'.
 *      If the order already advanced (engine consumed an earlier
 *      approval; cron timed out; user pressed twice), the UPDATE is
 *      a no-op and we tell the user "your decision already settled."
 *
 *   3. Slippage bounds — even though the engine computed the
 *      suggested_slippage_bps and put it in the callback data, the
 *      bot REVERIFIES against the engine's saved suggestion in the
 *      row (intervention_suggested_slippage_bps) before applying.
 *      A tampered callback payload (e.g. "approve:order:9999") gets
 *      rejected because the value won't match.
 *
 *   4. Schema CHECK is the final backstop — slippage_bps is constrained
 *      to (10, 1000). Even if 1 and 2 and 3 all failed, the DB UPDATE
 *      with slippage_bps=5000 fails.
 */
import { query } from "../db/pool.js";

const PATTERN = /^lcint:(approve|decline|cancel):(\d+)(?::(\d+))?$/;

export function registerLimitCloseInterventionCallbacks(bot) {
  bot.callbackQuery(/^lcint:/, async (ctx) => {
    const data = ctx.callbackQuery?.data || "";
    const m = data.match(PATTERN);
    if (!m) {
      await ctx.answerCallbackQuery({ text: "Invalid action.", show_alert: false });
      return;
    }
    const [, action, orderIdStr, slippageStr] = m;
    const orderId = Number(orderIdStr);
    const tgUserId = ctx.from?.id;
    if (!tgUserId || !Number.isInteger(orderId)) {
      await ctx.answerCallbackQuery({ text: "Couldn't identify the order." });
      return;
    }

    // Find the order + verify ownership in a single statement.
    const { rows: [order] } = await query(
      `SELECT lc.id, lc.status, lc.intervention_state, lc.user_id,
              lc.slippage_bps, lc.max_slippage_bps_cap,
              lc.intervention_suggested_slippage_bps,
              u.telegram_id
         FROM limit_close_orders lc
         JOIN users u ON u.id = lc.user_id
        WHERE lc.id = $1 AND u.telegram_id = $2`,
      [orderId, String(tgUserId)],
    );
    if (!order) {
      await ctx.answerCallbackQuery({ text: "Order not found or not yours.", show_alert: true });
      return;
    }
    if (order.status !== "awaiting_user" || order.intervention_state !== "requested") {
      await ctx.answerCallbackQuery({
        text: "This decision already settled.",
        show_alert: true,
      });
      try {
        await ctx.editMessageReplyMarkup({});
      } catch { /* keyboard already gone */ }
      return;
    }

    if (action === "approve") {
      const requested = Number(slippageStr);
      // Defense-in-depth #3 — the suggested_slippage_bps in the callback
      // must match what the engine wrote into the row at intervention
      // request time. Catches a tampered keyboard payload.
      if (
        !Number.isInteger(requested) ||
        requested !== order.intervention_suggested_slippage_bps
      ) {
        await ctx.answerCallbackQuery({
          text: "Suggestion changed since this prompt was sent. Tap /limitorders to see current state.",
          show_alert: true,
        });
        return;
      }
      // Hard ceiling guard, mirroring the engine's INTERVENTION_HARD_CEILING_BPS.
      // The CHECK constraint on slippage_bps also enforces (10, 1000), so
      // this is belt-and-suspenders.
      if (requested < 10 || requested > 1000) {
        await ctx.answerCallbackQuery({ text: "Out-of-range slippage." });
        return;
      }
      // Apply: bump BOTH slippage_bps and max_slippage_bps_cap (cap
      // widens to the same value — explicit borrower consent at this
      // moment is what authorizes the widening). The state transition
      // back to 'armed' will happen in the engine's
      // consumeApprovedInterventions sweep.
      const r = await query(
        `UPDATE limit_close_orders
            SET slippage_bps = $2,
                max_slippage_bps_cap = GREATEST($2, COALESCE(max_slippage_bps_cap, $2)),
                intervention_state = 'approved',
                intervention_response = 'approve',
                intervention_response_at = NOW()
          WHERE id = $1
            AND user_id = $3
            AND status = 'awaiting_user'
            AND intervention_state = 'requested'
          RETURNING id`,
        [orderId, requested, order.user_id],
      );
      if (r.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Couldn't apply (race). Tap /limitorders to see status.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: `Approved — will retry at ${(requested / 100).toFixed(1)}% slippage.` });
      try {
        await ctx.editMessageReplyMarkup({});
        await ctx.editMessageText(
          `Order #${orderId} — approved widening to *${(requested / 100).toFixed(2)}%*.\n\nThe engine will retry at the new slippage on its next tick.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* edit failed — not critical */ }
      return;
    }

    if (action === "decline") {
      const r = await query(
        `UPDATE limit_close_orders
            SET status = 'armed',
                intervention_state = 'declined',
                intervention_response = 'decline',
                intervention_response_at = NOW()
          WHERE id = $1
            AND user_id = $2
            AND status = 'awaiting_user'
            AND intervention_state = 'requested'
          RETURNING id`,
        [orderId, order.user_id],
      );
      if (r.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Couldn't apply (race)." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Will keep trying at your original cap." });
      try {
        await ctx.editMessageReplyMarkup({});
        await ctx.editMessageText(
          `Order #${orderId} — waiting for deeper liquidity at your original cap. I'll DM again if the same condition reappears.`,
        );
      } catch {}
      return;
    }

    if (action === "cancel") {
      const r = await query(
        `UPDATE limit_close_orders
            SET status = 'cancelled',
                intervention_state = 'declined',
                intervention_response = 'cancel',
                intervention_response_at = NOW(),
                cancellation_reason = 'user_intervention_cancel'
          WHERE id = $1
            AND user_id = $2
            AND status = 'awaiting_user'
            AND intervention_state = 'requested'
          RETURNING id`,
        [orderId, order.user_id],
      );
      if (r.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Couldn't cancel (race)." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Order cancelled." });
      try {
        await ctx.editMessageReplyMarkup({});
        await ctx.editMessageText(
          `Order #${orderId} — cancelled. Your loan is unchanged.`,
        );
      } catch {}
      return;
    }
  });
}
