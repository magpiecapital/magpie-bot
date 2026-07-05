/**
 * Impersonator watchdog — periodic auto-scan for impersonators that
 * slipped past the on-join filter.
 *
 * Why this exists
 * ───────────────
 * The on-join handler (src/handlers/community-handlers.js
 * `handleNewMembers`) runs the IMPERSONATION_PATTERNS check the
 * moment a new_chat_members event arrives. Two known ways a
 * legitimate impersonator can slip past that real-time filter:
 *
 *   1. **Bot was down during the join.** TG queues update events
 *      while the bot is restarting and replays them on reconnect,
 *      so in theory the join is still processed. In practice, a
 *      crash-loop window (e.g. the 2026-06-13 04:22Z self-monitor
 *      outage) can mean updates time out before the bot is healthy
 *      enough to process them.
 *
 *   2. **Pattern was added AFTER the user joined.** Example: \bpip\b
 *      was added to IMPERSONATION_PATTERNS in PR #129 after the
 *      live Pip impersonator. Anyone with "Pip" as their display
 *      name who joined BEFORE that pattern landed isn't auto-flagged
 *      retroactively.
 *
 * This watchdog runs every SCAN_INTERVAL_MS and applies the CURRENT
 * IMPERSONATION_PATTERNS list against a sliding window of recent
 * joins. Each hit triggers the same action as the on-join handler
 * (kick + record + announce). Defense-in-depth on top of the
 * real-time filter, not a replacement for it.
 *
 * Operator-stated mandate (2026-06-13): "we need to be better and
 * prepared for EVERY circumstance" — proactive on the impersonator
 * detection path specifically.
 */
import { query } from "../db/pool.js";
import { isImpersonationName, isVerifiedAccount, recordModAction, isUserCleared, nameKey } from "./community-moderation.js";

const SCAN_INTERVAL_MS = Number(process.env.IMPERSONATOR_SCAN_INTERVAL_MS) || 30 * 60_000; // 30 min default
// Scan the ENTIRE membership, not just recent joiners (operator 2026-07-04,
// "keep impersonators out at all costs"). The old 24h window let anyone who
// joined earlier and RENAMED into an impersonator/homoglyph handle slip past
// the watchdog forever (only the message-ban would catch them, and only if
// they posted). Default is effectively unbounded (10y); the per-member cooldown
// below + the per-cycle cap keep the TG API load sane even for a large group.
const SCAN_WINDOW_HOURS = Number(process.env.IMPERSONATOR_SCAN_WINDOW_HOURS) || 24 * 365 * 10;
// Bounded TG API throughput — getChatMember is rate-limited around
// 30 req/sec. 50ms gap keeps us well below.
const GET_MEMBER_GAP_MS = 50;
// Per-cycle cap so a backlog can't run forever or hit TG rate limits. Raised so
// a whole realistic membership is covered in a single cycle (cooldown-eligible
// members per cycle is far lower once the cooldown map warms up).
const MAX_MEMBERS_PER_CYCLE = Number(process.env.IMPERSONATOR_MAX_PER_CYCLE) || 5_000;

// Suppress re-scanning the same member repeatedly. Once we've checked
// a (chat_id, user_id) within COOLDOWN_HOURS we don't re-check unless
// the patterns list itself has changed (operator deploy = new boot =
// in-memory cooldown reset = re-scan everyone fresh, which is desired).
// Tightened 12h → 2h (operator 2026-07-04) so a rename into an impersonator
// handle is caught within ~2h even if the member never posts a message.
const checkedRecently = new Map(); // key: `${chatId}:${userId}` → ms ts
const COOLDOWN_MS = Number(process.env.IMPERSONATOR_RECHECK_COOLDOWN_HOURS || 2) * 3_600_000;

function cooldownKey(chatId, userId) { return `${chatId}:${userId}`; }

