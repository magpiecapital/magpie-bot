/**
 * /notify — show and toggle per-user notification preferences.
 *
 * Each inline-keyboard button toggles one boolean pref; the callback handler
 * then redraws the message so the user sees the new state immediately.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { getPrefs, togglePref } from "../services/prefs.js";

const PREFS = [
  { key: "notify_deposits",      label: "Deposit alerts" },
  { key: "notify_loan_warnings", label: "24h loan-due warnings" },
  { key: "notify_health",        label: "Progressive health alerts" },
  { key: "notify_liquidations",  label: "Liquidation receipts" },
  { key: "notify_pump",          label: "🚀 Pump alerts (3x / 5x / 10x bag)" },
  { key: "notify_upside_alerts", label: "Take-profit nudges when collateral 1.5x / 2x / 3x's" },
  { key: "notify_downside_alerts", label: "Derisk nudges when collateral drops -20% / -35% / -50%" },
  { key: "auto_repay",           label: "Auto-repay on SOL deposit" },
  { key: "auto_protect",         label: "🛡 Auto-Protect (anti-liquidation)" },
];

function render(prefs) {
  const kb = new InlineKeyboard();
  const lines = ["🔔 *Notification preferences*", ""];
  for (const p of PREFS) {
    const on = prefs[p.key];
    lines.push(`${on ? "✅" : "⭕️"} ${p.label}`);
    kb.text(`${on ? "Disable" : "Enable"}: ${p.label}`, `notify:toggle:${p.key}`).row();
  }
  lines.push("", "_Auto-repay: if on, a SOL deposit that covers the soonest-due loan pays it off automatically._");
  return { text: lines.join("\n"), kb };
}

export async function handleNotify(ctx) {
  const user = await upsertUser(ctx.from.id, ctx.from.username);
  const prefs = await getPrefs(user.id);
  const { text, kb } = render(prefs);
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerNotifyCallbacks(bot) {
  bot.callbackQuery(/^notify:toggle:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    try {
      const newValue = await togglePref(user.id, key);
      const prefs = await getPrefs(user.id);
      const { text, kb } = render(prefs);
      await ctx.answerCallbackQuery(newValue ? "Enabled" : "Disabled");
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
    } catch (err) {
      await ctx.answerCallbackQuery(`Error: ${err.message}`);
    }
  });

  // One-tap mute button on every "Your bag is pumping!" alert — sets
  // notify_pump to false. Re-enable any time via /notify.
  bot.callbackQuery("pump:mute", async (ctx) => {
    try {
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      const cur = await getPrefs(user.id);
      if (cur.notify_pump) {
        await togglePref(user.id, "notify_pump");
      }
      await ctx.answerCallbackQuery({
        text: "🔕 Pump alerts muted. Re-enable via /notify any time.",
        show_alert: true,
      });
      // Edit the alert message to reflect the muted state instead of
      // leaving the dead button visible.
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [[{ text: "🔕 Pump alerts muted", callback_data: "pump:already-muted" }]] },
        });
      } catch { /* edit may fail if msg too old — silent */ }
    } catch (err) {
      await ctx.answerCallbackQuery(`Error: ${err.message?.slice(0, 100)}`);
    }
  });
  bot.callbackQuery("pump:already-muted", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Already muted. /notify to re-enable.", show_alert: true });
  });
}
