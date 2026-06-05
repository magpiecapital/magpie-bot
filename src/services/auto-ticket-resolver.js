/**
 * Auto-Ticket Resolver — the AI handles stale tickets, NOT admin.
 *
 * Every 30 min, pulls tickets that are:
 *   • status = 'open' (waiting for admin reply)
 *   • older than 30 min
 *   • not already auto-resolved
 *   • NOT a critical-reason ticket (security_incident / bug_report —
 *     those genuinely need admin judgment, not another AI pass)
 *
 * For each, feeds the original message into the AI agent (with the
 * full user-context snapshot so it knows their loan state). The AI's
 * response is sent to the user via the same DM template /reply uses,
 * the ticket is marked status='awaiting_user' with admin_reply set
 * to the AI's response, and auto_resolved_at is stamped.
 *
 * Net effect: stale tickets get answered autonomously. Admin only
 * sees tickets that:
 *   (a) are flagged critical (security/bug) — DM'd at creation
 *   (b) cross 24h+ even after AI auto-resolution attempted — true
 *       dead-letter cases
 *
 * Cost: each auto-resolution is one AI agent invocation (~$0.005-0.02).
 * Capped at MAX_PER_TICK to control burst spend.
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { chatWithAgent, resetConversation, isAiSupportEnabled } from "./ai-support.js";
import { getAdminId } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.AUTO_RESOLVER_POLL_MS) || 15 * 60 * 1000; // 15 min — tighter cadence so follow-ups don't sit
const MIN_TICKET_AGE_MS = 30 * 60 * 1000;          // 30 min — give live response time on FIRST ticket
const MIN_FOLLOWUP_AGE_MS = 3 * 60 * 1000;          // 3 min — follow-ups already have an AI thread, engage fast
const MAX_PER_TICK = 5;                             // cap burst spend at ~$0.10/tick
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;          // 5 min after boot
// After this many user follow-ups with no resolution, escalate to admin
// rather than have the AI keep trying. The AI clearly isn't cracking it.
const DEAD_LETTER_FOLLOWUP_COUNT = 3;

// Reasons we do NOT auto-resolve — these genuinely need a human.
const SKIP_REASONS = [
  "security_incident",
  "bug_report",
  "refund_request",
];

function isSkippableTicket(message) {
  if (!message) return false;
  // The AI stores the reason in the message body as "Reason: <kind>"
  return SKIP_REASONS.some((r) => message.includes(`Reason: ${r}`));
}

// Strip the "[AI-escalated] Reason: ... · What AI tried: ..." wrappers
// from a ticket message so the AI gets the original user complaint clean.
function unwrapTicketMessage(message) {
  if (!message) return "";
  // Common prefix from the AI-escalation tool: "[AI-escalated] <summary>\n
  // What AI tried: ...\nReason: ..."
  // We want just the original user content. The "summary" line is the
  // best proxy — that's the AI's one-line synopsis of what the user asked.
  if (message.startsWith("[AI-escalated]")) {
    // Take the first line after the prefix; that's the AI's summary of
    // what the user asked.
    const firstLine = message
      .replace(/^\[AI-escalated\]\s*/, "")
      .split("\n")[0]
      .trim();
    return firstLine || message;
  }
  // Manual ticket — message is the user's verbatim text. Use as-is but
  // strip any "[follow-up N]" prefixes that user-followup adds.
  return message;
}

