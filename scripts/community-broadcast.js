#!/usr/bin/env node
/**
 * Post a Pip-style announcement to every enabled community chat.
 *
 * Used when the operator wants to announce something to @magpietalk
 * without first posting it on @MagpieLoans (the crosspost-tweet.js
 * path is X-gated on purpose — only @MagpieLoans tweets can be
 * crossposted via that route).
 *
 * Usage:
 *   node scripts/community-broadcast.js path/to/message.txt
 *   node scripts/community-broadcast.js -    # read from stdin
 *
 * Safety:
 *   - Only sends to chats already in the `community_chats` table
 *     marked enabled (same allowlist the crosspost path uses).
 *   - Respects Telegram's 4096-char limit and warns if exceeded.
 *   - Refuses to send an empty / whitespace-only message.
 *   - One-shot: no scheduling, no recurrence.
 *   - Logs to stdout which chats received the post.
 *
 * No engagement footer is appended — the announcement is the post.
 * Tone of the message is the operator's responsibility.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REPO_ROOT, ".env") });

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/community-broadcast.js <file.txt | ->");
  process.exit(1);
}

const message = (arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8")).trim();
if (!message) {
  console.error("Refusing to send: message is empty or whitespace-only.");
  process.exit(1);
}
if (message.length > 4096) {
  console.error(`Refusing to send: message is ${message.length} chars; Telegram limit is 4096.`);
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not in env");
  process.exit(1);
}

const { listEnabledChats } = await import("../src/services/community-moderation.js");
const chats = await listEnabledChats();
if (!chats.length) {
  console.error("No enabled community chats. Nothing to do.");
  process.exit(0);
}

console.error(`About to post to ${chats.length} chat(s):`);
for (const c of chats) console.error(`  ${c.chat_id} — ${c.title || "(no title)"}`);
console.error("---");

let ok = 0;
let failed = 0;
for (const c of chats) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: c.chat_id,
        text: message,
        // No parse_mode — keeps the script safe for arbitrary text.
        // Telegram auto-detects bare URLs and renders link previews.
        disable_web_page_preview: false,
      }),
    });
    const body = await res.json();
    if (!body.ok) {
      console.error(`✗ ${c.chat_id}: ${body.description || `http ${res.status}`}`);
      failed++;
    } else {
      console.log(`✓ ${c.chat_id} — posted as message_id ${body.result?.message_id}`);
      ok++;
    }
    // Telegram rate limit: 30 messages/sec to different chats, but be polite.
    await new Promise((r) => setTimeout(r, 250));
  } catch (err) {
    console.error(`✗ ${c.chat_id}: ${err.message}`);
    failed++;
  }
}
console.error("---");
console.error(`Done. ok=${ok} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
