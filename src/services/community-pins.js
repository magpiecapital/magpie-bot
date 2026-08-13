/**
 * Community pinned-message awareness for Pip.
 *
 * The operator makes protocol announcements in the group and PINS them. Pip
 * must treat those pins as CURRENT, AUTHORITATIVE state so it never gives a
 * stale answer (e.g. still "evaluating auditors" after the operator pinned
 * "we chose Sec3"). We capture pins two ways — live pin events + boot-time
 * getChat() seeding — and inject the recent ones into Pip's answer context.
 */
import { query } from "../db/pool.js";

/** Store (or refresh) a pinned message. Text-less (media-only) pins are skipped. */
export async function recordPinnedMessage({ chatId, messageId, text, pinnedBy }) {
  if (!chatId || !messageId) return;
  const clean = String(text || "").trim().slice(0, 2000);
  if (!clean) return;
  try {
    await query(
      `INSERT INTO community_pinned_messages (chat_id, message_id, text, pinned_by, pinned_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (chat_id, message_id)
         DO UPDATE SET text = EXCLUDED.text, pinned_at = NOW()`,
      [Number(chatId), Number(messageId), clean, pinnedBy ? String(pinnedBy).slice(0, 64) : null],
    );
  } catch (err) {
    console.warn("[pins] record failed:", err.message?.slice(0, 120));
  }
}

/**
 * Recent pinned announcements for a chat, formatted for Pip's system context.
 * Returns "" when there's nothing to inject.
 */
export async function getPinnedContext(chatId, limit = 5) {
  if (!chatId) return "";
  try {
    const { rows } = await query(
      `SELECT text FROM community_pinned_messages
        WHERE chat_id = $1 AND pinned_at > NOW() - INTERVAL '45 days'
        ORDER BY pinned_at DESC
        LIMIT $2`,
      [Number(chatId), limit],
    );
    if (!rows.length) return "";
    const lines = rows.map((r) => `• ${r.text.replace(/\s+/g, " ").slice(0, 500)}`);
    return (
      "📌 PINNED IN THIS GROUP (the operator's own announcements — the community has already seen these). " +
      "Treat them as CURRENT, AUTHORITATIVE protocol state: if a pin conflicts with older knowledge, THE PIN WINS. " +
      "Be aware of them and reference them naturally when relevant — never give an answer that contradicts a pin:\n" +
      lines.join("\n")
    );
  } catch {
    return "";
  }
}

/**
 * Boot-time seed: fetch each enabled chat's current top pin via getChat and
 * store it, so Pip knows about pins made while the bot was offline (Telegram
 * doesn't re-send pin events on restart).
 */
export async function seedPinsForEnabledChats(botApi) {
  try {
    const { listEnabledChats } = await import("./community-moderation.js");
    const chats = await listEnabledChats();
    for (const c of chats) {
      try {
        const chat = await botApi.getChat(Number(c.chat_id));
        const pm = chat?.pinned_message;
        if (pm) {
          await recordPinnedMessage({
            chatId: c.chat_id,
            messageId: pm.message_id,
            text: pm.text || pm.caption || "",
            pinnedBy: pm.from?.username || "seed",
          });
        }
      } catch { /* getChat can fail (perms/rate) — skip that chat */ }
    }
    console.log("[pins] seeded current pins for enabled chats");
  } catch (err) {
    console.warn("[pins] seed failed:", err.message?.slice(0, 120));
  }
}
