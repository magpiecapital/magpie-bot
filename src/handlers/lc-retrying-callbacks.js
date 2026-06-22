/**
 * Callback handler for the "we're auto-retrying" inline keyboard.
 *
 * The engine DMs the user the first time slippage auto-escalates on an
 * order (limit_close_retrying notification). The DM has one button:
 *
 *   - "Cancel this order" → lcret:cancel:<order_id>
 *
 * Lets the user bail mid-retry if they no longer want the engine to keep
 * escalating toward their cap. The cancel path is identical to the
 * staleness-nudge cancel: scoped to the owning user, idempotent against
 * already-cancelled rows, hard-fails if the order belongs to someone
 * else.
 */
import { query } from "../db/pool.js";
import { cancelOrder } from "../services/limit-close-arm-core.js";

export function registerLcRetryingCallbacks(bot) {
  bot.callbackQuery(/^lcret:cancel:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const tgUserId = ctx.from.id;
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
      reason: "user_bailed_during_retry",
    });
    if (!result.ok) {
      return ctx.answerCallbackQuery({
        text: result.error === "not_cancellable_or_not_found"
          ? "Order already fired, cancelled, or not yours."
          : `Cancel failed: ${result.error}`,
        show_alert: true,
      });
    }
    await ctx.answerCallbackQuery({ text: "Cancelled.", show_alert: false });
    try {
      await ctx.editMessageText(
        `Order #${orderId} cancelled mid-retry. Your loan is unchanged — set a fresh order with /limitclose any time.`,
        { parse_mode: "Markdown" },
      );
    } catch { /* edit may fail on stale messages — silent */ }
  });
}
