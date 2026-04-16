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
  { key: "auto_repay",           label: "Auto-repay on SOL deposit" },
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
}
