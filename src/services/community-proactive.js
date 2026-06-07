/**
 * Pip's PROACTIVE layer for the community group.
 *
 * Three features, ordered by cost:
 *
 *   1. postCaptchaWelcome  — fires on captcha-pass. Static template,
 *                            ZERO Anthropic cost. Variety via rotating
 *                            phrasing.
 *
 *   2. milestone ticker     — runs every 30 minutes. Looks at protocol
 *                             state (new approved tokens, round-number
 *                             milestones in active loans / 24h volume).
 *                             If a milestone has crossed since the last
 *                             check AND we haven't already announced it,
 *                             post a templated celebration. Throttled to
 *                             at most 1 milestone post per chat per 3h.
 *                             ZERO Anthropic cost.
 *
 *   3. lingering-question pickup — runs every 5 minutes. Selects up to 1
 *                             unanswered question per chat that's >10min
 *                             old, hasn't been replied to in chat, and
 *                             passes a Magpie-relevance keyword filter.
 *                             Single Sonnet call via existing
 *                             answerGroupQuestion(). Hard caps:
 *                               - 1 per chat per hour
 *                               - DAILY_PROACTIVE_MAX per chat per day
 *                               - global env-var kill switch
 *
 * Cost discipline (operator directive — Anthropic credits must not
 * drain):
 *   - All proactive features respect PIP_PROACTIVE_DISABLED=1
 *   - Question pickup also respects PIP_DAILY_PROACTIVE_MAX (default 5
 *     per chat per UTC day)
 *   - Question pickup uses a strict keyword pre-filter; we will NOT call
 *     the LLM unless the question genuinely references the protocol
 *   - Reactive /ask is NOT affected by these caps — only proactive paths
 */
import { query } from "../db/pool.js";
import { listEnabledChats } from "./community-moderation.js";
import { answerGroupQuestion } from "./community-pip.js";

const PROACTIVE_DISABLED = process.env.PIP_PROACTIVE_DISABLED === "1";
const DAILY_PROACTIVE_MAX = Math.max(0, Number(process.env.PIP_DAILY_PROACTIVE_MAX) || 5);
const QUESTION_PICKUP_INTERVAL_MS = 5 * 60 * 1000;
const MILESTONE_INTERVAL_MS = 30 * 60 * 1000;
const QUESTION_MIN_AGE_MS = 10 * 60 * 1000;          // wait 10min before stepping in
const QUESTION_MAX_AGE_MS = 60 * 60 * 1000;          // ignore older than 1h
const PICKUP_GAP_MS = 60 * 60 * 1000;                // 1h gap between pickups in a chat
const MILESTONE_GAP_MS = 3 * 60 * 60 * 1000;         // 3h between milestone posts

/* ────────────────────────── WELCOME ─────────────────────────── */

const WELCOME_TEMPLATES = [
  (name) => `👋 Welcome ${name} — glad you made it past the bot-gate. I'm *Pip*, Magpie's AI agent. Hit me with \`/ask <question>\` anytime; for anything tied to your wallet, DM me at @magpie\\_capital\\_bot.`,
  (name) => `Welcome to Magpie, ${name}. New here? Type \`/ask\` followed by any question — fees, tiers, how repayment works, whatever. For your actual wallet stuff, the private bot is @magpie\\_capital\\_bot.`,
  (name) => `🎉 ${name} just joined. I'm Pip — drop a \`/ask <question>\` if anything's unclear. Wallet + loans live in DM with @magpie\\_capital\\_bot, never in here.`,
  (name) => `Welcome ${name} 👋 — heads up: I auto-clean links and scam patterns, and *no one* from Magpie will ever DM you first. If someone does, it's a scammer. Stay safe.`,
];

function pickWelcome(name) {
  const tpl = WELCOME_TEMPLATES[Math.floor(Math.random() * WELCOME_TEMPLATES.length)];
  return tpl(name);
}

function displayName(tgUser) {
  if (!tgUser) return "friend";
  if (tgUser.username) return `@${tgUser.username}`;
  const first = (tgUser.first_name || "").trim();
  return first || "friend";
}

