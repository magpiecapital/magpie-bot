/**
 * Support vigil — close the awaiting_user gap.
 *
 * The auto-ticket-resolver auto-replies to stale tickets and flips them
 * to status='awaiting_user'. If the user doesn't acknowledge, the
 * ticket sits there forever. Operator-stated rule: "No cases should go
 * unanswered or unsolved."
 *
 * Lifecycle this vigil enforces:
 *
 *   awaiting_user (AI just replied)
 *      │
 *      ├─ +24h, no user reply → Pip-side DM #1 ("Did this resolve?")
 *      │
 *      ├─ +96h total, no user reply → Pip-side DM #2 ("Still working on this?")
 *      │
 *      └─ +7d total, no user reply → auto-close with thanks note
 *
 * Inline-keyboard responses on each follow-up:
 *   "Yes, resolved"  → close ticket immediately
 *   "Still need help" → reopen as status='open' (admin gets it)
 *   (no response)    → vigil continues to next tier
 *
 * Cap: at most 2 Pip-side DMs per ticket. After the second silence
 * window the ticket auto-closes (anything beyond is harassment).
 *
 * Security model:
 *   - Read/write scope is support_tickets only
 *   - Callback handlers re-verify ticket ownership via user_id == tg.from.id
 *     before mutating
 *   - Auto-close writes admin_reply='[auto] closed after no response'
 *     so the audit trail is unambiguous
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";

const TICK_MS = 30 * 60_000;  // 30 min — finer than the aging watcher because we have more tier transitions

// Tiers in hours since admin_replied_at. Each tier is processed at
// most once per ticket via pip_followup_count.
const TIERS = [
  {
    pipFollowupCount: 0,  // user-facing: this is the FIRST followup
    hours: 24,
    text: (msg) =>
      [
        "*Pip checking in.*",
        "",
        "I auto-replied to your support ticket about a day ago. Just confirming — did that resolve your issue?",
        "",
        `> _${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}_`,
        "",
        "Tap below or use /support to open a new ticket if anything else came up.",
      ].join("\n"),
  },
  {
    pipFollowupCount: 1,  // SECOND followup
    hours: 96,
    text: (msg) =>
      [
        "*Pip again — last check.*",
        "",
        "Wanted to make sure your earlier ticket is fully sorted out before I close it.",
        "",
        `> _${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}_`,
        "",
        "If you still need a hand, tap *Still need help* below and I'll loop a human in. Otherwise I'll close it on my next pass.",
      ].join("\n"),
  },
];
const AUTO_CLOSE_HOURS = 7 * 24;  // 168h — final silence window

function keyboardFor(ticketId) {
  return new InlineKeyboard()
    .text("Yes, resolved", `svigil:resolved:${ticketId}`)
    .row()
    .text("Still need help", `svigil:reopen:${ticketId}`);
}

async function sendFollowup(bot, ticket, tier) {
  if (!ticket.telegram_id) return { ok: false, reason: "no_telegram_id" };
  try {
    await bot.api.sendMessage(
      Number(ticket.telegram_id),
      tier.text(ticket.message || "your earlier issue"),
      { parse_mode: "Markdown", reply_markup: keyboardFor(ticket.id) },
    );
    await query(
      `UPDATE support_tickets
          SET last_pip_followup_at = NOW(),
              pip_followup_count = pip_followup_count + 1
        WHERE id = $1`,
      [ticket.id],
    );
    return { ok: true };
  } catch (err) {
    if (/blocked|deactivated|chat not found/i.test(err.message || "")) {
      // User blocked the bot — close as unreachable.
      await query(
        `UPDATE support_tickets
            SET status = 'closed',
                closed_at = NOW(),
                admin_reply = COALESCE(admin_reply, '') || E'\n[vigil] closed: user unreachable'
          WHERE id = $1`,
        [ticket.id],
      );
      return { ok: false, reason: "unreachable_closed" };
    }
    return { ok: false, reason: err.message?.slice(0, 100) };
  }
}

async function autoClose(ticket) {
  await query(
    `UPDATE support_tickets
        SET status = 'closed',
            closed_at = NOW(),
            admin_reply = COALESCE(admin_reply, '') || E'\n[vigil] auto-closed after no response in ${AUTO_CLOSE_HOURS}h'
      WHERE id = $1
        AND status = 'awaiting_user'`,
    [ticket.id],
  );
}

async function tick(bot) {
  if (!bot) return;
  try {
    const { rows } = await query(
      `SELECT st.id, st.user_id, st.message, st.admin_replied_at,
              st.last_pip_followup_at, st.pip_followup_count,
              u.telegram_id,
              EXTRACT(EPOCH FROM (NOW() - st.admin_replied_at))::int AS age_since_reply_secs
         FROM support_tickets st
         JOIN users u ON u.id = st.user_id
        WHERE st.status = 'awaiting_user'
          AND st.admin_replied_at IS NOT NULL`,
    );

    let sent = 0;
    let closed = 0;
    for (const r of rows) {
      const ageHours = Number(r.age_since_reply_secs) / 3600;
      // Auto-close path FIRST (covers tickets that already received
      // their 2 followups and still haven't been acknowledged).
      if (ageHours >= AUTO_CLOSE_HOURS) {
        await autoClose(r);
        closed++;
        continue;
      }
      // Find the next tier this ticket qualifies for. If
      // pip_followup_count = 0, only the first tier; if 1, only the
      // second; if 2+, no more tiers (we wait for the auto-close).
      const tier = TIERS[r.pip_followup_count];
      if (!tier) continue;
      if (ageHours < tier.hours) continue;
      // Don't re-send if we recently DM'd (race protection).
      const lastDmAt = r.last_pip_followup_at ? new Date(r.last_pip_followup_at).getTime() : 0;
      if (Date.now() - lastDmAt < 60 * 60_000) continue;
      const res = await sendFollowup(bot, r, tier);
      if (res.ok) sent++;
    }
    if (sent > 0 || closed > 0) {
      console.log(`[support-vigil] tick sent=${sent} closed=${closed} scanned=${rows.length}`);
    }
  } catch (err) {
    console.error("[support-vigil] tick threw:", err.message);
  }
}

/**
 * Callback handlers for the inline keyboard buttons.
 */
