/**
 * Single source of truth for admin notifications.
 *
 * Resolves the admin Telegram ID from any of three possible env var
 * names (history: different services were added with different names).
 * Provides a consistent notify helper so we never accidentally use
 * the wrong env var again.
 *
 * Env var resolution order:
 *   1. ADMIN_TG_ID            (singular, what most services use)
 *   2. ADMIN_TELEGRAM_IDS     (plural, what /admin commands use — first ID wins)
 *   3. ADMIN_TELEGRAM_ID      (singular legacy)
 */

let cachedId = null;
let cachedBot = null;

/**
 * Register the bot instance so API handlers (which don't have direct
 * access to `bot`) can fire admin notifications without threading the
 * reference through every layer. Called once at boot from index.js.
 */
export function setNotifyBot(bot) { cachedBot = bot; }
export function getNotifyBot() { return cachedBot; }

export function getAdminId() {
  if (cachedId !== null) return cachedId;
  const raw =
    process.env.ADMIN_TG_ID
    || (process.env.ADMIN_TELEGRAM_IDS || "").split(",")[0]?.trim()
    || process.env.ADMIN_TELEGRAM_ID
    || "";
  cachedId = raw ? Number(raw) : 0;
  return cachedId;
}

/**
 * Send a Telegram DM to admin. Swallows errors (admin notification is
 * best-effort — never let an alert failure crash the caller).
 *
 * Optional opts: { parse_mode, disable_web_page_preview, reply_markup, ... }
 * — passed through to grammy sendMessage.
 */
export async function notifyAdmin(bot, text, opts = {}) {
  // Accept (bot, text, opts) OR (text, opts) — the latter form uses the
  // cached bot registered via setNotifyBot, which lets API handlers
  // notify without needing the bot threaded through.
  if (typeof bot === "string") {
    opts = text || {};
    text = bot;
    bot = cachedBot;
  }
  if (!bot) return false;
  const id = getAdminId();
  if (!id) return false;
  try {
    await bot.api.sendMessage(id, text, opts);
    return true;
  } catch (err) {
    console.warn("[admin-notify] failed:", err.message);
    return false;
  }
}
