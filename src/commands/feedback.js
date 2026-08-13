/**
 * /feedback — operator-only review of captured user replies.
 *
 * Every plain conversational DM that matches no command is stored in
 * user_feedback by the fallback handler (see fallback.js reply-capture). This
 * command surfaces the most recent ones so the operator can read what users —
 * especially winback-campaign responders — actually said, in one place, instead
 * of scrolling through forwarded DMs.
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";

export async function handleFeedback(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is operator-only.");
    return;
  }
  let rows;
  try {
    ({ rows } = await query(
      `SELECT telegram_username, telegram_id, message, created_at
         FROM user_feedback
        ORDER BY created_at DESC
        LIMIT 25`,
    ));
  } catch (e) {
    await ctx.reply(`Couldn't load feedback: ${e.message}`);
    return;
  }
  if (!rows.length) {
    await ctx.reply("No feedback captured yet. Replies to bot DMs will show up here.");
    return;
  }
  const lines = rows.map((r) => {
    const who = r.telegram_username ? "@" + r.telegram_username : `id ${r.telegram_id}`;
    const when = new Date(r.created_at).toISOString().slice(5, 16).replace("T", " ");
    const msg = String(r.message).replace(/\s+/g, " ").slice(0, 220);
    return `• ${when} — ${who}\n  ${msg}`;
  });
  await ctx.reply(
    `📝 Recent feedback (${rows.length} shown, newest first):\n\n${lines.join("\n\n")}`,
    { disable_web_page_preview: true },
  );
}
