/**
 * Operator-facing commands to control community moderation. None of
 * these are user-facing; every command requires admin auth.
 *
 *   /community_enable     — turn moderation ON for the current chat
 *                           (must be invoked inside the group)
 *   /community_disable    — turn it off (also must be inside the group)
 *   /community_status     — show recent action counts + member stats
 *   /community_allowlist  — list current URL allowlist
 */
import { isAdmin } from "../services/admin.js";
import {
  enableChat,
  disableChat,
  isChatEnabled,
  recentStats,
  URL_ALLOWLIST,
  listEnabledChats,
} from "../services/community-moderation.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("Not authorized.");
    return false;
  }
  return true;
}

function isGroup(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

export async function handleCommunityEnable(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply("Run this *inside* the group you want to moderate, not in DM.", { parse_mode: "Markdown" });
  }
  await enableChat(ctx.chat.id, ctx.chat.title, ctx.from.id);
  await ctx.reply(
    `✅ Community moderation *enabled* for "${ctx.chat.title}".\n\n` +
    `Make sure the bot has *Delete Messages* + *Ban Users* permissions ` +
    `in the group admin settings, or some rules will silently fail.\n\n` +
    `Use \`/community_status\` for recent stats, \`/community_disable\` to turn off.`,
    { parse_mode: "Markdown" },
  );
}

export async function handleCommunityDisable(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply("Run this inside the group.");
  }
  await disableChat(ctx.chat.id);
  await ctx.reply("✋ Community moderation disabled for this chat.");
}

export async function handleCommunityStatus(ctx) {
  if (!(await requireAdmin(ctx))) return;
  // If invoked in DM, show all enabled chats. If in a group, show that group.
  if (isGroup(ctx)) {
    const on = await isChatEnabled(ctx.chat.id);
    const stats = await recentStats(ctx.chat.id, 24);
    const lines = [
      `*${ctx.chat.title}*`,
      `Moderation: ${on ? "🟢 ON" : "⚪️ OFF"}`,
      ``,
      `Last 24h actions:`,
      stats.length === 0 ? "  (none)" : stats.map(s => `  • ${s.action.padEnd(28)} ${s.n}`).join("\n"),
    ];
    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }
  // DM mode: list every enabled chat
  const chats = await listEnabledChats();
  if (chats.length === 0) {
    return ctx.reply("No chats currently have moderation enabled. Run /community_enable inside a group to start.");
  }
  const lines = ["*Active moderated chats:*", ""];
  for (const c of chats) {
    const stats = await recentStats(c.chat_id, 24);
    const total = stats.reduce((sum, s) => sum + s.n, 0);
    lines.push(`• ${c.title || c.chat_id} — ${total} action(s) in last 24h`);
  }
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

export async function handleCommunityBroadcastNow(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { fireDigestNow } = await import("../services/community-broadcast.js");
  try {
    // In DM → preview to operator only. In group → post to that group.
    const target = isGroup(ctx) ? ctx.chat.id : ctx.from.id;
    await fireDigestNow({ api: ctx.api }, target);
    if (!isGroup(ctx)) await ctx.reply("✅ Digest preview sent (just to you). Run inside a moderated group to post there.");
  } catch (err) {
    await ctx.reply(`❌ Broadcast failed: ${err.message?.slice(0, 200)}`);
  }
}

export async function handleCommunityAllowlist(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const items = [...URL_ALLOWLIST];
  await ctx.reply(
    `*URL allowlist* (${items.length} entries):\n\n` +
    items.map(u => `  • \`${u}\``).join("\n") +
    `\n\nTo change, edit \`URL_ALLOWLIST\` in src/services/community-moderation.js and redeploy.`,
    { parse_mode: "Markdown" },
  );
}
