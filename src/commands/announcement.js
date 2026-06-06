/**
 * Operator commands for the site announcement banner.
 *
 *   /announce <message>      — set info-level banner
 *   /announcewarn <message>  — set warning-level banner
 *   /announcecrit <message>  — set critical-level banner
 *   /announceclear           — remove the banner
 *   /announce                — show current banner state
 *
 * The dashboard polls /api/v1/site-status (extended to include the
 * announcement) and renders the banner color-coded by severity.
 *
 * To auto-expire, append " expires:<hours>" to the message — e.g.,
 *   /announce Maintenance Sat 10am UTC expires:24
 */
import { isAdmin } from "../services/admin.js";
import {
  getAnnouncement,
  setAnnouncement,
  clearAnnouncement,
} from "../services/site-announcement.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

function parseExpires(text) {
  const m = text.match(/\s+expires:(\d+)\s*$/i);
  if (!m) return { cleanText: text, expiresAt: null };
  const hours = Number(m[1]);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    return { cleanText: text, expiresAt: null };
  }
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  return { cleanText: text.slice(0, m.index).trim(), expiresAt };
}

async function setOp(ctx, severity) {
  if (!(await requireAdmin(ctx))) return;
  const raw = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  if (!raw) {
    const a = await getAnnouncement();
    if (!a.message) return ctx.reply("No announcement set. Add one: `/announce <message>`", { parse_mode: "Markdown" });
    return ctx.reply(
      [
        `*Current announcement (${a.severity}):*`,
        a.message,
        a.expires_at ? `\n_expires: ${new Date(a.expires_at).toISOString().slice(0, 19).replace("T", " ")} UTC_` : "",
        a.set_by ? `\n_set by: ${a.set_by}_` : "",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }
  const { cleanText, expiresAt } = parseExpires(raw);
  const setBy = ctx.from?.username ? `@${ctx.from.username}` : `#${ctx.from?.id}`;
  await setAnnouncement({
    message: cleanText,
    severity,
    setBy,
    expiresAt,
  });
  await ctx.reply(
    [
      `📢 *Announcement set* (${severity}${expiresAt ? `, expires ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}):`,
      "",
      cleanText,
      "",
      "_The dashboard will show this within 30s._",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

export const handleAnnounce = (ctx) => setOp(ctx, "info");
export const handleAnnounceWarn = (ctx) => setOp(ctx, "warning");
export const handleAnnounceCrit = (ctx) => setOp(ctx, "critical");

export async function handleAnnounceClear(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const setBy = ctx.from?.username ? `@${ctx.from.username}` : `#${ctx.from?.id}`;
  await clearAnnouncement({ setBy });
  await ctx.reply("📭 Announcement cleared.");
}
