/**
 * /lock [hours]     — emergency pause for site-initiated signed actions
 *                     (default 24h, max 720h = 30 days).
 * /lock 0           — clear the lock immediately.
 * /lock status      — show current lock state.
 *
 * Pairs with the TG security alerts (services/security-alerts.js) and
 * the lock check in every signed HTTP endpoint. The model:
 *
 *   1. User gets a TG alert about a site action they didn't trigger.
 *   2. User runs /lock 24 here in TG (different auth surface — a
 *      stolen Phantom seed can't suppress a Telegram message).
 *   3. Site signed endpoints reject with 423 LOCKED until the timer
 *      expires or the user runs /lock 0.
 *   4. User uses the window to move funds + rotate Phantom.
 *
 * Note: the existing /unlock command (commands/unlock.js) shows the
 * user what they could borrow — different concept, not a kill-switch.
 * That's why this command consolidates set + clear under one verb.
 */
import { upsertUser } from "../services/users.js";
import { setSiteLock, clearSiteLock, getSiteLock } from "../services/site-lock.js";

const DEFAULT_HOURS = 24;

function fmtUntil(d) {
  // Compact UTC string the user can sanity-check.
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export async function handleLock(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const arg = (ctx.message?.text?.split(/\s+/)[1] || "").toLowerCase();

  if (arg === "status") {
    const { locked, until } = await getSiteLock(user.id);
    if (locked) {
      return ctx.reply(
        `🔒 *Site lock active* — expires ${fmtUntil(until)}.\n\nRun \`/lock 0\` to clear it.`,
        { parse_mode: "Markdown" },
      );
    }
    return ctx.reply(
      "🔓 *No site lock set.* All site signed endpoints are accepting requests normally.\n\nRun `/lock 24` to pause site actions for 24 hours if you suspect your Phantom seed is compromised.",
      { parse_mode: "Markdown" },
    );
  }

  if (arg === "0" || arg === "off" || arg === "clear") {
    const { locked, until } = await getSiteLock(user.id);
    if (!locked) {
      return ctx.reply("Your account isn't locked.");
    }
    await clearSiteLock(user.id);
    return ctx.reply(
      [
        `🔓 *Site lock cleared* (was until ${fmtUntil(until)})`,
        "",
        "Site signed actions are accepted again. Make sure you've rotated your Phantom seed if you suspected compromise.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  let hours = DEFAULT_HOURS;
  if (arg) {
    const n = Number(arg);
    if (!Number.isFinite(n) || n <= 0) {
      return ctx.reply(
        "Usage: `/lock` (24h default), `/lock 4` (custom hours, up to 720), `/lock 0` to clear, `/lock status` to check.",
        { parse_mode: "Markdown" },
      );
    }
    hours = n;
  }

  const { hours: applied } = await setSiteLock(user.id, hours);
  return ctx.reply(
    [
      `🔒 *Site actions locked for ${applied} hour${applied === 1 ? "" : "s"}*`,
      "",
      "Until the timer expires, every site-initiated action (withdraw, set-active, support delete, etc.) will be rejected — even if signed correctly.",
      "",
      "TG commands (/borrow, /repay, etc.) are *not* affected by this lock.",
      "",
      "If your Phantom may be compromised:",
      "1. Move any funds from that wallet to a fresh one",
      "2. Run `/lock 0` once you've rotated keys",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

/**
 * Register callback handlers for the lock buttons embedded in security
 * alert DMs (services/security-alerts.js → lockKeyboard).
 */
export function registerLockCallbacks(bot) {
  bot.callbackQuery(/^sec:lock:(\d+|status|clear)$/, async (ctx) => {
    const arg = ctx.match[1];
    const user = await upsertUser(ctx.from.id, ctx.from.username);

    if (arg === "status") {
      const { locked, until } = await getSiteLock(user.id);
      await ctx.answerCallbackQuery(
        locked
          ? `Locked until ${until.toISOString().slice(0, 16).replace("T", " ")} UTC`
          : "Not locked",
      );
      return;
    }

    if (arg === "clear") {
      const { locked } = await getSiteLock(user.id);
      if (!locked) {
        await ctx.answerCallbackQuery("Not locked");
        return;
      }
      await clearSiteLock(user.id, { setBy: "callback" });
      await ctx.answerCallbackQuery({
        text: "🔓 Site lock cleared",
        show_alert: true,
      });
      try {
        await ctx.reply(
          "🔓 *Site lock cleared.* Make sure you've rotated your Phantom seed before continuing.",
          { parse_mode: "Markdown" },
        );
      } catch { /* non-critical */ }
      return;
    }

    const hours = Number(arg);
    if (!Number.isFinite(hours) || hours <= 0) {
      await ctx.answerCallbackQuery("Invalid duration");
      return;
    }
    const { hours: applied } = await setSiteLock(user.id, hours, { setBy: "callback" });
    await ctx.answerCallbackQuery({
      text: `🔒 Site locked for ${applied}h`,
      show_alert: true,
    });
    // Also confirm in chat so the user has a persistent record + the
    // /lock 0 instructions for later.
    try {
      await ctx.reply(
        [
          `🔒 *Site locked for ${applied} hour${applied === 1 ? "" : "s"}*`,
          "",
          "Move funds from the compromised wallet to a fresh one, then run `/lock 0` to clear the lock.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    } catch { /* non-critical */ }
  });
}
