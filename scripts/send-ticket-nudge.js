#!/usr/bin/env node
/**
 * Send a "still need help?" nudge to a list of stale tickets.
 *
 * For each ticket:
 *   - Verify it's still in awaiting_user (skip if user already followed up)
 *   - Skip if the user is in banned_users (we don't nudge banned users)
 *   - Send DM with nudge body + Resolved/Follow-up callback buttons
 *   - Bump admin_replied_at (clock reset for the aging watcher)
 *   - Clear last_alerted_tier (lets the watcher re-alert from tier 0
 *     if the user follow-up triggers it later)
 *   - DOES NOT overwrite admin_reply — preserves the original substantive
 *     reply for audit trail.
 *
 * Usage:
 *   node scripts/send-ticket-nudge.js <id1,id2,id3,...>
 *   node scripts/send-ticket-nudge.js --stale  # all awaiting_user >24h
 *   node scripts/send-ticket-nudge.js <ids>... --dry-run
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const dryRun = process.argv.includes("--dry-run");
const useStale = process.argv.includes("--stale");

const NUDGE_BODY = [
  "Hey — circling back on this one.",
  "",
  "We sent you a reply a while ago and haven't heard from you since. Two ways to wrap this up:",
  "",
  "• If your issue is sorted, tap *Resolved* below and we'll close it out.",
  "• If you still need help, tap *Follow up* and tell us what's going on — we'll come back fast.",
  "",
  "Either way, thanks for being patient 🙏",
].join("\n");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not in env");
  process.exit(1);
}

let ticketIds;
if (useStale) {
  const { rows } = await query(
    `SELECT id FROM support_tickets
      WHERE status = 'awaiting_user'
        AND COALESCE(last_user_followup_at, admin_replied_at, created_at) < NOW() - INTERVAL '24 hours'
      ORDER BY id ASC`,
  );
  ticketIds = rows.map((r) => Number(r.id));
} else {
  const idArg = process.argv.find((a) => /^[\d,\s]+$/.test(a) && a.includes(",")) || process.argv[2];
  if (!idArg) {
    console.error("Usage: node scripts/send-ticket-nudge.js <id1,id2,...>  OR  --stale");
    process.exit(1);
  }
  ticketIds = idArg.split(",").map((s) => Number(s.trim())).filter(Boolean);
}
console.log(`Nudging ${ticketIds.length} ticket(s)${dryRun ? " (DRY-RUN)" : ""}: ${ticketIds.join(", ")}`);

let sent = 0;
let skippedBanned = 0;
let skippedStatus = 0;
let failed = 0;

for (const ticketId of ticketIds) {
  const { rows } = await query(
    `SELECT t.id, t.user_id, t.status, u.telegram_id, u.telegram_username,
            EXISTS(SELECT 1 FROM banned_users b WHERE b.user_id = t.user_id) AS user_banned
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [ticketId],
  );
  const t = rows[0];
  if (!t) {
    console.log(`  #${ticketId}: not found, skipping`);
    failed++;
    continue;
  }
  if (t.status !== "awaiting_user") {
    console.log(`  #${ticketId}: status=${t.status} (not awaiting_user), skipping`);
    skippedStatus++;
    continue;
  }
  if (t.user_banned) {
    console.log(`  #${ticketId}: user banned, skipping`);
    skippedBanned++;
    continue;
  }

  if (dryRun) {
    console.log(`  #${ticketId}: WOULD NUDGE @${t.telegram_username ?? "?"} (tg ${t.telegram_id})`);
    continue;
  }

  const body = [
    `📩 *Magpie support · Ticket #${ticketId}*`,
    "",
    NUDGE_BODY,
  ].join("\n");

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "💬 Follow up", callback_data: `myt:followup:${ticketId}` },
        { text: "✅ Resolved", callback_data: `myt:close:${ticketId}` },
      ],
    ],
  };

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: t.telegram_id,
        text: body,
        parse_mode: "Markdown",
        reply_markup,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.log(`  #${ticketId}: telegram error — ${data.description || JSON.stringify(data)}`);
      failed++;
      continue;
    }
    await query(
      `UPDATE support_tickets
          SET admin_replied_at = NOW(),
              last_alerted_tier = NULL
        WHERE id = $1`,
      [ticketId],
    );
    console.log(`  #${ticketId}: ✓ nudged @${t.telegram_username ?? "?"} (msg ${data.result.message_id})`);
    sent++;
    // Gentle throttle so Telegram doesn't rate-limit us at 10+ rapid sends
    await new Promise((r) => setTimeout(r, 250));
  } catch (e) {
    console.log(`  #${ticketId}: send failed — ${e.message}`);
    failed++;
  }
}

console.log("");
console.log(`Sent: ${sent} · Skipped (banned): ${skippedBanned} · Skipped (status): ${skippedStatus} · Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
