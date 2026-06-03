/**
 * User-facing ticket commands.
 *
 * /mytickets — list the user's tickets with status + age.
 *
 * Inline buttons on each open/awaiting-user ticket:
 *   ✅ Resolved   — closes the ticket
 *   💬 Follow up  — appends a message and reopens for admin
 *
 * The follow-up flow uses a `pending` map (chat.id → state) so the
 * next text message from the user gets routed back to the ticket.
 * Same defensive registration order as /import and /support — text
 * middleware must claim the message before /borrow or /withdraw.
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { upsertUser } from "../services/users.js";

const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? Number(process.env.ADMIN_TG_ID) : null;

// chat.id → { stage: "await_followup", ticketId, userId }
const pending = new Map();

// Exported so sibling flows can clear our state defensively.
export function clearPending(chatId) {
  pending.delete(chatId);
}

function statusBadge(status) {
  if (status === "open") return "🟡 Open · awaiting team";
  if (status === "awaiting_user") return "💬 Team replied · your turn";
  if (status === "closed") return "✅ Closed";
  return status;
}

function ageStr(date) {
  if (!date) return "";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

export async function handleMyTickets(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT id, message, status, admin_reply, admin_replied_at,
            last_user_followup_at, followup_count, closed_at, created_at
     FROM support_tickets
     WHERE user_id = $1
     ORDER BY status = 'closed' ASC, created_at DESC
     LIMIT 10`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply(
      [
        "📭 *No tickets yet*",
        "",
        "If you need to reach the team, use /support → *Open a ticket*.",
        "",
        "For most questions, the AI agent in /support can help you faster.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  const open = rows.filter((r) => r.status === "open").length;
  const waiting = rows.filter((r) => r.status === "awaiting_user").length;
  const closed = rows.filter((r) => r.status === "closed").length;

  const header = [
    "🎫 *Your tickets*",
    "",
    `Open: ${open} · Replied (your turn): ${waiting} · Closed: ${closed}`,
  ].join("\n");

  await ctx.reply(header, { parse_mode: "Markdown" });

  // Render each ticket as its own card so we can attach action buttons.
  for (const t of rows) {
    const lines = [
      `*Ticket #${t.id}* · ${statusBadge(t.status)}`,
      "",
      `Opened: ${ageStr(t.created_at)}`,
    ];
    if (t.admin_replied_at) {
      lines.push(`Team last replied: ${ageStr(t.admin_replied_at)}`);
    }
    if (t.followup_count > 0) {
      lines.push(`Your follow-ups: ${t.followup_count}`);
    }
    if (t.closed_at) {
      lines.push(`Closed: ${ageStr(t.closed_at)}`);
    }
    lines.push("");
    lines.push(`_Your message:_ ${(t.message || "").slice(0, 200)}`);
    if (t.admin_reply) {
      lines.push("");
      lines.push(`_Team reply:_ ${(t.admin_reply || "").slice(0, 300)}`);
    }

    const kb = new InlineKeyboard();
    if (t.status === "awaiting_user" || t.status === "open") {
      kb.text("💬 Follow up", `myt:followup:${t.id}`).row()
        .text("✅ Mark resolved", `myt:close:${t.id}`);
    }

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: kb.text.length || kb.inline_keyboard?.length ? kb : undefined,
    }).catch(() => {
      // Markdown parse fallback (user message text could break Markdown)
      return ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), {
        reply_markup: kb,
      });
    });
  }
}

export function registerMyTicketsCallbacks(bot) {
  bot.callbackQuery(/^myt:followup:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ticketId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    // Verify ownership
    const { rows: [t] } = await query(
      `SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`,
      [ticketId, user.id],
    );
    if (!t) return ctx.reply("That ticket isn't yours.");
    if (t.status === "closed") return ctx.reply("That ticket is closed. Open a new one via /support.");

    pending.set(ctx.chat.id, { stage: "await_followup", ticketId, userId: user.id });
    await ctx.reply(
      [
        `💬 *Follow-up to ticket #${ticketId}*`,
        "",
        "Type your message — it'll be added to the ticket and the team will be notified.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery(/^myt:close:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Marking resolved…");
    const ticketId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { rowCount } = await query(
      `UPDATE support_tickets
          SET status = 'closed', closed_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status != 'closed'`,
      [ticketId, user.id],
    );
    if (rowCount === 0) {
      return ctx.reply("Couldn't close — either it's not yours or it was already closed.");
    }
    await ctx.reply(`✅ Ticket #${ticketId} marked resolved. Thanks!`);
    // Silent — admin will see it as 'closed' next time they run /tickets.
    // No DM to avoid notification noise on routine self-resolutions.
  });

  // Text middleware for the follow-up flow.
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || state.stage !== "await_followup") return next();
    pending.delete(ctx.chat.id);

    const followup = (ctx.message.text || "").trim();
    if (followup.length === 0) return ctx.reply("Empty message — try again via /mytickets.");

    // Append to ticket: bump status to 'open' (admin's turn), append message,
    // increment followup_count, clear any prior alerted tier so it can re-alert.
    const { rows: [t] } = await query(
      `UPDATE support_tickets
          SET status = 'open',
              message = COALESCE(message, '') || E'\n\n[follow-up ' || (followup_count + 1) || ']: ' || $2,
              last_user_followup_at = NOW(),
              followup_count = followup_count + 1,
              last_alerted_tier = NULL
        WHERE id = $1 AND user_id = $3
        RETURNING id, followup_count`,
      [state.ticketId, followup, state.userId],
    );
    if (!t) return ctx.reply("Couldn't save follow-up — try /mytickets again.");

    await ctx.reply(
      `✅ Follow-up added to ticket *#${t.id}*. The team will be notified.`,
      { parse_mode: "Markdown" },
    );

    // DM admin
    if (ADMIN_TG_ID) {
      try {
        const fromTag = ctx.from.username ? `@${ctx.from.username}` : `tg://${ctx.from.id}`;
        await ctx.api.sendMessage(
          ADMIN_TG_ID,
          [
            `💬 *Ticket #${t.id} reopened by user follow-up*`,
            "",
            `From: ${fromTag}`,
            `Follow-up #${t.followup_count}:`,
            "",
            followup.slice(0, 500),
            "",
            `Reply with: \`/reply ${t.id} <message>\``,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      } catch {}
    }
  });
}
