/**
 * Past-borrower win-back agent.
 *
 * Finds users who have borrowed before AND repaid AND don't currently
 * have an active loan AND haven't been seen in 30+ days. These are
 * gold — they've already crossed the trust gap, they just need a
 * reason to come back.
 *
 * Sends a single personalized DM:
 *   "You've repaid N Magpie loans. Bag still moving? /reborrow with
 *    one tap — your last config remembered."
 *
 * Rules:
 *   • One DM per user every 60 days, max
 *   • Only users who:
 *       - Have ≥1 repaid loan
 *       - Have 0 active loans
 *       - Last loan closed >30 days ago
 *       - Account isn't opted out
 *   • Cap NUDGES_PER_TICK per cycle
 *   • Skips users with prior liquidations (more sensitive — they
 *     need a different message arc; that's the winback-liquidated
 *     agent we haven't built yet)
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";

const POLL_INTERVAL_MS = Number(process.env.WINBACK_POLL_MS) || 24 * 60 * 60 * 1000; // 1d
const FIRST_RUN_DELAY_MS = 90 * 60 * 1000; // 90 min after boot — stagger with idle-sol agent
const NUDGES_PER_TICK = 25;
const MIN_DAYS_SINCE_LAST_LOAN = 30;
const NUDGE_COOLDOWN_DAYS = 60;

async function findCandidates() {
  // Pull eligible past-borrowers with their loan history summary.
  // The CTE computes per-user stats; the outer query filters.
  const { rows } = await query(
    `WITH user_loans AS (
       SELECT user_id,
              COUNT(*) FILTER (WHERE status = 'repaid')      AS repaid_count,
              COUNT(*) FILTER (WHERE status = 'active')      AS active_count,
              COUNT(*) FILTER (WHERE status = 'liquidated')  AS liquidated_count,
              MAX(updated_at) FILTER (WHERE status = 'repaid') AS last_repaid_at,
              COALESCE(SUM(loan_amount_lamports::numeric), 0) AS lifetime_borrowed_lamports
         FROM loans
        GROUP BY user_id
     )
     SELECT u.id, u.telegram_id, u.telegram_username, u.current_streak,
            ul.repaid_count, ul.lifetime_borrowed_lamports, ul.last_repaid_at
       FROM users u
       JOIN user_loans ul ON ul.user_id = u.id
      WHERE u.proactive_dms_disabled = FALSE
        AND (u.last_winback_nudge_at IS NULL OR
             u.last_winback_nudge_at < NOW() - INTERVAL '${NUDGE_COOLDOWN_DAYS} days')
        AND ul.repaid_count >= 1
        AND ul.active_count = 0
        AND ul.liquidated_count = 0
        AND ul.last_repaid_at < NOW() - INTERVAL '${MIN_DAYS_SINCE_LAST_LOAN} days'
      ORDER BY ul.repaid_count DESC, ul.lifetime_borrowed_lamports DESC
      LIMIT 200`,
  );
  return rows;
}

function buildMessage(user) {
  const repaid = Number(user.repaid_count);
  const lifetimeSol = Number(user.lifetime_borrowed_lamports) / 1e9;
  const streakLine = user.current_streak > 0
    ? `🔥 _Your on-time streak is at ${user.current_streak} — let's keep it going._`
    : "";

  const repaidLabel = repaid === 1 ? "1 loan" : `${repaid} loans`;
  const lifetimeLabel = lifetimeSol >= 0.1 ? `*${lifetimeSol.toFixed(2)} SOL* borrowed lifetime` : "";

  return [
    `🪶 *Magpie misses you*`,
    "",
    `You've repaid ${repaidLabel} on Magpie${lifetimeLabel ? ` · ${lifetimeLabel}` : ""}. Your bag still moving?`,
    "",
    `Re-borrow in seconds:`,
    `  • /reborrow — same token + tier as last time, one tap`,
    `  • /unlock — see what your current bag is worth right now`,
    `  • /simulate — preview a loan before committing`,
    streakLine,
    "",
    `Cheaper than selling, just like before. 🪶`,
    "",
    `_One nudge every 2 months. Tap "Don't show again" to skip._`,
  ].filter(Boolean).join("\n");
}

async function nudgeUser(bot, user) {
  const text = buildMessage(user);
  const kb = new InlineKeyboard()
    .text("⚡ /reborrow", "winback:reborrow").row()
    .text("🔓 /unlock", "winback:unlock")
    .text("🧮 /simulate", "winback:simulate").row()
    .text("🔕 Don't show again", "dormant:optout");

  try {
    await bot.api.sendMessage(Number(user.telegram_id), text, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    await query(
      `UPDATE users SET last_winback_nudge_at = NOW() WHERE id = $1`,
      [user.id],
    );
    return { ok: true };
  } catch (err) {
    if (/blocked|deactivated|chat not found/i.test(err.message || "")) {
      await query(
        `UPDATE users SET proactive_dms_disabled = TRUE WHERE id = $1`,
        [user.id],
      );
      return { ok: false, reason: "user_unreachable" };
    }
    return { ok: false, reason: err.message?.slice(0, 100) };
  }
}

async function tick(bot) {
  if (!bot) return;
  let candidates;
  try {
    candidates = await findCandidates();
  } catch (err) {
    console.error("[winback] candidate query failed:", err.message);
    return;
  }
  if (candidates.length === 0) {
    console.log("[winback] no eligible candidates this tick");
    return;
  }

  let sent = 0, failed = 0;
  for (const user of candidates) {
    if (sent >= NUDGES_PER_TICK) break;
    const r = await nudgeUser(bot, user);
    if (r.ok) sent++;
    else failed++;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`[winback] tick done: ${sent} sent, ${failed} failed`);
}

export function startWinbackAgent(bot) {
  console.log(`[winback] Starting (every ${POLL_INTERVAL_MS / 3_600_000}h, first run in ${FIRST_RUN_DELAY_MS / 60_000}min)`);
  setTimeout(() => tick(bot), FIRST_RUN_DELAY_MS);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}

export function registerWinbackCallbacks(bot) {
  bot.callbackQuery("winback:reborrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleReborrow } = await import("../commands/reborrow.js");
    await handleReborrow(ctx);
  });
  bot.callbackQuery("winback:unlock", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleUnlock } = await import("../commands/unlock.js");
    await handleUnlock(ctx);
  });
  bot.callbackQuery("winback:simulate", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Usage: `/simulate <symbol> <amount>` — e.g. `/simulate WIF 1000`",
      { parse_mode: "Markdown" },
    );
  });
}