async function resolveTicket(bot, ticket) {
  const cleanMessage = unwrapTicketMessage(ticket.message);
  if (!cleanMessage) return { ok: false, reason: "empty_message" };

  // Reset the user's conversation so the AI starts fresh on THIS
  // ticket — don't get cross-contamination from old chat state.
  try {
    await resetConversation(ticket.user_id);
  } catch { /* non-critical */ }

  // Frame the prompt to the AI as a delayed reply ("you opened this
  // earlier — here's a fresh look"). The AI's user snapshot will
  // surface their current state automatically.
  const prompt = `(System note — you're being invoked to FOLLOW UP on a support ticket the user filed earlier. Re-read their question with fresh eyes + current account state, and give your best resolution. Be warm but get to the substance. Don't say "since you filed your ticket" — just answer it. Their original question:)\n\n${cleanMessage}`;

  let result;
  try {
    result = await chatWithAgent(ticket.user_id, prompt, {
      username: ticket.telegram_username,
    });
  } catch (err) {
    return { ok: false, reason: `agent_error: ${err.message?.slice(0, 100)}` };
  }
  if (!result || !result.text) return { ok: false, reason: "agent_no_response" };

  // If the AI itself escalated (security_incident, etc.) → the original
  // ticket already exists, we don't want a duplicate. The AI's
  // open_support_ticket tool creates a new ticket on escalation; if it
  // did so, the new ticket has status='open' and we should let the
  // normal critical-ticket DM flow take over. So just keep the original
  // ticket as-is and post the AI's response to the user.
  const aiOpenedNewTicket = !!result.escalated_ticket_id;

  // DM the user with the AI's response — using the same template as /reply.
  const kb = new InlineKeyboard()
    .text("💬 Follow up", `myt:followup:${ticket.id}`)
    .text("✅ Resolved", `myt:close:${ticket.id}`);

  try {
    await bot.api.sendMessage(
      Number(ticket.telegram_id),
      [
        `📩 *Magpie support · Ticket #${ticket.id}*`,
        "",
        result.text,
        "",
        "_Was this helpful? Tap a button below — or run /mytickets any time._",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  } catch (err) {
    // If we can't DM the user (blocked the bot, etc.), close as
    // unreachable rather than leaving the ticket stale forever.
    if (/blocked|deactivated|chat not found/i.test(err.message || "")) {
      await query(
        `UPDATE support_tickets SET status='closed', closed_at=NOW(),
            auto_resolved_at=NOW(),
            admin_reply='[auto] user unreachable (bot blocked / chat deleted)'
         WHERE id=$1`,
        [ticket.id],
      );
      return { ok: true, action: "closed_unreachable" };
    }
    return { ok: false, reason: `dm_failed: ${err.message?.slice(0, 100)}` };
  }

  // Update ticket: AI replied → ball is in user's court
  await query(
    `UPDATE support_tickets
        SET status = 'awaiting_user',
            admin_reply = $2,
            admin_replied_at = NOW(),
            auto_resolved_at = NOW(),
            last_alerted_tier = NULL
      WHERE id = $1`,
    [ticket.id, "[auto-resolved by agent]\n\n" + result.text.slice(0, 2000)],
  );

  return { ok: true, action: "resolved", aiOpenedNewTicket };
}

async function escalateToAdmin(bot, ticket) {
  const adminId = getAdminId();
  if (!adminId) return;
  const fromTag = ticket.telegram_username ? `@${ticket.telegram_username}` : `tg://${ticket.telegram_id}`;
  try {
    await bot.api.sendMessage(
      adminId,
      [
        `🆘 *Ticket #${ticket.id} — AI couldn't resolve after ${ticket.followup_count} follow-ups*`,
        "",
        `From: ${fromTag}`,
        `User has followed up ${ticket.followup_count} times. The AI tried each time but didn't satisfy them.`,
        "",
        "Latest user message:",
        "",
        (ticket.message || "").split("\n").slice(-6).join("\n").slice(-800),
        "",
        `Reply with: \`/reply ${ticket.id} <message>\``,
        `Or close: \`/close ${ticket.id}\``,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    // Mark as escalated so we don't keep pinging admin every tick
    await query(
      `UPDATE support_tickets SET last_alerted_tier = 99 WHERE id = $1`,
      [ticket.id],
    );
    console.log(`[auto-resolver] #${ticket.id} escalated to admin (${ticket.followup_count} follow-ups, AI gave up)`);
  } catch (err) {
    console.warn("[auto-resolver] admin escalation DM failed:", err.message);
  }
}

async function tick(bot) {
  if (!isAiSupportEnabled()) {
    console.log("[auto-resolver] AI agent disabled — skipping");
    return;
  }
  if (!bot) return;

  // Pull tickets that need an AI pass. Two cases:
  //   (a) Never auto-resolved AND created_at older than MIN_TICKET_AGE_MS
  //       → first-time resolution
  //   (b) Already auto-resolved BUT user followed up since the last AI
  //       reply AND that follow-up is older than MIN_FOLLOWUP_AGE_MS
  //       → re-engage on follow-up
  // followup_count >= DEAD_LETTER_FOLLOWUP_COUNT → escalate to admin
  // and don't let the AI try again (it's clearly missing something).
  const firstCutoff = new Date(Date.now() - MIN_TICKET_AGE_MS).toISOString();
  const followupCutoff = new Date(Date.now() - MIN_FOLLOWUP_AGE_MS).toISOString();

  let candidates;
  try {
    const { rows } = await query(
      `SELECT s.id, s.user_id, s.message, s.created_at, s.followup_count,
              s.auto_resolved_at, s.last_user_followup_at, s.admin_replied_at,
              s.last_alerted_tier,
              u.telegram_id, u.telegram_username
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'open'
         AND (
           -- First-time resolution path
           (s.auto_resolved_at IS NULL AND s.created_at < $1)
           OR
           -- Follow-up re-engagement path
           (s.auto_resolved_at IS NOT NULL
             AND s.last_user_followup_at IS NOT NULL
             AND s.last_user_followup_at > COALESCE(s.admin_replied_at, s.created_at)
             AND s.last_user_followup_at < $2)
         )
       ORDER BY COALESCE(s.last_user_followup_at, s.created_at) ASC
       LIMIT $3`,
      [firstCutoff, followupCutoff, MAX_PER_TICK * 3],
    );
    candidates = rows;
  } catch (err) {
    console.error("[auto-resolver] DB query failed:", err.message);
    return;
  }

  const eligible = candidates.filter((t) => !isSkippableTicket(t.message));
  if (eligible.length === 0) {
    if (candidates.length > 0) {
      console.log(`[auto-resolver] ${candidates.length} stale ticket(s), all critical-reason — left for admin`);
    }
    return;
  }

  console.log(`[auto-resolver] ${eligible.length} eligible ticket(s), processing up to ${MAX_PER_TICK}`);
  let resolved = 0;
  let escalated = 0;
  let failed = 0;
  for (const t of eligible.slice(0, MAX_PER_TICK)) {
    // Dead-letter: AI has tried too many times — escalate, don't retry.
    if ((t.followup_count ?? 0) >= DEAD_LETTER_FOLLOWUP_COUNT && t.last_alerted_tier !== 99) {
      await escalateToAdmin(bot, t);
      escalated++;
      continue;
    }
    if ((t.followup_count ?? 0) >= DEAD_LETTER_FOLLOWUP_COUNT) {
      // Already escalated — skip silently
      continue;
    }
    try {
      const r = await resolveTicket(bot, t);
      if (r.ok) {
        resolved++;
        console.log(`[auto-resolver] #${t.id} ${r.action}` + (t.auto_resolved_at ? " (follow-up)" : ""));
      } else {
        failed++;
        console.warn(`[auto-resolver] #${t.id} failed: ${r.reason}`);
      }
    } catch (err) {
      failed++;
      console.error(`[auto-resolver] #${t.id} threw:`, err.message);
    }
    await new Promise((res) => setTimeout(res, 750));
  }
  console.log(`[auto-resolver] tick done: ${resolved} resolved, ${escalated} escalated, ${failed} failed`);
}

export function startAutoTicketResolver(bot) {
  console.log(`[auto-resolver] Starting (every ${POLL_INTERVAL_MS / 60_000}min, first run in ${FIRST_RUN_DELAY_MS / 60_000}min)`);
  setTimeout(() => tick(bot), FIRST_RUN_DELAY_MS);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}