/** Post an in-group welcome after a member passes the captcha.
 *  Templated, zero LLM cost. Best-effort; failures are non-fatal. */
export async function postCaptchaWelcome(botApi, chatId, tgUser) {
  if (PROACTIVE_DISABLED) return;
  const name = displayName(tgUser);
  const text = pickWelcome(name);
  try {
    await botApi.sendMessage(Number(chatId), text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.warn(`[proactive] captcha-welcome to ${chatId} failed:`, err.message);
  }
}

/* ───────────────────── QUESTION TRACKING ────────────────────── */

// Pre-filter: a message is a candidate question if it ends in '?', is
// 8-300 chars, AND mentions at least one Magpie-relevant keyword. The
// keyword filter is what keeps Anthropic spend bounded — random "hello?"
// chatter never makes it into the table.
const QUESTION_KEYWORDS = [
  // protocol nouns
  "magpie", "loan", "borrow", "repay", "collateral", "liquidation",
  "ltv", "tier", "fee", "deposit", "withdraw", "lp", "earn", "yield",
  "credit", "credit score", "$magpie", "magpie token", "holder",
  "extend", "topup", "top-up", "refer", "referral", "pool",
  // common how-to verbs
  "how do i", "how does", "what happens", "what's the", "can i ",
  "is it safe", "is there", "do i need", "what tier", "how long",
];

function isCandidateQuestion(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 300) return false;
  if (!trimmed.endsWith("?")) return false;
  const lower = trimmed.toLowerCase();
  // command messages aren't questions (already routed elsewhere)
  if (lower.startsWith("/")) return false;
  for (const kw of QUESTION_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/**
 * Called for every inbound non-command message in a moderated group.
 *
 *   - If msg is a reply to an older message that we tracked as a
 *     pending question, mark THAT question as "answered_in_chat_at"
 *     — a human stepped in, Pip should leave it alone.
 *
 *   - Else if msg itself is a candidate question, record it as
 *     pending. The sweep will consider it after QUESTION_MIN_AGE_MS.
 *
 * Both branches are DB-only; zero LLM cost.
 */
export async function trackInboundForProactivePip(chatId, msg, sender) {
  if (PROACTIVE_DISABLED) return;
  if (!msg) return;
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo) {
    try {
      await query(
        `UPDATE community_pending_questions
            SET answered_in_chat_at = NOW()
          WHERE chat_id = $1 AND message_id = $2
            AND answered_in_chat_at IS NULL
            AND pip_picked_up_at IS NULL`,
        [Number(chatId), Number(replyTo)],
      );
    } catch (err) {
      console.warn("[proactive] mark-answered failed:", err.message);
    }
  }
  const text = (msg.text || msg.caption || "").trim();
  if (!isCandidateQuestion(text)) return;
  try {
    await query(
      `INSERT INTO community_pending_questions
         (chat_id, message_id, sender_id, text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id, message_id) DO NOTHING`,
      [Number(chatId), Number(msg.message_id), Number(sender.id), text.slice(0, 1500)],
    );
  } catch (err) {
    console.warn("[proactive] insert-pending failed:", err.message);
  }
}

/* ───────────────────── QUESTION PICKUP ──────────────────────── */

// Pickup counter is derived from DB (pip_picked_up_at within the current
// UTC day) rather than memory — survives bot restarts so the daily cap
// can't be reset by a redeploy. One indexed query per chat per sweep is
// trivially cheap given the sweep interval (5min) and chat count (<10).
async function getPickupsToday(chatId) {
  try {
    const { rows: [r] } = await query(
      `SELECT COUNT(*)::int AS n
         FROM community_pending_questions
        WHERE chat_id = $1
          AND pip_picked_up_at IS NOT NULL
          AND pip_picked_up_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
      [Number(chatId)],
    );
    return r?.n ?? 0;
  } catch {
    // Fail SAFE — treat as "at cap" so we don't accidentally over-spend.
    return DAILY_PROACTIVE_MAX;
  }
}

async function lastPickupAt(chatId) {
  try {
    const { rows: [r] } = await query(
      `SELECT MAX(pip_picked_up_at) AS last
         FROM community_pending_questions
        WHERE chat_id = $1 AND pip_picked_up_at IS NOT NULL`,
      [Number(chatId)],
    );
    return r?.last ? new Date(r.last) : null;
  } catch {
    return null;
  }
}

async function pickQuestionForChat(chatId) {
  // Oldest unanswered candidate within the eligible window.
  const { rows } = await query(
    `SELECT message_id, sender_id, text
       FROM community_pending_questions
      WHERE chat_id = $1
        AND pip_picked_up_at IS NULL
        AND answered_in_chat_at IS NULL
        AND created_at < NOW() - INTERVAL '10 minutes'
        AND created_at > NOW() - INTERVAL '60 minutes'
      ORDER BY created_at ASC
      LIMIT 1`,
    [Number(chatId)],
  );
  return rows[0] || null;
}

async function markPickedUp(chatId, messageId) {
  try {
    await query(
      `UPDATE community_pending_questions
          SET pip_picked_up_at = NOW()
        WHERE chat_id = $1 AND message_id = $2`,
      [Number(chatId), Number(messageId)],
    );
  } catch (err) {
    console.warn("[proactive] mark-picked-up failed:", err.message);
  }
}

async function sweepProactiveQuestions(botApi) {
  if (PROACTIVE_DISABLED) return;
  if (DAILY_PROACTIVE_MAX <= 0) return;

  let chats;
  try {
    chats = await listEnabledChats();
  } catch (err) {
    console.warn("[proactive] listEnabledChats failed:", err.message);
    return;
  }

  for (const c of chats) {
    const chatId = Number(c.chat_id);
    try {
      const picksToday = await getPickupsToday(chatId);
      if (picksToday >= DAILY_PROACTIVE_MAX) continue;
      const last = await lastPickupAt(chatId);
      if (last && Date.now() - last.getTime() < PICKUP_GAP_MS) continue;
      const q = await pickQuestionForChat(chatId);
      if (!q) continue;

      // Single Sonnet call via the existing /ask path. ~$0.005.
      const answer = await answerGroupQuestion(q.text);
      if (!answer) {
        // Fail-open: don't mark picked up so it can be retried next sweep
        // (and naturally ages out via QUESTION_MAX_AGE_MS).
        continue;
      }

      // Reply directly to the original question — keeps thread context.
      const prefix = `_Hey — I noticed this went unanswered. Hope this helps_ 👇\n\n`;
      try {
        await botApi.sendMessage(chatId, prefix + answer, {
          reply_to_message_id: Number(q.message_id),
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });
      } catch (err) {
        // Telegram may reject reply_to if the message was deleted; retry
        // without the reply_to so the answer still surfaces.
        try {
          await botApi.sendMessage(chatId, prefix + answer, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          });
        } catch (err2) {
          console.warn(`[proactive] send to ${chatId} failed:`, err2.message);
          continue;
        }
      }
      await markPickedUp(chatId, q.message_id);
      console.log(`[proactive] picked up question in ${chatId} (msg ${q.message_id})`);
    } catch (err) {
      console.warn(`[proactive] sweep ${chatId} failed:`, err.message);
    }
  }
}

/* ───────────────────── MILESTONE TICKER ─────────────────────── */

// Define which thresholds we celebrate. Sparse on purpose — we don't
// want Pip going "10 loans!" "11 loans!" "12 loans!" That's annoying.
// Each entry: { key, label, check(state) → boolean, message(state) → text }
const MILESTONES = [
  { thr: 50,   key: "active_loans_50" },
  { thr: 100,  key: "active_loans_100" },
  { thr: 250,  key: "active_loans_250" },
  { thr: 500,  key: "active_loans_500" },
  { thr: 1000, key: "active_loans_1000" },
].map((m) => ({
  ...m,
  matches: (active) => active >= m.thr,
  message: (active, repaid) =>
    `🎉 *Milestone* — Magpie just crossed *${m.thr} active loans*. ` +
    `Total repaid lifetime: ${repaid}. Thanks for being part of it.`,
}));

async function fetchProtocolState() {
  const { rows: [r] } = await query(
    `SELECT
       (SELECT COUNT(*) FROM loans WHERE status='active')::int     AS active,
       (SELECT COUNT(*) FROM loans WHERE status='repaid')::int     AS repaid,
       (SELECT COUNT(*) FROM supported_mints WHERE enabled=TRUE)::int AS tokens`,
  );
  return r;
}

async function unseen(chatId, key) {
  const { rows } = await query(
    `SELECT 1 FROM community_milestones_seen WHERE chat_id=$1 AND milestone_key=$2`,
    [Number(chatId), key],
  );
  return rows.length === 0;
}

async function markSeen(chatId, key) {
  try {
    await query(
      `INSERT INTO community_milestones_seen (chat_id, milestone_key)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [Number(chatId), key],
    );
  } catch (err) {
    console.warn("[proactive] markSeen failed:", err.message);
  }
}

async function lastMilestoneAt(chatId) {
  const { rows: [r] } = await query(
    `SELECT MAX(posted_at) AS last FROM community_milestones_seen WHERE chat_id=$1`,
    [Number(chatId)],
  );
  return r?.last ? new Date(r.last) : null;
}

async function sweepMilestones(botApi) {
  if (PROACTIVE_DISABLED) return;
  let state;
  try {
    state = await fetchProtocolState();
  } catch (err) {
    console.warn("[proactive] protocol-state fetch failed:", err.message);
    return;
  }
  let chats;
  try {
    chats = await listEnabledChats();
  } catch {
    return;
  }

  for (const c of chats) {
    const chatId = Number(c.chat_id);
    try {
      // Respect global per-chat milestone gap (3h between any
      // milestone posts to avoid double-celebrating clusters).
      const last = await lastMilestoneAt(chatId);
      if (last && Date.now() - last.getTime() < MILESTONE_GAP_MS) continue;

      // Pick the HIGHEST milestone we've crossed but haven't announced
      // yet. We only post one at a time.
      let toPost = null;
      for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const m = MILESTONES[i];
        if (!m.matches(state.active)) continue;
        if (await unseen(chatId, m.key)) {
          toPost = m;
          break;
        }
      }
      if (!toPost) continue;

      const text = toPost.message(state.active, state.repaid);
      try {
        await botApi.sendMessage(chatId, text, { parse_mode: "Markdown" });
        await markSeen(chatId, toPost.key);
        console.log(`[proactive] milestone ${toPost.key} → chat ${chatId}`);
      } catch (err) {
        console.warn(`[proactive] milestone post to ${chatId} failed:`, err.message);
      }
    } catch (err) {
      console.warn(`[proactive] milestone sweep ${chatId} failed:`, err.message);
    }
  }
}

