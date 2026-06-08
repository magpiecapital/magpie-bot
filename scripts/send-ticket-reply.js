#!/usr/bin/env node
/**
 * Operator-authorized ticket reply send.
 *
 * Replicates /reply <ticket#> <text> behavior — sends the user a DM
 * via the bot's Telegram token, updates the ticket row to
 * status='awaiting_user' with admin_reply set, clears last_alerted_tier
 * so a fresh user follow-up re-alerts from tier 0.
 *
 * Usage:
 *   node scripts/send-ticket-reply.js <ticket_id> --file <path-to-reply.txt>
 *   node scripts/send-ticket-reply.js <ticket_id> --dry-run --file ...
 *
 * The reply text MUST be read from a file (not cmdline) because we use
 * Markdown and cmdline escaping is too fragile.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { query } from "../src/db/pool.js";

const ticketId = Number(process.argv[2]);
if (!Number.isInteger(ticketId) || ticketId <= 0) {
  console.error("Usage: node scripts/send-ticket-reply.js <ticket_id> --file <path> [--dry-run]");
  process.exit(1);
}
const fileIdx = process.argv.indexOf("--file");
if (fileIdx < 0 || !process.argv[fileIdx + 1]) {
  console.error("Missing --file <path>");
  process.exit(1);
}
const replyText = readFileSync(process.argv[fileIdx + 1], "utf8").trimEnd();
const dryRun = process.argv.includes("--dry-run");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not in env");
  process.exit(1);
}

// Look up ticket + user
const { rows } = await query(
  `SELECT t.id, t.user_id, t.status, u.telegram_id, u.telegram_username
     FROM support_tickets t
     JOIN users u ON u.id = t.user_id
    WHERE t.id = $1`,
  [ticketId],
);
const t = rows[0];
if (!t) {
  console.error(`Ticket #${ticketId} not found`);
  process.exit(1);
}
console.log(`Ticket #${t.id} · user ${t.user_id} @${t.telegram_username ?? "?"} (tg ${t.telegram_id})`);
console.log(`Status: ${t.status}`);
console.log(`Reply (${replyText.length} chars):`);
console.log("───");
console.log(replyText);
console.log("───");

if (dryRun) {
  console.log("\nDRY RUN — not sending. Re-run without --dry-run to actually send.");
  process.exit(0);
}

const body = [
  `📩 *Magpie support · Ticket #${ticketId}*`,
  ``,
  replyText,
  ``,
  `_Reply via the buttons below — or run /mytickets any time to see all your tickets._`,
].join("\n");

const reply_markup = {
  inline_keyboard: [
    [
      { text: "💬 Follow up", callback_data: `myt:followup:${ticketId}` },
      { text: "✅ Resolved", callback_data: `myt:close:${ticketId}` },
    ],
  ],
};

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
  console.error(`Telegram API error: ${JSON.stringify(data)}`);
  process.exit(1);
}
console.log(`✓ DM sent (message_id ${data.result.message_id})`);

await query(
  `UPDATE support_tickets
      SET status = 'awaiting_user',
          admin_reply = $2,
          admin_replied_at = NOW(),
          last_alerted_tier = NULL
    WHERE id = $1`,
  [ticketId, replyText],
);
console.log(`✓ Ticket #${ticketId} → status='awaiting_user'`);
process.exit(0);
