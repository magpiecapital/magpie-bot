/**
 * Dormant Re-Engagement Agent.
 *
 * The protocol has many more users than borrowers. Most users
 * connect, hold collateral, but never actually borrow. This agent
 * gently nudges them ONCE with their personalized borrow potential —
 * not as marketing spam, but as concrete info ("your $WIF bag could
 * unlock X SOL right now").
 *
 * Strict rules to avoid feeling spammy:
 *   • One DM per user every 30 days, max
 *   • Only users who:
 *       - Have never had a loan
 *       - Have approved-collateral tokens worth >0.05 SOL in their wallet
 *       - Account is ≥3 days old (give them time to land naturally)
 *       - Haven't opted out (proactive_dms_disabled = FALSE)
 *   • Max NUDGES_PER_TICK per cycle (rate-limit Telegram + Anthropic)
 *   • Opt-out via inline button on the DM itself — sets
 *     proactive_dms_disabled and they're permanently off the list
 *
 * Runs every 6h. Picks the most-promising candidates (highest
 * collateral value first) so we send the best fits first.
 */
import { PublicKey } from "@solana/web3.js";
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { getSupportedBalances } from "./deposits.js";
import { collateralValueLamports } from "./price.js";

const POLL_INTERVAL_MS = Number(process.env.DORMANT_POLL_MS) || 6 * 60 * 60 * 1000; // 6h
const FIRST_RUN_DELAY_MS = 30 * 60 * 1000;   // 30 min after boot
const NUDGES_PER_TICK = 20;                  // max DMs per cycle
const MIN_COLLATERAL_VALUE_SOL = 0.05;       // skip dust
const MIN_ACCOUNT_AGE_DAYS = 3;              // give users time to settle
const NUDGE_COOLDOWN_DAYS = 30;              // per-user nudge cap
const STANDARD_LTV = 0.20;
const STANDARD_FEE_BPS = 150;

function fmtSol(n) {
  if (n < 0.01) return n.toFixed(4);
  if (n < 1) return n.toFixed(3);
  if (n < 100) return n.toFixed(2);
  return n.toFixed(1);
}

async function findCandidate(bot) {
  // Find users matching the dormant profile — never borrowed, account
  // >3 days old, no recent nudge, not opted out. Order by recency so
  // we hit fresher users while they're still curious.
  const { rows: users } = await query(
    `SELECT u.id, u.telegram_id, u.telegram_username, u.created_at
       FROM users u
       LEFT JOIN loans l ON l.user_id = u.id
      WHERE u.proactive_dms_disabled = FALSE
        AND (u.last_dormant_nudge_at IS NULL OR
             u.last_dormant_nudge_at < NOW() - INTERVAL '${NUDGE_COOLDOWN_DAYS} days')
        AND u.created_at < NOW() - INTERVAL '${MIN_ACCOUNT_AGE_DAYS} days'
      GROUP BY u.id, u.telegram_id, u.telegram_username, u.created_at
     HAVING COUNT(l.id) = 0
      ORDER BY u.created_at DESC
      LIMIT 200`,
  );
  return users;
}

async function evaluateUser(userId) {
  // Look up wallet, check holdings, compute total borrow potential.
  const { rows: [w] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`,
    [userId],
  );
  if (!w?.public_key) return null;

  let balances;
  try {
    balances = await getSupportedBalances(w.public_key);
  } catch {
    return null; // RPC blip — skip this tick, retry next cycle
  }
  if (balances.length === 0) return null;

  // Sum collateral value across all approved tokens they hold
  let totalCollateralSol = 0;
  const topTokens = []; // tracked for the personalized DM
  for (const b of balances) {
    try {
      const valueLamports = await collateralValueLamports(
        b.mint,
        BigInt(b.rawAmount),
        b.decimals,
      );
      const valueSol = Number(valueLamports) / 1e9;
      if (valueSol >= 0.01) {
        totalCollateralSol += valueSol;
        topTokens.push({ symbol: b.symbol, valueSol, humanAmount: b.humanAmount });
      }
    } catch { /* price feed unavailable for this token, skip it */ }
  }
  if (totalCollateralSol < MIN_COLLATERAL_VALUE_SOL) return null;

  topTokens.sort((a, b) => b.valueSol - a.valueSol);
  const standardBorrowable = totalCollateralSol * STANDARD_LTV;
  const standardFee = standardBorrowable * (STANDARD_FEE_BPS / 10_000);
  const standardReceive = standardBorrowable - standardFee;

  return {
    publicKey: w.public_key,
    totalCollateralSol,
    standardReceive,
    standardFee,
    topTokens: topTokens.slice(0, 3),
  };
}

function buildMessage(eval_) {
  const { topTokens, standardReceive, standardFee, totalCollateralSol } = eval_;
  const topToken = topTokens[0];
  const sellSlippage = totalCollateralSol * 0.02;
  return [
    `🪶 *Your bag could unlock SOL*`,
    "",
    topToken
      ? `You're holding *${topToken.humanAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${topToken.symbol}*${topTokens.length > 1 ? ` (+${topTokens.length - 1} more)` : ""}.`
      : `You're holding approved collateral worth *${fmtSol(totalCollateralSol)} SOL*.`,
    "",
    `If you borrowed against it on Standard tier (20% LTV, 7-day term):`,
    `  • You'd receive: *\`${fmtSol(standardReceive)} SOL\`*`,
    `  • Fee: \`${fmtSol(standardFee)} SOL\` (1.5%)`,
    `  • You keep every token`,
    "",
    `_Compare to selling: ~${fmtSol(sellSlippage)} SOL slippage + taxable event + you lose the upside._`,
    "",
    `Try /unlock to see the live breakdown, or /borrow to start.`,
    "",
    `_This is a one-time nudge. Tap "Don't show again" below if you'd rather not get these._`,
  ].join("\n");
}

