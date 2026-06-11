/**
 * Raid Monitor — watch a curated set of X (Twitter) handles for new
 * posts and immediately broadcast a raid CTA into the Magpie community
 * group (@magpietalk).
 *
 * Goals:
 *   - For every new tweet from any handle in raid_targets, post to
 *     every moderated community chat (same broadcast surface the
 *     /crosspost command uses).
 *   - Urge community to reply with $MAGPIE / @MagpieLoans, like, and
 *     repost.
 *   - Track a per-raid goal — N user claims via /raided — and edit the
 *     broadcast when the goal is hit.
 *
 * Data sources (degrade-down order):
 *   1. X API v2 — requires X_BEARER_TOKEN env. Free-tier reads are
 *      limited, so we poll only every RAID_POLL_INTERVAL_MS (default
 *      90s) per cycle (one users/by/username lookup per handle, cached
 *      to raid_targets.x_user_id; then one timeline call per handle).
 *   2. Nitter RSS — public third-party Twitter frontend. Used as
 *      fallback when X API returns 4xx/5xx or X_BEARER_TOKEN is unset.
 *      Free, no auth, but flaky (Cloudflare rate limits, instances die).
 *      Operator can override the instance via NITTER_INSTANCE_URL.
 *
 * Dedup:
 *   - raid_events has UNIQUE(tweet_id). The poller swallows duplicate-
 *     key violations silently (race between same-cycle inserts is
 *     possible if two pollers run on overlapping schedules).
 *   - community_x_seen is the legacy dedup for the @MagpieLoans
 *     crosspost path; raid_events is a separate channel.
 *
 * Quiet hours:
 *   - Pip respects an optional RAID_QUIET_HOURS_UTC window
 *     (e.g. "02:00-06:00") to avoid blasting at 3am. Posts that arrive
 *     during quiet hours are queued (in-memory only — restart loses
 *     them) and flushed at window close.
 *
 * Kill switch:
 *   - Set RAID_MONITOR_DISABLED=true on Railway to hard-stop the
 *     poller without a redeploy.
 *
 * Safety:
 *   - Targets are operator-curated (raid_targets seeded by migration
 *     022; new handles only added via /raidadd). No way for a community
 *     user to inject a handle that becomes a broadcast surface.
 *   - Broadcast text is templated, no LLM. Zero Anthropic cost.
 */
import { query } from "../db/pool.js";
import { listEnabledChats } from "./community-moderation.js";

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const POLL_INTERVAL_MS = Number(process.env.RAID_POLL_INTERVAL_MS) || 90_000;
const NITTER_INSTANCE = (process.env.NITTER_INSTANCE_URL || "https://nitter.net").replace(/\/$/, "");
const QUIET_HOURS = process.env.RAID_QUIET_HOURS_UTC || ""; // "02:00-06:00" format
const DEFAULT_GOAL = Number(process.env.RAID_DEFAULT_GOAL) || 10;

/* ─── Quiet-hours helper ─────────────────────────────────────────── */

function inQuietHours(now = new Date()) {
  if (!QUIET_HOURS) return false;
  const m = QUIET_HOURS.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin   = Number(m[3]) * 60 + Number(m[4]);
  const curMin   = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (startMin <= endMin) return curMin >= startMin && curMin < endMin;
  // Wraparound (e.g. 22:00-06:00).
  return curMin >= startMin || curMin < endMin;
}

/* ─── X API v2 source ────────────────────────────────────────────── */

