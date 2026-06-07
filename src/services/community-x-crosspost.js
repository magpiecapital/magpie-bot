/**
 * Cross-post @MagpieLoans tweets into the Magpie community group.
 *
 * Two complementary paths, ordered by operational ease:
 *
 *   1. MANUAL (always available, zero infrastructure)
 *      Operator runs /crosspost <tweet-url> in any moderated chat (or
 *      DMs the operator-only command). Pip posts the URL to all
 *      enabled community chats with a "show some love" engagement
 *      prompt. Telegram's own OG-card preview renders the tweet
 *      content inline — we don't need to fetch it ourselves.
 *
 *   2. AUTO-POLL (optional, requires X API bearer token)
 *      If X_BEARER_TOKEN is set, a 5-min poller checks for new
 *      @MagpieLoans tweets via the X v2 user timeline endpoint,
 *      dedupes against community_x_seen, and posts them via the same
 *      crosspost path. Without the bearer token, this background
 *      worker is a no-op — manual still works.
 *
 * Defense rules:
 *   - Tweets posted to the community MUST be from @MagpieLoans
 *     specifically. Any other tweet URL is rejected. This matches the
 *     existing community URL allowlist (only @MagpieLoans tweets are
 *     allowed in the group at all).
 *   - We never auto-post the SAME tweet twice — community_x_seen
 *     deduplicates by tweet ID.
 *   - The cross-post text is templated (no LLM). Zero Anthropic cost.
 *   - Engagement prompt nudges likes/RTs but never asks users to
 *     follow random accounts or click external URLs other than the
 *     tweet itself.
 */
import { query } from "../db/pool.js";
import { listEnabledChats, isAllowedUrl } from "./community-moderation.js";

const X_HANDLE = "MagpieLoans";
const X_USER_ID_OVERRIDE = process.env.X_MAGPIE_USER_ID || ""; // optional speedup
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/* ──────────────── SHARED CROSS-POST CORE ───────────────── */

const ENGAGEMENT_LINES = [
  `Show some love — like + retweet keeps Magpie visible on X 🦅`,
  `If this resonates, RT it — engagement on @MagpieLoans helps the protocol reach more users.`,
  `Like + reply if you have thoughts — community signal helps @MagpieLoans grow.`,
  `Help amplify on X if you're into it — RTs from holders move the needle.`,
];
function pickEngagementLine() {
  return ENGAGEMENT_LINES[Math.floor(Math.random() * ENGAGEMENT_LINES.length)];
}

/**
 * Validate a tweet URL belongs to @MagpieLoans. Reuses the moderation
 * allowlist so the validation logic lives in one place.
 */
function isMagpieLoansTweetUrl(url) {
  if (!isAllowedUrl(url)) return false;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.toLowerCase();
    // Must be a TWEET URL specifically — host/MagpieLoans/status/<id>.
    // A bare-profile URL (host/MagpieLoans) isn't a tweet, so we
    // reject it to avoid posting profile links as if they were
    // announcements.
    if (!(host === "x.com" || host === "twitter.com")) return false;
    return /^\/magpieloans\/status\/\d+/.test(path);
  } catch {
    return false;
  }
}

/**
 * Extract the numeric tweet ID from a status URL. Returns null if the
 * URL isn't a valid x.com/MagpieLoans/status/<id> form.
 */
