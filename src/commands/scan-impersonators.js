/**
 * /scan-impersonators [days=7] [chat_id=primary]
 *
 * Retroactive sweep against the current IMPERSONATION_PATTERNS list.
 * The auto-detector runs on join, so anyone who joined BEFORE we add
 * a new pattern (e.g. \bpip\b added 2026-06-13 after the live Pip
 * impersonator) won't auto-trip. This command closes that gap by
 * pulling every community_members row joined within the window and
 * running getChatMember per row to read the user's current first
 * name, last name, and username, then matching against the live
 * patterns.
 *
 * The earlier Pip impersonator slipped past the existing filter
 * because their display name was just "Pip" — no "magpie" substring.
 * After PR #129 added \bpip\b, future joins are caught — but the
 * impersonator (or a copycat with the same name pattern who joined
 * before today) wouldn't be. This is the operator's manual sweep.
 *
 * Output: DM to operator with up to 25 hits. Each hit includes the
 * member's telegram_id, current display name, @username, when they
 * joined, and a clickable [/ban_user <id>] command for one-tap ban.
 *
 * Admin-only. Defensive against rate limits: getChatMember runs
 * serially with a 50ms gap (TG's ~30 req/s limit), so 500 members
 * is ~25s end-to-end. The command sends a "scanning…" reply
 * immediately so the operator knows it's in progress.
 *
 * Usage:
 *   /scan-impersonators           — default: last 7 days, primary chat
 *   /scan-impersonators 30        — last 30 days
 *   /scan-impersonators 7 -100… — specific chat by id
 */
import { query } from "../db/pool.js";
import { isAdmin } from "../services/admin.js";
import { isImpersonationName, isVerifiedAccount } from "../services/community-moderation.js";

const DEFAULT_DAYS = 7;
const MAX_HITS_IN_DM = 25;
const FETCH_GAP_MS = 50;
const MAX_MEMBERS_PER_SWEEP = 2_000;

function formatJoined(date) {
  if (!date) return "?";
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 86_400_000) return "today";
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function suspectName(m) {
  const parts = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
  const u = m.username ? `@${m.username}` : "";
  if (parts && u) return `${parts} (${u})`;
  return parts || u || `id ${m.id}`;
}

export async function handleScanImpersonators(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply("Not authorized.");
  }
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const days = Math.max(1, Math.min(60, Number(parts[1]) || DEFAULT_DAYS));
  const chatIdArg = parts[2];

  // If no chat passed, use the most recently enabled community chat.
  let chatId = chatIdArg;
  if (!chatId) {
    const { rows } = await query(
      `SELECT chat_id FROM community_chats
        WHERE enabled = TRUE
        ORDER BY enabled_at DESC NULLS LAST LIMIT 1`,
    );
    if (rows.length === 0) {
      return ctx.reply("No enabled community chat found. Pass a chat_id explicitly.");
    }
    chatId = rows[0].chat_id;
  }

  await ctx.reply(
    `Scanning members of \`${chatId}\` joined in the last ${days}d against the live IMPERSONATION_PATTERNS list. I'll DM you the hits — this can take 30-60s for large windows.`,
    { parse_mode: "Markdown" },
  );

  const { rows: members } = await query(
    `SELECT user_id, joined_at
       FROM community_members
      WHERE chat_id = $1
        AND joined_at > NOW() - ($2 || ' days')::INTERVAL
      ORDER BY joined_at DESC
      LIMIT $3`,
    [String(chatId), String(days), MAX_MEMBERS_PER_SWEEP],
  );

  if (members.length === 0) {
    return ctx.api.sendMessage(ctx.from.id, `Scan complete — 0 members joined in the last ${days}d on \`${chatId}\`.`, { parse_mode: "Markdown" });
  }

  const hits = [];
  let fetched = 0;
  let errors = 0;
  for (const row of members) {
    try {
      // getChatMember returns { status, user: { id, first_name, last_name, username, ... } }
      const member = await ctx.api.getChatMember(chatId, Number(row.user_id));
      fetched++;
      const u = member?.user;
      if (!u) continue;
      if (isVerifiedAccount(u)) continue;        // exempt the bot + operator
      if (member.status === "left" || member.status === "kicked") continue;
      if (isImpersonationName(u)) {
        hits.push({
          id: u.id,
          first_name: u.first_name,
          last_name: u.last_name,
          username: u.username,
          status: member.status,
          joined_at: row.joined_at,
        });
      }
    } catch (err) {
      errors++;
      // TG returns 400 for users who blocked the bot or left the chat
      // some other way; just skip and keep scanning.
      if (errors < 3) {
        console.warn(`[scan-impersonators] getChatMember failed for ${row.user_id}:`, err.message);
      }
    }
    if (FETCH_GAP_MS > 0) await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
  }

  // DM the report to the operator (private channel — not posted in the
  // chat where the suspects would see it).
  const headerLines = [
    `*Impersonator scan — ${chatId}*`,
    `Window: last ${days}d · Members scanned: ${fetched} · Hits: *${hits.length}*` + (errors > 0 ? ` · Skipped: ${errors}` : ""),
    "",
  ];
  if (hits.length === 0) {
    headerLines.push("No impersonation-pattern matches in this window.");
    await ctx.api.sendMessage(ctx.from.id, headerLines.join("\n"), { parse_mode: "Markdown" });
    return;
  }
  const sortedHits = hits.slice(0, MAX_HITS_IN_DM);
  for (const h of sortedHits) {
    headerLines.push(`• \`${h.id}\` — ${suspectName(h)} · joined ${formatJoined(h.joined_at)}`);
    headerLines.push(`  Ban with: \`/ban_user ${h.id}\``);
  }
  if (hits.length > MAX_HITS_IN_DM) {
    headerLines.push("");
    headerLines.push(`_${hits.length - MAX_HITS_IN_DM} more not shown — re-run with a smaller window._`);
  }
  await ctx.api.sendMessage(ctx.from.id, headerLines.join("\n"), { parse_mode: "Markdown" });
}
