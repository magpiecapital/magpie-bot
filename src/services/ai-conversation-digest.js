/**
 * Daily AI conversation digest — DMs the admin one randomly-selected
 * recent conversation per day so they can spot quality issues
 * (escalations that shouldn't have happened, weird AI responses,
 * confused users) without being on call.
 *
 * Anonymized: we strip the user_id and only send the message content.
 * Run once on startup (after 4h grace) then every 24h.
 */
import { query } from "../db/pool.js";

const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? Number(process.env.ADMIN_TG_ID) : null;
const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FIRST_RUN_DELAY_MS = 4 * 60 * 60 * 1000;  // 4h after boot
const MAX_MESSAGE_CHARS = 3500;                  // Telegram safe-ish length

/**
 * Extract a printable transcript from a conversation's stored messages.
 * The DB shape stores Anthropic message objects: { role, content }.
 * Tool calls/results are summarized to one line each to keep length down.
 */
function transcriptFromMessages(messages) {
  if (!Array.isArray(messages)) return "(empty)";
  const lines = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        lines.push(`👤 user: ${m.content}`);
      } else if (Array.isArray(m.content)) {
        // Tool results
        const tools = m.content.filter((b) => b.type === "tool_result");
        if (tools.length > 0) {
          for (const t of tools) {
            const summary = typeof t.content === "string" ? t.content.slice(0, 140) : "[result]";
            lines.push(`🔧 result: ${summary}`);
          }
        }
      }
    } else if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text") {
            lines.push(`🤖 ai: ${b.text}`);
          } else if (b.type === "tool_use") {
            lines.push(`🛠 ai called: ${b.name}(${JSON.stringify(b.input).slice(0, 120)})`);
          }
        }
      } else if (typeof m.content === "string") {
        lines.push(`🤖 ai: ${m.content}`);
      }
    }
  }
  return lines.join("\n");
}

async function sendDigest(bot) {
  if (!bot || !ADMIN_TG_ID) return;
  try {
    // Pick a random conversation from the last 24h that had >= 2 turns
    // (1-turn conversations are usually trivial: greeting, one Q&A).
    const { rows } = await query(
      `SELECT user_id, messages, turns, total_input_tokens, total_output_tokens,
              last_active_at
         FROM support_conversations
        WHERE last_active_at >= NOW() - INTERVAL '24 hours'
          AND turns >= 2
        ORDER BY RANDOM()
        LIMIT 1`,
    );
    if (rows.length === 0) {
      // Nothing to sample — say so once a day so admin knows it's alive.
      await bot.api.sendMessage(
        ADMIN_TG_ID,
        "📋 *AI digest · 24h*\n\nNo multi-turn conversations in the last 24h. Nothing to sample.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const row = rows[0];
    const transcript = transcriptFromMessages(row.messages);
    const truncated = transcript.length > MAX_MESSAGE_CHARS
      ? transcript.slice(0, MAX_MESSAGE_CHARS) + "\n…[truncated]"
      : transcript;
    const header = [
      "📋 *AI conversation digest · 1 sample from last 24h*",
      "",
      `Turns: ${row.turns} · Tokens in/out: ${row.total_input_tokens}/${row.total_output_tokens}`,
      `Last active: ${new Date(row.last_active_at).toISOString()}`,
      "",
      "_(anonymized — user_id not shown)_",
      "",
    ].join("\n");
    // Send as plaintext to avoid Markdown parse failures on raw transcript content
    await bot.api.sendMessage(ADMIN_TG_ID, header, { parse_mode: "Markdown" });
    await bot.api.sendMessage(ADMIN_TG_ID, "```\n" + truncated + "\n```", { parse_mode: "Markdown" })
      .catch(() => bot.api.sendMessage(ADMIN_TG_ID, truncated)); // plaintext fallback
  } catch (err) {
    console.warn("[ai-digest] failed:", err.message);
  }
}

export function startAiConversationDigest(bot) {
  if (!ADMIN_TG_ID) {
    console.log("[ai-digest] No ADMIN_TG_ID set — digest disabled");
    return;
  }
  console.log(`[ai-digest] Starting (first run in ${FIRST_RUN_DELAY_MS / 1000}s, then every 24h)`);
  setTimeout(() => sendDigest(bot), FIRST_RUN_DELAY_MS);
  return setInterval(() => sendDigest(bot), DIGEST_INTERVAL_MS);
}