function extractTweetId(url) {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const m = parsed.pathname.match(/^\/magpieloans\/status\/(\d+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function tweetAlreadyPosted(tweetId) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM community_x_seen WHERE tweet_id = $1 LIMIT 1`,
      [String(tweetId)],
    );
    return rows.length > 0;
  } catch {
    return false; // fail-open: better to risk a dup than to silently skip everything
  }
}

async function markTweetPosted(tweetId, source) {
  try {
    await query(
      `INSERT INTO community_x_seen (tweet_id, source, posted_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tweet_id) DO NOTHING`,
      [String(tweetId), source],
    );
  } catch (err) {
    console.warn("[x-crosspost] markPosted failed:", err.message);
  }
}

/**
 * Core cross-post primitive. Posts the given tweet URL to every
 * moderated community chat with a Pip-flavored engagement intro.
 * Returns the number of chats successfully posted to.
 *
 * `source` is "manual" (operator-triggered) or "auto" (poller).
 */
export async function crosspostTweet(botApi, tweetUrl, source = "manual") {
  if (!isMagpieLoansTweetUrl(tweetUrl)) {
    throw new Error("not a @MagpieLoans tweet URL");
  }
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error("could not extract tweet id");
  if (await tweetAlreadyPosted(tweetId)) {
    return { skipped: true, reason: "already_posted", chats: 0 };
  }

  const intro = `🐦 *New from [@MagpieLoans](${tweetUrl}) on X*`;
  const engagement = pickEngagementLine();
  const text = `${intro}\n\n${tweetUrl}\n\n_${engagement}_`;

  let chats;
  try {
    chats = await listEnabledChats();
  } catch (err) {
    throw new Error(`could not list enabled chats: ${err.message}`);
  }

  let posted = 0;
  for (const c of chats) {
    try {
      await botApi.sendMessage(Number(c.chat_id), text, {
        parse_mode: "Markdown",
        // We WANT the OG card preview here — that's how TG renders the
        // tweet's image/text inline. The community URL filter only
        // allows @MagpieLoans tweets in the first place, so this is
        // consistent with the existing safety rules.
        disable_web_page_preview: false,
      });
      posted += 1;
    } catch (err) {
      console.warn(`[x-crosspost] send to ${c.chat_id} failed:`, err.message);
    }
  }

  if (posted > 0) {
    await markTweetPosted(tweetId, source);
  }
  console.log(`[x-crosspost] posted tweet ${tweetId} to ${posted}/${chats.length} chats (source=${source})`);
  return { skipped: false, chats: posted };
}

/* ──────────────── AUTO-POLLER (optional) ───────────────── */

let _userIdCache = X_USER_ID_OVERRIDE || null;
async function fetchMagpieLoansUserId() {
  if (_userIdCache) return _userIdCache;
  if (!X_BEARER_TOKEN) return null;
  try {
    const res = await fetch(`https://api.twitter.com/2/users/by/username/${X_HANDLE}`, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[x-crosspost] user-lookup HTTP", res.status);
      return null;
    }
    const body = await res.json();
    _userIdCache = body?.data?.id || null;
    return _userIdCache;
  } catch (err) {
    console.warn("[x-crosspost] user-lookup error:", err.message);
    return null;
  }
}

async function fetchRecentTweetIds() {
  if (!X_BEARER_TOKEN) return [];
  const userId = await fetchMagpieLoansUserId();
  if (!userId) return [];
  try {
    // Pull last 10 tweets; we'll dedupe via community_x_seen so
    // restarts + clock-skew don't cause duplicate posts.
    const url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&exclude=retweets,replies&tweet.fields=created_at`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 429 = rate limited; quiet so logs don't fill up
      if (res.status !== 429) {
        console.warn("[x-crosspost] timeline HTTP", res.status);
      }
      return [];
    }
    const body = await res.json();
    const tweets = Array.isArray(body?.data) ? body.data : [];
    return tweets.map((t) => ({
      id: String(t.id),
      url: `https://x.com/${X_HANDLE}/status/${t.id}`,
      created_at: t.created_at,
    }));
  } catch (err) {
    console.warn("[x-crosspost] timeline fetch error:", err.message);
    return [];
  }
}

async function pollAndCrosspost(botApi) {
  if (!X_BEARER_TOKEN) return; // no-op without API key
  const tweets = await fetchRecentTweetIds();
  // Process oldest-first so timeline order is preserved if multiple
  // new tweets land between polls.
  tweets.reverse();
  for (const t of tweets) {
    if (await tweetAlreadyPosted(t.id)) continue;
    try {
      await crosspostTweet(botApi, t.url, "auto");
    } catch (err) {
      console.warn(`[x-crosspost] auto-post ${t.id} failed:`, err.message);
    }
  }
}

let _pollTimer = null;
export function startXCrosspostPoller(bot) {
  if (!X_BEARER_TOKEN) {
    console.log("[x-crosspost] auto-poll DISABLED — set X_BEARER_TOKEN to enable. Manual /crosspost still available.");
    return;
  }
  console.log(`[x-crosspost] auto-poll starting (every ${POLL_INTERVAL_MS / 60000}min for @${X_HANDLE} tweets)`);
  // Initial fetch on startup (after a short delay so the rest of
  // startup can finish first).
  setTimeout(() => pollAndCrosspost(bot.api).catch((err) => console.warn("[x-crosspost] initial poll failed:", err.message)), 30_000);
  _pollTimer = setInterval(() => {
    pollAndCrosspost(bot.api).catch((err) => console.warn("[x-crosspost] poll failed:", err.message));
  }, POLL_INTERVAL_MS);
}

export function stopXCrosspostPoller() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}