export function registerSupportVigilCallbacks(bot) {
  // Common ownership-verify + parse helper.
  async function loadTicketForUser(ctx, ticketId) {
    const tgId = ctx.from?.id;
    if (!tgId) return null;
    const { rows: [r] } = await query(
      `SELECT st.id, st.status, st.user_id
         FROM support_tickets st
         JOIN users u ON u.id = st.user_id
        WHERE st.id = $1 AND u.telegram_id = $2`,
      [ticketId, String(tgId)],
    );
    return r || null;
  }

  bot.callbackQuery(/^svigil:resolved:(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    const ticket = await loadTicketForUser(ctx, ticketId);
    if (!ticket) {
      await ctx.answerCallbackQuery({ text: "Couldn't find that ticket.", show_alert: true });
      return;
    }
    if (ticket.status === "closed") {
      await ctx.answerCallbackQuery({ text: "Already closed. Thanks." });
      try { await ctx.editMessageReplyMarkup({}); } catch {}
      return;
    }
    await query(
      `UPDATE support_tickets
          SET status = 'closed',
              closed_at = NOW(),
              admin_reply = COALESCE(admin_reply, '') || E'\n[vigil] user confirmed resolved'
        WHERE id = $1`,
      [ticketId],
    );
    await ctx.answerCallbackQuery({ text: "Glad it's sorted." });
    try {
      await ctx.editMessageReplyMarkup({});
      await ctx.editMessageText(
        "Closed. If anything else comes up, /support starts a fresh ticket.",
      );
    } catch {}
  });

  bot.callbackQuery(/^svigil:reopen:(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    const ticket = await loadTicketForUser(ctx, ticketId);
    if (!ticket) {
      await ctx.answerCallbackQuery({ text: "Couldn't find that ticket.", show_alert: true });
      return;
    }
    if (ticket.status === "closed") {
      await ctx.answerCallbackQuery({ text: "That ticket is already closed — /support to open a new one." });
      try { await ctx.editMessageReplyMarkup({}); } catch {}
      return;
    }
    // Reopen — back to 'open' so admin sees it in /tickets and the
    // aging watcher escalates appropriately.
    await query(
      `UPDATE support_tickets
          SET status = 'open',
              last_user_followup_at = NOW(),
              followup_count = followup_count + 1,
              last_alerted_tier = NULL
        WHERE id = $1`,
      [ticketId],
    );
    await ctx.answerCallbackQuery({ text: "Got it — passing this to a human." });
    try {
      await ctx.editMessageReplyMarkup({});
      await ctx.editMessageText(
        "Reopened. The team's on it — you'll hear back here when there's an update.",
      );
    } catch {}
  });
}

let _timer = null;

// Timer-only startup. Callback registration MUST happen separately via
// registerSupportVigilCallbacks(bot) at top-level index.js init — Grammy
// throws if listeners are registered from inside another listener
// execution (e.g. from inside a dynamic-import .then() handler called
// during bot startup). Splitting timer + callbacks lets the runtime
// init flow do the right thing in the right order.
export function startSupportVigil(bot) {
  if (_timer) return;
  console.log(`[support-vigil] armed — probing every ${TICK_MS / 60_000}m`);
  setTimeout(() => {
    tick(bot).catch(() => {});
    _timer = setInterval(() => tick(bot).catch(() => {}), TICK_MS);
  }, 120_000);
}

export function stopSupportVigil() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