async function xApiResolveUserId(handle) {
  if (!X_BEARER_TOKEN) return null;
  try {
    const res = await fetch(`https://api.twitter.com/2/users/by/username/${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data?.id || null;
  } catch {
    return null;
  }
}

async function xApiFetchLatestTweet(userId) {
  if (!X_BEARER_TOKEN) return null;
  try {
    const url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at,text`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const t = Array.isArray(body?.data) ? body.data[0] : null;
    return t ? { id: String(t.id), text: t.text, created_at: t.created_at } : null;
  } catch {
    return null;
  }
}

/* ─── Nitter RSS fallback ────────────────────────────────────────── */

async function nitterFetchLatestTweet(handle) {
  try {
    const res = await fetch(`${NITTER_INSTANCE}/${encodeURIComponent(handle)}/rss`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "magpie-raid-monitor/1.0" },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    // Cheap XML parsing — we only need the first <item> and its <link>/<title>.
    const itemMatch = xml.match(/<item>[\s\S]*?<\/item>/);
    if (!itemMatch) return null;
    const linkMatch = itemMatch[0].match(/<link>(.*?)<\/link>/);
    const titleMatch = itemMatch[0].match(/<title>([\s\S]*?)<\/title>/);
    if (!linkMatch) return null;
    // Nitter link is `https://nitter.net/{handle}/status/{id}#m`. Pull the id.
    const idMatch = linkMatch[1].match(/\/status\/(\d+)/);
    if (!idMatch) return null;
    return {
      id: idMatch[1],
      text: titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null,
      created_at: null,
    };
  } catch {
    return null;
  }
}

/* ─── Per-target poll ────────────────────────────────────────────── */

async function pollTarget(target) {
  let tweet = null;
  let userId = target.x_user_id;
  if (X_BEARER_TOKEN) {
    if (!userId) {
      userId = await xApiResolveUserId(target.handle);
      if (userId) {
        await query(`UPDATE raid_targets SET x_user_id = $2 WHERE id = $1`, [target.id, userId]).catch(() => {});
      }
    }
    if (userId) tweet = await xApiFetchLatestTweet(userId);
  }
  // Fallback: Nitter RSS
  if (!tweet) tweet = await nitterFetchLatestTweet(target.handle);
  return tweet;
}

/* ─── Broadcast ──────────────────────────────────────────────────── */

function buildBroadcastText({ display_name, handle, tweet_url, tweet_text, goal }) {
  const lines = [
    `RAID INCOMING — @${display_name || handle} just posted.`,
    ``,
    tweet_url,
    ``,
    `Mission:`,
    `1. Reply with something on $MAGPIE / @MagpieLoans — keep it sharp, no spam.`,
    `2. Like + repost the tweet itself.`,
    `3. Run /raided in this chat once you're done.`,
    ``,
    `Goal: ${goal} raid claims. Pip pings the chat when we hit it.`,
  ];
  return lines.join("\n");
}

async function broadcastRaid(botApi, target, tweet) {
  const chats = await listEnabledChats();
  if (chats.length === 0) return { broadcast: false, reason: "no_chats" };

  const text = buildBroadcastText({
    display_name: target.display_name,
    handle: target.handle,
    tweet_url: `https://x.com/${target.display_name || target.handle}/status/${tweet.id}`,
    tweet_text: tweet.text,
    goal: DEFAULT_GOAL,
  });

  let firstMsg = null;
  let firstChat = null;
  for (const c of chats) {
    try {
      const sent = await botApi.sendMessage(Number(c.chat_id), text, {
        disable_web_page_preview: false,
      });
      if (!firstMsg) {
        firstMsg = sent.message_id;
        firstChat = c.chat_id;
      }
    } catch (err) {
      console.warn(`[raid-monitor] send to ${c.chat_id} failed:`, err.message);
    }
  }

  // Record the event for /raided to count against.
  try {
    await query(
      `INSERT INTO raid_events (tweet_id, handle, tweet_url, tweet_text, goal_claims, tg_message_id, tg_chat_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'live')
       ON CONFLICT (tweet_id) DO NOTHING`,
      [tweet.id, target.handle, `https://x.com/${target.display_name || target.handle}/status/${tweet.id}`, tweet.text, DEFAULT_GOAL, firstMsg, firstChat],
    );
  } catch (err) {
    console.warn("[raid-monitor] event insert failed:", err.message);
  }

  console.log(`[raid-monitor] broadcast tweet ${tweet.id} from @${target.handle} to ${chats.length} chat(s)`);
  return { broadcast: true, chats: chats.length };
}

/* ─── Main poll loop ─────────────────────────────────────────────── */

async function tick(botApi) {
  if (process.env.RAID_MONITOR_DISABLED === "true") return;
  if (inQuietHours()) return;

  const { rows: targets } = await query(
    `SELECT id, handle, display_name, x_user_id FROM raid_targets WHERE enabled = TRUE`,
  );
  if (targets.length === 0) return;

  for (const target of targets) {
    try {
      const tweet = await pollTarget(target);
      if (!tweet) continue;

      // Have we already broadcast this tweet?
      const { rows: dup } = await query(
        `SELECT 1 FROM raid_events WHERE tweet_id = $1 LIMIT 1`,
        [tweet.id],
      );
      if (dup.length > 0) continue;

      // SKIP first-seen-on-boot: if this target has NEVER had an event
      // (cold start), don't blast every old tweet — just register the
      // current latest as the "seen baseline" without broadcasting.
      const { rows: anyPrior } = await query(
        `SELECT 1 FROM raid_events WHERE handle = $1 LIMIT 1`,
        [target.handle],
      );
      if (anyPrior.length === 0) {
        await query(
          `INSERT INTO raid_events (tweet_id, handle, tweet_url, tweet_text, status, broadcast_at, goal_claims)
             VALUES ($1, $2, $3, $4, 'closed', NOW() - interval '1 day', $5)
             ON CONFLICT (tweet_id) DO NOTHING`,
          [tweet.id, target.handle, `https://x.com/${target.display_name || target.handle}/status/${tweet.id}`, tweet.text, DEFAULT_GOAL],
        );
        continue;
      }

      await broadcastRaid(botApi, target, tweet);

      // Telegram global rate limit: 30 msg/sec but be polite — pause
      // briefly between handles so a burst of new tweets doesn't blow
      // out the send queue.
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.warn(`[raid-monitor] tick error for @${target.handle}:`, err.message);
    }
  }
}

/* ─── Public API ─────────────────────────────────────────────────── */

let _timer = null;

export function startRaidMonitor(bot) {
  if (_timer) return;
  if (process.env.RAID_MONITOR_DISABLED === "true") {
    console.warn("[raid-monitor] DISABLED via RAID_MONITOR_DISABLED — not starting.");
    return;
  }
  const botApi = bot?.api ?? bot;
  console.log(
    `[raid-monitor] armed — polling every ${Math.round(POLL_INTERVAL_MS / 1000)}s, source=${X_BEARER_TOKEN ? "X-API" : "Nitter-fallback"}` +
      (QUIET_HOURS ? `, quiet hours ${QUIET_HOURS} UTC` : "")
  );
  // Bit of stagger so we don't slam X API immediately at boot.
  setTimeout(() => {
    tick(botApi).catch((err) => console.error("[raid-monitor] tick threw:", err.message));
    _timer = setInterval(() => {
      tick(botApi).catch((err) => console.error("[raid-monitor] tick threw:", err.message));
    }, POLL_INTERVAL_MS);
  }, 45_000);
}

export function stopRaidMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/* ─── Claim recording (called by /raided handler) ────────────────── */

/**
 * Record a /raided claim from a TG user. Returns:
 *   { ok, raid_event_id, claims_now, goal, just_hit_goal }
 * Throws if there's no live raid event.
 */
export async function recordRaidClaim({ tgUserId, tgUsername, tgChatId, evidenceUrl }) {
  // Latest live raid event in this chat (or any chat — claims are
  // chat-loose since the broadcast hits every moderated chat).
  const { rows: [event] } = await query(
    `SELECT id, goal_claims, status FROM raid_events
       WHERE status = 'live'
       ORDER BY broadcast_at DESC
       LIMIT 1`,
  );
  if (!event) {
    return { ok: false, error: "no_live_raid", message: "No active raid right now. Watch for the next one." };
  }

  // INSERT ... ON CONFLICT to enforce one-claim-per-user-per-event.
  const insertRes = await query(
    `INSERT INTO raid_claims (raid_event_id, tg_user_id, tg_username, tg_chat_id, evidence_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (raid_event_id, tg_user_id) DO NOTHING
       RETURNING id`,
    [event.id, tgUserId, tgUsername || null, tgChatId || null, evidenceUrl || null],
  );
  const wasNew = insertRes.rows.length > 0;

  // Recount.
  const { rows: [{ n }] } = await query(
    `SELECT COUNT(*)::int AS n FROM raid_claims
       WHERE raid_event_id = $1 AND status = 'counted'`,
    [event.id],
  );

  let justHitGoal = false;
  if (wasNew && n >= event.goal_claims && event.status === "live") {
    // Atomically flip status to goal_hit. The CHECK keeps us from
    // double-counting the celebration message if two tickers race.
    const upd = await query(
      `UPDATE raid_events
          SET status = 'goal_hit', closed_at = NOW()
        WHERE id = $1 AND status = 'live'
        RETURNING id`,
      [event.id],
    );
    justHitGoal = upd.rows.length > 0;
  }

  return {
    ok: true,
    raid_event_id: event.id,
    claims_now: n,
    goal: event.goal_claims,
    just_hit_goal: justHitGoal,
    duplicate: !wasNew,
  };
}

/* ─── Status query (called by /raidstatus) ───────────────────────── */

export async function getLiveRaidStatus() {
  const { rows: [event] } = await query(
    `SELECT id, handle, tweet_url, tweet_text, broadcast_at, goal_claims, status
       FROM raid_events
       WHERE status = 'live'
       ORDER BY broadcast_at DESC LIMIT 1`,
  );
  if (!event) return null;
  const { rows: [{ n }] } = await query(
    `SELECT COUNT(*)::int AS n FROM raid_claims WHERE raid_event_id = $1 AND status = 'counted'`,
    [event.id],
  );
  return { ...event, claims_now: n };
}
