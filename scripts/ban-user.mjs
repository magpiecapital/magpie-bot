import { Api } from "grammy";
import { query } from "../src/db/pool.js";
import { recordModAction } from "../src/services/community-moderation.js";
const USER = Number(process.argv[2]);
if (!USER) { console.error("usage: node scripts/ban-user.mjs <user_id> [reason]"); process.exit(1); }
const reason = process.argv[3] || "manual permaban: impersonator";
const api = new Api(process.env.TELEGRAM_BOT_TOKEN);
const { rows } = await query(`SELECT chat_id FROM community_chats WHERE enabled=TRUE ORDER BY enabled_at DESC NULLS LAST`);
if (!rows.length) { console.error("no enabled chat"); process.exit(1); }
for (const { chat_id: chatId } of rows) {
  let statusBefore = "unknown";
  try { const m = await api.getChatMember(chatId, USER); statusBefore = m?.status; console.log(`chat ${chatId}: current status = ${statusBefore}${m?.user ? ` (${[m.user.first_name,m.user.last_name].filter(Boolean).join(" ")}${m.user.username?" @"+m.user.username:""})` : ""}`); }
  catch (e) { statusBefore = `not-a-member (${e.message})`; console.log(`chat ${chatId}: ${statusBefore}`); }
  try {
    await api.banChatMember(chatId, USER); // no until_date = PERMANENT
    await recordModAction(chatId, USER, "manual_permaban_impersonator", reason, JSON.stringify({ statusBefore }));
    console.log(`chat ${chatId}: PERMABANNED user ${USER} (was ${statusBefore})`);
  } catch (e) { console.error(`chat ${chatId}: ban failed: ${e.message}`); }
}
process.exit(0);