/* ────────────────────────── STARTUP ─────────────────────────── */

let questionTimer = null;
let milestoneTimer = null;

export function startCommunityProactive(bot) {
  if (PROACTIVE_DISABLED) {
    console.log("[proactive] DISABLED via PIP_PROACTIVE_DISABLED");
    return;
  }
  console.log(
    `[proactive] starting — question pickup every ${Math.round(QUESTION_PICKUP_INTERVAL_MS/60000)}min ` +
    `(max ${DAILY_PROACTIVE_MAX}/chat/day), milestones every ${Math.round(MILESTONE_INTERVAL_MS/60000)}min`,
  );
  // Question sweeper
  questionTimer = setInterval(() => {
    sweepProactiveQuestions(bot.api).catch((err) =>
      console.error("[proactive] question sweep failed:", err.message),
    );
  }, QUESTION_PICKUP_INTERVAL_MS);
  // Milestone sweeper
  milestoneTimer = setInterval(() => {
    sweepMilestones(bot.api).catch((err) =>
      console.error("[proactive] milestone sweep failed:", err.message),
    );
  }, MILESTONE_INTERVAL_MS);
}

export function stopCommunityProactive() {
  if (questionTimer) clearInterval(questionTimer);
  if (milestoneTimer) clearInterval(milestoneTimer);
  questionTimer = null;
  milestoneTimer = null;
}