async function nudgeUser(bot, user, eval_) {
  const text = buildMessage(eval_);
  const kb = new InlineKeyboard()
    .text("🔓 Show me /unlock", "dormant:unlock").row()
    .text("💰 Start /borrow", "dormant:borrow")
    .text("🔕 Don't show again", "dormant:optout");

  try {
    await bot.api.sendMessage(Number(user.telegram_id), text, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    await query(
      `UPDATE users
          SET last_dormant_nudge_at = NOW(),
              dormant_nudges_sent = dormant_nudges_sent + 1
        WHERE id = $1`,
      [user.id],
    );
    return { ok: true };
  } catch (err) {
    // Most common failures: bot blocked, chat deleted. Mark as opted out
    // so we don't keep failing on the same user every 6h.
    if (/blocked|deactivated|chat not found|user is deactivated/i.test(err.message || "")) {
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
    candidates = await findCandidate(bot);
  } catch (err) {
    console.error("[dormant] candidate query failed:", err.message);
    return;
  }

  if (candidates.length === 0) {
    console.log("[dormant] no eligible candidates this tick");
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const user of candidates) {
    if (sent >= NUDGES_PER_TICK) break;
    let eval_;
    try {
      eval_ = await evaluateUser(user.id);
    } catch (err) {
      console.warn(`[dormant] evaluate user ${user.id} failed:`, err.message);
      skipped++;
      continue;
    }
    if (!eval_) {
      // User doesn't hold meaningful collateral — bump nudge cooldown
      // anyway so we re-check in 30 days, not every 6h.
      await query(
        `UPDATE users SET last_dormant_nudge_at = NOW() WHERE id = $1`,
        [user.id],
      );
      skipped++;
      continue;
    }
    const r = await nudgeUser(bot, user, eval_);
    if (r.ok) sent++;
    else failed++;
    // Pace at ~500ms per DM to stay under Telegram's 30/s limit
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`[dormant] tick done: ${sent} sent, ${skipped} skipped (no collateral), ${failed} failed`);
}

export function startDormantReengagement(bot) {
  console.log(`[dormant] Starting (every ${POLL_INTERVAL_MS / 3_600_000}h, first run in ${FIRST_RUN_DELAY_MS / 60_000}min)`);
  setTimeout(() => tick(bot), FIRST_RUN_DELAY_MS);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}

export function registerDormantCallbacks(bot) {
  bot.callbackQuery("dormant:unlock", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleUnlock } = await import("../commands/unlock.js");
    await handleUnlock(ctx);
  });
  bot.callbackQuery("dormant:borrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleBorrow } = await import("../commands/borrow.js");
    await handleBorrow(ctx);
  });
  bot.callbackQuery("dormant:optout", async (ctx) => {
    await ctx.answerCallbackQuery("Opted out — you won't get these again.");
    const { upsertUser } = await import("./users.js");
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await query(
      `UPDATE users SET proactive_dms_disabled = TRUE WHERE id = $1`,
      [user.id],
    );
    await ctx.reply(
      "🔕 You won't get proactive nudges from us. You can still use /unlock / /borrow / /support any time.",
    );
  });
}
