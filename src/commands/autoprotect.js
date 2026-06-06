/**
 * /autoprotect — manage the anti-liquidation feature.
 *
 * Shows current opt-in status, recent auto-protect actions, and a toggle.
 * The actual watcher lives in src/services/auto-protect.js.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { getPrefs, togglePref } from "../services/prefs.js";
import { query } from "../db/pool.js";

function fmtSol(lamports) {
  if (lamports == null) return "—";
  return (Number(lamports) / 1e9).toFixed(4);
}

async function render(userId) {
  const prefs = await getPrefs(userId);
  const on = !!prefs.auto_protect;

  // Recent actions (last 7d) for transparency
  const { rows } = await query(
    `SELECT action_type, amount_lamports, health_before, health_after,
            signature, created_at, loan_id
     FROM auto_protect_actions
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId],
  );

  const lines = [
    `🛡 *Auto-Protect* — ${on ? "✅ Enabled" : "⭕️ Disabled"}`,
    "",
    "Auto-Protect monitors your active loans every 90 seconds.",
    "When a loan's health drops below *1.30x*, I'll automatically",
    "pay it down with your idle SOL to bring it back to *1.50x* (safe).",
    "",
    "*Safety bounds:*",
    "• Max 1 SOL per auto-action",
    "• Max 3 auto-actions per loan per 24h",
    "• Keeps ~0.005 SOL reserve for gas",
    "• Logs every action (see below) — never silent",
    "",
    on
      ? "_Auto-Protect is on (the default). You'll be DM'd when an action fires._"
      : "_You've opted out. You'll get the standard health alerts but no auto-action._",
  ];

  if (rows.length > 0) {
    lines.push("", "*Recent activity (last 7d):*");
    for (const r of rows) {
      const ago = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60_000);
      const agoStr = ago < 60 ? `${ago}m` : ago < 60 * 24 ? `${Math.floor(ago / 60)}h` : `${Math.floor(ago / (60 * 24))}d`;
      let line = `${agoStr} ago — `;
      if (r.action_type === "partial_repay") {
        line += `paid \`${fmtSol(r.amount_lamports)} SOL\` on loan #${r.loan_id} (${r.health_before}→${r.health_after}x)`;
      } else if (r.action_type === "insufficient_funds_warning") {
        line += `⚠️ couldn't act on #${r.loan_id} — not enough idle SOL`;
      } else if (r.action_type === "partial_repay_failed") {
        line += `❌ failed on #${r.loan_id} — retried by watcher`;
      } else {
        line += r.action_type;
      }
      lines.push(`• ${line}`);
    }
  }

  const kb = new InlineKeyboard().text(
    on ? "🔕 Turn OFF Auto-Protect" : "🛡 Turn ON Auto-Protect",
    "autoprotect:toggle",
  );

  return { text: lines.join("\n"), kb };
}

export async function handleAutoProtect(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);
  const { text, kb } = await render(user.id);
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerAutoProtectCallbacks(bot) {
  bot.callbackQuery("autoprotect:toggle", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await togglePref(user.id, "auto_protect");
    const { text, kb } = await render(user.id);
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  });

  bot.callbackQuery("autoprotect:status", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { text, kb } = await render(user.id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  });
}
