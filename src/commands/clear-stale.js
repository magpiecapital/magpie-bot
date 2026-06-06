/**
 * /clearstale — close support tickets that have been awaiting_user
 * for 30+ days. Cleans up the backlog of "AI replied, user never came
 * back" cases so /tickets stays useful.
 *
 * Conservative: only touches tickets in 'awaiting_user' status, never
 * 'open' (those are waiting on the team, not the user). DMs each
 * affected user so they know the ticket was archived but can reopen
 * via /support if they still need help.
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

export async function handleClearStale(ctx) {
  if (!(await requireAdmin(ctx))) return;

  // Default 30 days; allow /clearstale 60 etc.
  const arg = (ctx.message?.text || "").split(/\s+/)[1];
  const days = Number(arg) || 30;
  if (!Number.isFinite(days) || days < 7 || days > 365) {
    return ctx.reply("Usage: `/clearstale [days]` (default 30, min 7, max 365)", { parse_mode: "Markdown" });
  }

  const { rows: targets } = await query(
    `SELECT s.id, u.telegram_id
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'awaiting_user'
        AND s.admin_replied_at < NOW() - ($1 || ' days')::interval
      ORDER BY s.admin_replied_at ASC`,
    [String(days)],
  );

  if (targets.length === 0) {
    return ctx.reply(`No stale tickets older than ${days}d.`);
  }

  let closed = 0;
  let dmFails = 0;
  for (const t of targets) {
    try {
      const { rowCount } = await query(
        `UPDATE support_tickets
            SET status = 'closed', closed_at = NOW()
          WHERE id = $1 AND status = 'awaiting_user'`,
        [t.id],
      );
      if (rowCount > 0) closed++;
    } catch (err) {
      console.warn("[clearstale] update failed:", err.message);
      continue;
    }
    try {
      await ctx.api.sendMessage(
        Number(t.telegram_id),
        [
          `🗂 *Ticket #${t.id} auto-archived*`,
          "",
          `We hadn't heard back in ${days}+ days so the ticket is closed. If you still need help, just run /support to open a fresh one.`,
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    } catch {
      dmFails++;
    }
  }

  await ctx.reply(
    [
      `🧹 *Stale-ticket cleanup done*`,
      "",
      `Closed: ${closed}`,
      `DMs delivered: ${closed - dmFails}`,
      dmFails > 0 ? `DM failures: ${dmFails} (blocked / deactivated)` : null,
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" },
  );
}