async function scanChat(bot, chatId) {
  let scanned = 0;
  let flagged = 0;
  let skippedCooldown = 0;
  let skippedErrors = 0;

  const { rows: members } = await query(
    `SELECT user_id, joined_at
       FROM community_members
      WHERE chat_id = $1
        AND joined_at > NOW() - ($2 || ' hours')::INTERVAL
      ORDER BY joined_at DESC
      LIMIT $3`,
    [String(chatId), String(SCAN_WINDOW_HOURS), MAX_MEMBERS_PER_CYCLE],
  );

  const now = Date.now();
  for (const row of members) {
    const cdKey = cooldownKey(chatId, row.user_id);
    const lastCheck = checkedRecently.get(cdKey);
    if (lastCheck && now - lastCheck < COOLDOWN_MS) {
      skippedCooldown++;
      continue;
    }

    let member;
    try {
      member = await bot.api.getChatMember(chatId, Number(row.user_id));
    } catch (err) {
      skippedErrors++;
      // 400 (user left) / 403 (bot kicked) shouldn't spam the logs.
      const msg = err.message || "";
      if (!/user not found|left|kicked|chat not found/i.test(msg)) {
        console.warn(`[impersonator-watch] getChatMember ${row.user_id} failed:`, msg.slice(0, 100));
      }
      continue;
    } finally {
      checkedRecently.set(cdKey, now);
    }
    scanned++;

    const u = member?.user;
    if (!u) continue;
    if (isVerifiedAccount(u)) continue;
    if (member.status === "left" || member.status === "kicked") continue;
    if (!isImpersonationName(u)) continue;
    // Pip's memory: never re-ban a member already cleared via appeal/operator
    // (name-scoped — a rename into a fresh impersonation handle is NOT cleared).
    if (await isUserCleared(chatId, row.user_id, nameKey(u))) continue;

    // HIT — auto-kick (matches on-join handler's action on a flagged
    // joiner that also failed captcha). The exact "warn vs. ban"
    // policy lives in handleNewMembers; the watchdog applies the
    // stricter "auto-ban" because we're catching this AFTER a join,
    // which means either the on-join filter missed it (real-time
    // race) or the user joined before the relevant pattern existed.
    // In both cases a deliberate impersonator name is the right
    // signal for removal.
    flagged++;
    try {
      const until = Math.floor(Date.now() / 1000) + 60; // brief ban, then unban so they can re-join with a clean name
      await bot.api.banChatMember(chatId, Number(row.user_id), { until_date: until });
      await recordModAction(
        chatId, row.user_id, "watchdog_auto_ban_impersonation",
        "watchdog retroactive scan matched IMPERSONATION_PATTERNS",
        JSON.stringify({
          username: u.username, first: u.first_name, last: u.last_name,
          status_was: member.status,
        }),
      );
      // Best-effort group notice — matches the existing on-join handler's
      // "Heads up: a new account…" pattern but adapted for retroactive.
      try {
        await bot.api.sendMessage(
          chatId,
          `🛡 *Watchdog kick — impersonator removed*\n\n` +
          `Display name resembled official Magpie support and was removed. Never DM strangers about your wallet. ` +
          `The only official account is @magpie_capital_bot.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* permission issue / chat-permissions block — skip */ }
      // Best-effort: tell the removed user how to appeal (no-ops if they never
      // DM'd the bot). The self-heal is useless if false positives never learn
      // /appeal exists.
      try {
        await bot.api.sendMessage(
          Number(row.user_id),
          `You were removed from the Magpie community because your name matched our Magpie-staff impersonation filter.\n\n` +
          `If you're a real member and this was a mistake, reply with /appeal and Pip will review it instantly and let you back in if it was wrong.`,
        );
      } catch { /* user never started the bot — nothing we can do */ }
    } catch (err) {
      console.warn(`[impersonator-watch] ban failed for ${row.user_id}:`, err.message?.slice(0, 100));
    }

    if (GET_MEMBER_GAP_MS > 0) await new Promise((r) => setTimeout(r, GET_MEMBER_GAP_MS));
  }

  return { scanned, flagged, skippedCooldown, skippedErrors, candidates: members.length };
}

async function tick(bot) {
  try {
    // Sweep every enabled community chat. Most deploys have a single
    // chat (@magpietalk) but the schema supports multi.
    const { rows: chats } = await query(
      `SELECT chat_id FROM community_chats WHERE enabled = TRUE`,
    );
    if (chats.length === 0) return;

    let totalScanned = 0;
    let totalFlagged = 0;
    for (const c of chats) {
      const r = await scanChat(bot, c.chat_id);
      totalScanned += r.scanned;
      totalFlagged += r.flagged;
      if (r.flagged > 0) {
        console.log(`[impersonator-watch] chat=${c.chat_id} flagged=${r.flagged} of ${r.scanned} scanned`);
      }
    }
    if (totalFlagged > 0) {
      // DM the operator — they should know whenever the watchdog
      // catches something the real-time filter missed.
      const adminId = process.env.ADMIN_TG_ID;
      if (adminId) {
        try {
          await bot.api.sendMessage(
            Number(adminId),
            `🛡 *Impersonator watchdog fired*\n\n` +
            `Auto-removed *${totalFlagged}* impersonator(s) from ${chats.length} chat(s) (scanned ${totalScanned} recent joins). ` +
            `Watchdog covers anyone who joined during a bot-down window or before a relevant pattern was added.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* DM failure isn't fatal */ }
      }
    }
  } catch (err) {
    console.warn("[impersonator-watch] tick threw:", err.message?.slice(0, 100));
  }
}

export function startImpersonatorWatchdog(bot) {
  if (!bot) return;
  const windowLabel = SCAN_WINDOW_HOURS >= 24 * 365 ? "the FULL membership" : `a ${SCAN_WINDOW_HOURS}h window`;
  console.log(`[impersonator-watch] armed — sweeping every ${SCAN_INTERVAL_MS / 60_000} min over ${windowLabel} (recheck cooldown ${COOLDOWN_MS / 3_600_000}h)`);
  // First tick after a 5-min startup delay so the bot finishes its
  // own onboarding before we start hammering getChatMember.
  setTimeout(() => tick(bot).catch((e) => console.warn("[impersonator-watch] first tick:", e.message?.slice(0, 80))), 5 * 60_000);
  setInterval(() => tick(bot).catch((e) => console.warn("[impersonator-watch] tick:", e.message?.slice(0, 80))), SCAN_INTERVAL_MS);
}
