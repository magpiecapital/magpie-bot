/**
 * Operator override for site-lock.
 *
 *   /adminlock <user_id|@username> [hours]
 *     Force-lock a user's site signed endpoints. Useful when the
 *     operator spots suspicious activity before the user notices.
 *
 *   /adminunlock <user_id|@username>
 *     Clear a user's site-lock. Useful if a user genuinely lost TG
 *     access and reached out via another channel — operator can
 *     unlock on their behalf after verifying identity.
 *
 * Both commands are admin-gated. The target user is also DM'd so
 * there's a public-to-them record of the override action (no quiet
 * locks from the operator).
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";
import { setSiteLock, clearSiteLock, getSiteLock } from "../services/site-lock.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

async function resolveTarget(ctx, raw) {
  // Accepts: numeric user id, @username, or plain username.
  const cleaned = raw.replace(/^@/, "").trim();
  if (/^\d+$/.test(cleaned)) {
    const { rows } = await query(
      `SELECT id, telegram_id, telegram_username FROM users WHERE id = $1 LIMIT 1`,
      [Number(cleaned)],
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await query(
    `SELECT id, telegram_id, telegram_username FROM users
      WHERE telegram_username ILIKE $1 LIMIT 1`,
    [cleaned],
  );
  return rows[0] || null;
}

function fmtUntil(d) {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export async function handleAdminLock(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const parts = (ctx.message?.text || "").split(/\s+/);
  const target = parts[1];
  const hoursArg = parts[2];
  if (!target) {
    return ctx.reply(
      "Usage: `/adminlock <user_id|@username> [hours]` (default 24h, max 720h).",
      { parse_mode: "Markdown" },
    );
  }
  const hours = hoursArg ? Number(hoursArg) : 24;
  if (!Number.isFinite(hours) || hours <= 0) {
    return ctx.reply("Hours must be a positive number.");
  }

  const user = await resolveTarget(ctx, target);
  if (!user) {
    return ctx.reply(`User '${target}' not found.`);
  }

  const adminTag = ctx.from?.username ? `admin:@${ctx.from.username}` : `admin:#${ctx.from?.id}`;
  const { hours: applied } = await setSiteLock(user.id, hours, { setBy: adminTag });

  // DM the affected user so they're not surprised — this is a
  // power-asymmetric action and the audit trail should be visible to
  // them, not just to the operator.
  try {
    await ctx.api.sendMessage(
      Number(user.telegram_id),
      [
        `🔒 *Your Magpie site account has been locked by support for ${applied} hour${applied === 1 ? "" : "s"}.*`,
        "",
        "Site-initiated signed actions (withdraw, set-active, support delete, etc.) are paused. Telegram commands still work.",
        "",
        "If this is a surprise, reply via /support — the team likely saw something flagged.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch { /* user may have blocked bot — non-critical */ }

  const lockState = await getSiteLock(user.id);
  return ctx.reply(
    [
      `🔒 Locked ${user.telegram_username ? "@" + user.telegram_username : "user #" + user.id} for ${applied}h.`,
      `Until: ${fmtUntil(lockState.until)}`,
      "DM sent to user.",
    ].join("\n"),
  );
}

export async function handleAdminUnlock(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const target = (ctx.message?.text || "").split(/\s+/)[1];
  if (!target) {
    return ctx.reply(
      "Usage: `/adminunlock <user_id|@username>`",
      { parse_mode: "Markdown" },
    );
  }

  const user = await resolveTarget(ctx, target);
  if (!user) {
    return ctx.reply(`User '${target}' not found.`);
  }

  const before = await getSiteLock(user.id);
  if (!before.locked) {
    return ctx.reply(`User isn't locked.`);
  }

  const adminTag = ctx.from?.username ? `admin:@${ctx.from.username}` : `admin:#${ctx.from?.id}`;
  await clearSiteLock(user.id, { setBy: adminTag });

  try {
    await ctx.api.sendMessage(
      Number(user.telegram_id),
      [
        `🔓 *Your Magpie site account was unlocked by support.*`,
        "",
        "Site-initiated signed actions are accepting requests again. If you weren't expecting this, please reply via /support.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch { /* non-critical */ }

  return ctx.reply(
    `🔓 Cleared lock on ${user.telegram_username ? "@" + user.telegram_username : "user #" + user.id} (was until ${fmtUntil(before.until)}). DM sent.`,
  );
}
