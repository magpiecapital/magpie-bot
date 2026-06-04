/**
 * Idle SOL → LP yield agent.
 *
 * Finds users sitting on idle SOL in their Magpie wallet who have
 * never deposited into the LP pool. Nudges them once with a concrete
 * "your N SOL could be earning yield at /earn" message.
 *
 * Different audience than the dormant-reengagement agent — that one
 * targets users with TOKEN bags. This one targets users with idle SOL.
 *
 * Rules:
 *   • One DM per user every 30 days, max
 *   • Only users who:
 *       - Have NEVER deposited to the LP pool (no row in lp_positions)
 *       - Have ≥1 SOL idle in their Magpie wallet
 *       - Account is ≥5 days old
 *       - Haven't opted out
 *   • Max NUDGES_PER_TICK per cycle
 *   • Skips silently if user holds an active loan (they need that SOL
 *     to repay) — don't suggest they LP money they actually need
 */
import { PublicKey } from "@solana/web3.js";
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";

const POLL_INTERVAL_MS = Number(process.env.IDLE_SOL_POLL_MS) || 24 * 60 * 60 * 1000; // 1d
const FIRST_RUN_DELAY_MS = 60 * 60 * 1000; // 1h after boot
const NUDGES_PER_TICK = 25;
const MIN_IDLE_SOL = 1.0;
const MIN_ACCOUNT_AGE_DAYS = 5;
const NUDGE_COOLDOWN_DAYS = 30;

function fmtSol(n) {
  if (n < 1) return n.toFixed(3);
  if (n < 100) return n.toFixed(2);
  return n.toFixed(1);
}

async function findCandidates() {
  // Pull users matching the idle-SOL profile. The LEFT JOIN to
  // lp_positions filters out anyone who's already an LP. The LEFT
  // JOIN to loans filters out anyone with an active loan (they
  // need their SOL).
  const { rows } = await query(
    `SELECT u.id, u.telegram_id, u.telegram_username, w.public_key
       FROM users u
       JOIN wallets w ON w.user_id = u.id
       LEFT JOIN lp_positions lp ON lp.wallet_address = w.public_key
      WHERE u.proactive_dms_disabled = FALSE
        AND (u.last_idle_sol_nudge_at IS NULL OR
             u.last_idle_sol_nudge_at < NOW() - INTERVAL '${NUDGE_COOLDOWN_DAYS} days')
        AND u.created_at < NOW() - INTERVAL '${MIN_ACCOUNT_AGE_DAYS} days'
        AND (lp.shares IS NULL OR lp.shares::numeric = 0)
        AND NOT EXISTS (
          SELECT 1 FROM loans WHERE user_id = u.id AND status = 'active'
        )
      ORDER BY u.created_at DESC
      LIMIT 200`,
  );
  return rows;
}

async function nudgeUser(bot, user, idleSol) {
  const text = [
    `💰 *Your ${fmtSol(idleSol)} SOL is sitting idle*`,
    "",
    `You have *${fmtSol(idleSol)} SOL* in your Magpie wallet doing nothing.`,
    "",
    `Drop it in the lending pool at *magpie.capital/earn* and it earns share-based yield from every loan fee on the protocol. No lock-up — withdraw any time the pool has liquidity.`,
    "",
    `_60% of all loan fees flow to LPs pro-rata to their share-seconds. The longer you stay, the more you earn._`,
    "",
    `_One-time nudge. Tap "Don't show again" below if you'd rather not get these._`,
  ].join("\n");

  const kb = new InlineKeyboard()
    .url("🪙 Deposit on /earn", "https://magpie.capital/earn")
    .row()
    .text("🔕 Don't show again", "dormant:optout"); // reuse the dormant optout handler

  try {
    await bot.api.sendMessage(Number(user.telegram_id), text, {
      parse_mode: "Markdown",
      reply_markup: kb,
      disable_web_page_preview: true,
    });
    await query(
      `UPDATE users SET last_idle_sol_nudge_at = NOW() WHERE id = $1`,
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
    console.error("[idle-sol] candidate query failed:", err.message);
    return;
  }
  if (candidates.length === 0) {
    console.log("[idle-sol] no eligible candidates this tick");
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const user of candidates) {
    if (sent >= NUDGES_PER_TICK) break;
    let solBalance = 0;
    try {
      const lamports = await connection.getBalance(new PublicKey(user.public_key));
      solBalance = lamports / 1e9;
    } catch {
      skipped++;
      continue;
    }
    if (solBalance < MIN_IDLE_SOL) {
      // Below threshold — bump cooldown so we don't re-check this user
      // every 24h. They can be re-evaluated in 30 days.
      await query(
        `UPDATE users SET last_idle_sol_nudge_at = NOW() WHERE id = $1`,
        [user.id],
      );
      skipped++;
      continue;
    }
    const r = await nudgeUser(bot, user, solBalance);
    if (r.ok) sent++;
    else failed++;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`[idle-sol] tick done: ${sent} sent, ${skipped} skipped (below threshold), ${failed} failed`);
}

export function startIdleSolNudge(bot) {
  console.log(`[idle-sol] Starting (every ${POLL_INTERVAL_MS / 3_600_000}h, first run in ${FIRST_RUN_DELAY_MS / 60_000}min)`);
  setTimeout(() => tick(bot), FIRST_RUN_DELAY_MS);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}
