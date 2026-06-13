/**
 * Callback handlers for the order-staleness nudge inline keyboard.
 *
 * The watcher DMs the user with two buttons:
 *   - "Keep active"  → lcstale:keep:<order_id>
 *   - "Cancel order" → lcstale:cancel:<order_id>
 *
 * Both paths are scoped to the order's owning user — we re-derive the
 * user from the callback's from.id and require it to match the order's
 * user_id. Defense in depth: tg user_id is the load-bearing identity,
 * the callback data is just the order id.
 */
import { query } from "../db/pool.js";
import { cancelOrder } from "../services/limit-close-arm-core.js";

export function registerLcStalenessCallbacks(bot) {
  bot.callbackQuery(/^lcstale:keep:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const tgUserId = ctx.from.id;
    // Verify the order belongs to this TG user before responding.
    const { rows: [own] } = await query(
      `SELECT o.id, o.status
         FROM limit_close_orders o
         JOIN users u ON u.id = o.user_id
        WHERE o.id = $1 AND u.telegram_id = $2`,
      [orderId, String(tgUserId)],
    );
    if (!own) {
      return ctx.answerCallbackQuery({ text: "Not your order.", show_alert: true });
    }
    if (own.status !== "armed") {
      return ctx.answerCallbackQuery({ text: `Order already ${own.status}.`, show_alert: false });
    }
    await ctx.answerCallbackQuery({ text: "Kept active.", show_alert: false });
    try {
      await ctx.editMessageText(
        `Order #${orderId} kept active. We won't bug you again for another month.`,
        { parse_mode: "Markdown" },
      );
    } catch { /* edit may fail on old messages — silent ok */ }
  });

  bot.callbackQuery(/^lcstale:cancel:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const tgUserId = ctx.from.id;
    // Resolve the user_id (the cancelOrder helper takes user_id, not tg_id).
    const { rows: [u] } = await query(
      `SELECT id FROM users WHERE telegram_id = $1`,
      [String(tgUserId)],
    );
    if (!u) {
      return ctx.answerCallbackQuery({ text: "Account not recognized.", show_alert: true });
    }
    const result = await cancelOrder({
      orderId,
      userId: u.id,
      reason: "staleness_nudge_cancel",
    });
    if (!result.ok) {
      return ctx.answerCallbackQuery({
        text: result.error === "not_cancellable_or_not_found"
          ? "Order is not cancellable (already fired, expired, or not yours)."
          : `Cancel failed: ${result.error}`,
        show_alert: true,
      });
    }
    await ctx.answerCallbackQuery({ text: "Cancelled.", show_alert: false });
    try {
      await ctx.editMessageText(
        `Order #${orderId} cancelled. Your loan is unchanged — set a fresh order any time with /limitclose.`,
        { parse_mode: "Markdown" },
      );
    } catch { /* silent */ }
  });
}
