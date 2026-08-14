/**
 * /autoextend — manage opt-in automatic loan extension (strategy doc 18).
 *
 * Shows current opt-in status, recent auto-extend activity, and a toggle.
 * The actual watcher lives in src/services/auto-extend-watcher.js.
 * Mirrors /autoprotect's structure; differs in DEFAULT (off — auto-extend
 * charges a fee, and spending is never default-on).
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
  const on = !!prefs.auto_extend;

  const { rows } = await query(
    `SELECT decision, reason, fee_lamports, tx_signature, created_at, loan_id
     FROM auto_extend_events
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId],
  );

  const lines = [
    `⏱ *Auto-Extend* — ${on ? "✅ Enabled" : "⭕️ Disabled"}`,
    "",
    "If a loan is still open shortly before it expires, I'll",
    "automatically extend it for you — same fee as a manual /extend,",
    "paid from your wallet.",
    "",
    "*How it works:*",
    "• Fires between *2 hours* and *30 minutes* before expiry",
    "• Max *2* automatic extensions per loan, then manual only",
    "• Skipped if your collateral is worth less than what you owe",
    "  (extending would only cost you fees)",
    "• Skipped if your wallet can't cover the fee — you'll be DM'd",
    "• Every action is logged (see below) — never silent",
    "",
    "⚠️ *Why it matters:* once a loan is overdue it can no longer be",
    "extended at all — repayment or liquidation are the only paths.",
    "",
    on
      ? "_Auto-Extend is ON. You'll be DM'd whenever it fires or is skipped._"
      : "_Auto-Extend is OFF (the default — it spends your SOL on fees, so it's strictly opt-in)._",
  ];

  if (rows.length > 0) {
    lines.push("", "*Recent activity (last 14d):*");
    for (const r of rows) {
      const ago = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60_000);
      const agoStr = ago < 60 ? `${ago}m` : ago < 60 * 24 ? `${Math.floor(ago / 60)}h` : `${Math.floor(ago / (60 * 24))}d`;
      let line = `${agoStr} ago — `;
      if (r.decision === "extended") {
        line += `extended loan #${r.loan_id} (fee \`${fmtSol(r.fee_lamports)} SOL\`)`;
      } else if (r.decision === "failed") {
        line += `❌ failed on #${r.loan_id} — extend manually`;
      } else {
        line += `⚠️ skipped #${r.loan_id} (${r.reason.replace(/_/g, " ")})`;
      }
      lines.push(`• ${line}`);
    }
  }

  const kb = new InlineKeyboard().text(
    on ? "🔕 Turn OFF Auto-Extend" : "⏱ Turn ON Auto-Extend",
    "autoextend:toggle",
  );

  return { text: lines.join("\n"), kb };
}

export async function handleAutoExtend(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);
  const { text, kb } = await render(user.id);
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerAutoExtendCallbacks(bot) {
  bot.callbackQuery("autoextend:toggle", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await togglePref(user.id, "auto_extend");
    const { text, kb } = await render(user.id);
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  });
}
