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
// Operator directives:
//   2026-06-07a: "Pip should be more active in the TG"
//   2026-06-07b: "Pip didn't respond. We need users to know we are
//                 acknowledging their questions."
// Cumulative tuning: faster sweep cadence (1min), shorter wait before
// Pip jumps in (45s), higher daily cap (20), shorter per-chat gap
// (5min). Cost at the new ceiling: ~20 × $0.005 = $0.10/day/chat worst-case.
const DAILY_PROACTIVE_MAX = Math.max(0, Number(process.env.PIP_DAILY_PROACTIVE_MAX) || 20);
const QUESTION_PICKUP_INTERVAL_MS = 60 * 1000;       // sweep every minute
const MILESTONE_INTERVAL_MS = 30 * 60 * 1000;
const QUESTION_MIN_AGE_MS = 45 * 1000;               // 45s — fast enough to feel responsive
const QUESTION_MAX_AGE_MS = 60 * 60 * 1000;          // ignore older than 1h
const PICKUP_GAP_MS = 5 * 60 * 1000;                 // 5min between Pip pickups in a chat
const MILESTONE_GAP_MS = 3 * 60 * 60 * 1000;

// Command-cheatsheet reminder cadence.
//   - Checked every 15min (cheap)
//   - Posts only if BOTH:
//     • >= COMMAND_HINT_GAP_MS since the last hint in this chat, AND
//     • >= COMMAND_HINT_MIN_MESSAGES new messages since the last hint
//   - Both conditions ensure: dead chats don't see hints, very active
//     chats see more (but not spammy). Defaults: 2h and 20 messages.
// Operator can tighten to "every 30min" via env if desired, but the
// default protects UX from feeling like a billboard.
const COMMAND_HINT_INTERVAL_MS = 15 * 60 * 1000;
const COMMAND_HINT_GAP_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.PIP_COMMAND_HINT_GAP_MIN) * 60 * 1000 || 120 * 60 * 1000,
);
const COMMAND_HINT_MIN_MESSAGES = Math.max(
  0,
  Number(process.env.PIP_COMMAND_HINT_MIN_MESSAGES) || 20,
);

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

// Escape Telegram legacy-Markdown control chars so usernames with
// underscores (very common in TG handles, e.g. @magpie_capital_bot)
// don't accidentally trigger italic / bold rendering and break the
// whole message. Belt-and-suspenders: we ALSO defang any backticks
// and brackets that could be smuggled in via a hostile first_name.
function escapeMdName(s) {
  return String(s).replace(/([_*`\[\]()])/g, "\\$1");
}

function displayName(tgUser) {
  if (!tgUser) return "friend";
  if (tgUser.username) return `@${escapeMdName(tgUser.username)}`;
  const first = (tgUser.first_name || "").trim();
  return first ? escapeMdName(first) : "friend";
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
  "keeper", "vault", "auto-protect", "autoprotect", "wallet",
  "stake", "swap", "claim", "audit", "rugged", "scam",
  "reward", "airdrop", "distribution", "snapshot",
  // tokenomics — burns, supply, treasury
  "burn", "burned", "burning", "supply", "treasury",
  // wallets users commonly mention (questions about Phantom support
  // are extremely common — "if i hold in Phantom will i get rewards")
  "phantom", "solflare", "backpack", "ledger", "trezor", "hardware",
  // common how-to verbs
  "how do i", "how does", "how can", "what happens", "what's the",
  "what is", "can i ", "is it safe", "is it possible", "is there",
  "do i need", "what tier", "how long", "when does", "when will",
  "why does", "anyone know", "anyone using",
  "will i", "will i get", "do i get", "where do i",
];

// Short keywords (lp, fee, ltv) match inside common words ("help" →
// "lp", "coffee" → "fee", etc.), causing false positives. Pre-build
// a single boundary-aware regex from the keyword list — anything ≤4
// chars gets \b boundaries, longer phrases match anywhere.
const QUESTION_KEYWORD_RE = (() => {
  const parts = QUESTION_KEYWORDS.map((k) => {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return k.length <= 4 ? `\\b${esc}\\b` : esc;
  });
  return new RegExp(parts.join("|"), "i");
})();

function isCandidateQuestion(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 300) return false;
  // Accept "?" OR question-shaped openers without explicit punctuation
  // ("anyone here borrowed", "wondering if...", etc.) — community users
  // often skip the question mark on TG.
  const endsWithQ = trimmed.endsWith("?");
  const startsWithQVerb = /^(anyone|can\s+(?:i|we|you)|how\s+(?:do|does|can)|what(?:'s|\s+is)|why\s+(?:does|is)|when\s+(?:will|does)|where\s+(?:do|is)|wondering|curious|is\s+it)/i.test(trimmed);
  if (!endsWithQ && !startsWithQVerb) return false;
  if (trimmed.startsWith("/")) return false;
  return QUESTION_KEYWORD_RE.test(trimmed);
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
// Each entry: { thr, key, matches(state), message(state) }.
//
// Two families now:
//   - Active-loan count (the "right now" gauge — community feels
//     momentum here)
//   - Lifetime SOL borrowed (the headline number — bigger story arc)
// Both deduped via community_milestones_seen so a milestone fires
// exactly once across the protocol's history.
const ACTIVE_LOAN_MILESTONES = [
  { thr: 50,   key: "active_loans_50" },
  { thr: 100,  key: "active_loans_100" },
  { thr: 250,  key: "active_loans_250" },
  { thr: 500,  key: "active_loans_500" },
  { thr: 1000, key: "active_loans_1000" },
].map((m) => ({
  ...m,
  matches: (state) => state.active >= m.thr,
  message: (state) =>
    `🎉 *Milestone* — Magpie just crossed *${m.thr} active loans*. ` +
    `Total repaid lifetime: ${state.repaid}. Thanks for being part of it.`,
}));

const LIFETIME_SOL_MILESTONES = [
  { thr: 100,   key: "lifetime_sol_100" },
  { thr: 250,   key: "lifetime_sol_250" },
  { thr: 500,   key: "lifetime_sol_500" },
  { thr: 1000,  key: "lifetime_sol_1000" },
  { thr: 2500,  key: "lifetime_sol_2500" },
  { thr: 5000,  key: "lifetime_sol_5000" },
  { thr: 10000, key: "lifetime_sol_10000" },
].map((m) => ({
  ...m,
  matches: (state) => state.lifetime_sol >= m.thr,
  message: (state) =>
    `🦅 *Milestone* — Magpie just crossed *${m.thr.toLocaleString()} SOL* in total lifetime borrowed. ` +
    `Currently out on loan: ${state.active_sol.toFixed(2)} SOL across ${state.active} active.`,
}));

// Highest-threshold first so the picker grabs the biggest unannounced
// one (otherwise we'd post "100 SOL!" after already being at 5000).
const MILESTONES = [...ACTIVE_LOAN_MILESTONES, ...LIFETIME_SOL_MILESTONES]
  .sort((a, b) => b.thr - a.thr);

async function fetchProtocolState() {
  const { rows: [r] } = await query(
    `SELECT
       (SELECT COUNT(*) FROM loans WHERE status='active')::int     AS active,
       (SELECT COUNT(*) FROM loans WHERE status='repaid')::int     AS repaid,
       (SELECT COUNT(*) FROM loans WHERE status='liquidated')::int AS liquidated,
       (SELECT COUNT(*) FROM loans)::int                           AS total,
       (SELECT COUNT(*) FROM supported_mints WHERE enabled=TRUE)::int AS tokens,
       COALESCE((SELECT SUM(loan_amount_lamports::numeric) FROM loans), 0)::text AS lifetime_lamports,
       COALESCE((SELECT SUM(loan_amount_lamports::numeric) FROM loans WHERE status='active'), 0)::text AS active_lamports`,
  );
  return {
    active: r.active,
    repaid: r.repaid,
    liquidated: r.liquidated,
    total: r.total,
    tokens: r.tokens,
    lifetime_sol: Number(r.lifetime_lamports) / 1e9,
    active_sol: Number(r.active_lamports) / 1e9,
  };
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

      // MILESTONES is already sorted highest-threshold first; pick the
      // first one that's been crossed AND hasn't been announced yet.
      // Post at most one per sweep so we don't dump "100 SOL! 250 SOL!
      // 500 SOL!" all in a row on a hot day.
      let toPost = null;
      for (const m of MILESTONES) {
        if (!m.matches(state)) continue;
        if (await unseen(chatId, m.key)) {
          toPost = m;
          break;
        }
      }
      if (!toPost) continue;

      const text = toPost.message(state);
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

/* ────────────────── SCAM-BAN EDUCATIONAL MOMENT ────────────────── */

// When the bot bans an impersonator, Pip turns the action into a
// teachable post in the group. Templated (no LLM cost), throttled so
// a scam-wave doesn't trigger 10 of these in a row.
const SCAM_BAN_TEMPLATES = [
  `🛡 Just removed a Magpie impersonator from the group. *Reminder:* no one from Magpie will ever DM you first. The only official accounts are *@magpie\\_capital\\_bot* (wallet) and *@magpietalk* (this group). Anything else with "Magpie" in the name is a scam.`,
  `🛡 Banned an account pretending to be Magpie. *Heads up:* Magpie doesn't DM users, doesn't run airdrops, doesn't ask anyone to "verify" their wallet. Full canonical handle list: magpie.capital/links.`,
  `🛡 Removed a scammer impersonating the Magpie team. If anyone reaches out claiming to be Magpie staff offering "help" or "refunds" — block, report, and double-check at magpie.capital/links. We will *never* DM you first.`,
  `🛡 One less scammer in the chat. *Pattern to know:* impersonators use Magpie-flavored names and ask users to DM them or click recovery links. If you see it, just \`/scam\` for the full pattern list — or flag it and a mod will handle it.`,
];

// Per-chat throttle so a scam wave doesn't spam the group with 10
// nearly-identical "banned a scammer" posts in a row. 20 min between
// educational posts; the bans themselves still all execute.
const SCAM_BAN_POST_GAP_MS = 20 * 60 * 1000;
const lastScamBanPostAt = new Map(); // chatId → timestamp

export async function maybePostScamBanEducation(botApi, chatId) {
  if (PROACTIVE_DISABLED) return;
  const last = lastScamBanPostAt.get(Number(chatId)) || 0;
  if (Date.now() - last < SCAM_BAN_POST_GAP_MS) return; // throttled
  const text = SCAM_BAN_TEMPLATES[Math.floor(Math.random() * SCAM_BAN_TEMPLATES.length)];
  try {
    await botApi.sendMessage(Number(chatId), text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    lastScamBanPostAt.set(Number(chatId), Date.now());
  } catch (err) {
    console.warn(`[proactive] scam-ban education post to ${chatId} failed:`, err.message);
  }
}

/* ────────────────── COMMAND-CHEATSHEET HINTS ────────────────── */

// Rotating one-liners so the reminder never feels like the same canned
// post. Each highlights ONE command + ONE benefit so it reads like a
// helpful nudge, not an ad.
const COMMAND_HINTS = [
  `💡 *Tip* — run \`/stats\` for live protocol numbers (no LLM call, instant).`,
  `💡 *Tip* — \`/tiers\` shows the three loan tiers and which one fits your trade-off.`,
  `💡 *Tip* — curious where loan fees go? \`/fees\` shows the full split.`,
  `💡 *Tip* — new here? \`/how\` walks through how Magpie works in 5 steps.`,
  `💡 *Tip* — \`/tokens\` lists every approved collateral token, by category.`,
  `💡 *Tip* — got a question? Try \`/ask <your question>\` and Pip will answer in chat.`,
  `💡 *Reminder* — Magpie has *only* two TG accounts: this group (@magpietalk) and the wallet bot (@magpie\\_capital\\_bot). Anyone else is a scammer.`,
];

// Per-chat hint state: last-posted timestamp + message count since then.
// Stored in memory; surviving a restart isn't important here (worst case
// the chat gets one extra hint after a redeploy, not the end of the world).
const hintState = new Map(); // chatId → { lastAt:Date, msgsSince:number, idx:number }
function getHintState(chatId) {
  let st = hintState.get(chatId);
  if (!st) {
    st = { lastAt: 0, msgsSince: 0, idx: Math.floor(Math.random() * COMMAND_HINTS.length) };
    hintState.set(chatId, st);
  }
  return st;
}

/** Called by the message handler on every inbound non-bot message in a
 *  moderated chat. Just increments the counter — the sweep decides when
 *  the hint is due. */
export function noteCommunityActivity(chatId) {
  if (PROACTIVE_DISABLED) return;
  const st = getHintState(Number(chatId));
  st.msgsSince += 1;
}

async function sweepCommandHints(botApi) {
  if (PROACTIVE_DISABLED) return;
  let chats;
  try {
    chats = await listEnabledChats();
  } catch {
    return;
  }
  for (const c of chats) {
    const chatId = Number(c.chat_id);
    const st = getHintState(chatId);
    const now = Date.now();
    const enoughGap = now - st.lastAt >= COMMAND_HINT_GAP_MS;
    const enoughActivity = st.msgsSince >= COMMAND_HINT_MIN_MESSAGES;
    if (!enoughGap || !enoughActivity) continue;

    const text = COMMAND_HINTS[st.idx % COMMAND_HINTS.length];
    try {
      await botApi.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      st.lastAt = now;
      st.msgsSince = 0;
      st.idx = (st.idx + 1) % COMMAND_HINTS.length;
      console.log(`[proactive] posted command hint to ${chatId}`);
    } catch (err) {
      console.warn(`[proactive] command hint to ${chatId} failed:`, err.message);
    }
  }
}

/* ────────────────── VIBE POSTER ────────────────── */

// Operator directive 2026-06-07: "Pip should be posting AT LEAST
// every 5-10 minutes. Keeping the vibes going."
//
// We post rotating templated content on a fast cadence — fully
// zero-cost (no LLM) — and back off ANY of:
//   • Humans are actively talking (last human msg <2min ago)
//   • Pip already posted something else in the last 3min
//   • A pickup / milestone / hint just fired (handled via lastVibeAt
//     updated by ANY proactive post, see noteProactivePost)
//
// 8 content rotators so 8 consecutive posts are all different. Each
// pulls live data where applicable so the chat sees changing numbers
// not static slogans.
const VIBE_BASE_GAP_MS = Math.max(
  3 * 60 * 1000,
  Number(process.env.PIP_VIBE_GAP_MIN) * 60 * 1000 || 7 * 60 * 1000, // default ~7min
);
const VIBE_JITTER_MS = 3 * 60 * 1000;          // ±3min so posts don't feel robotic
const VIBE_HUMAN_QUIET_MS = 2 * 60 * 1000;     // skip if humans posted <2min ago
const VIBE_PIP_GAP_MS = 3 * 60 * 1000;         // never within 3min of another Pip post
const vibeChatState = new Map();               // chatId → { lastVibeAt, lastHumanAt, idx }
const lastAnyPipPostAt = new Map();            // chatId → ms timestamp

function vibeChat(chatId) {
  let s = vibeChatState.get(Number(chatId));
  if (!s) {
    s = { lastVibeAt: 0, idx: Math.floor(Math.random() * 1000) };
    vibeChatState.set(Number(chatId), s);
  }
  return s;
}

/** Called from message handler on every inbound non-bot message —
 *  tracks "humans are active" so vibe poster knows to stay quiet. */
export function noteHumanActivity(chatId) {
  const s = vibeChat(chatId);
  s.lastHumanAt = Date.now();
}

/** Called whenever ANY proactive Pip post lands (vibe, question pickup,
 *  milestone, hint, scam-ban education) — prevents Pip stacking posts
 *  back-to-back across different rotators. */
function noteProactivePost(chatId) {
  lastAnyPipPostAt.set(Number(chatId), Date.now());
}

// Templated content rotators. Each is a function (state) → string.
// state = { active, repaid, lifetime_sol, active_sol, tokens } from
// fetchProtocolState(). Functions can return null to skip themselves
// (e.g. liquidations rotator skips if liquidations > 0).
const VIBE_ROTATORS = [
  // 1. Lifetime borrowed (the operator's favorite number)
  (s) => `🦅 *${s.lifetime_sol.toFixed(2)} SOL* lent out, lifetime. Verify on-chain at magpie.capital/stats.`,
  // 2. Currently active
  (s) => s.active > 0
    ? `🟢 *${s.active}* active loans right now · *${s.active_sol.toFixed(2)} SOL* out across the book.`
    : null,
  // 3. Liquidation rate — always pulled live from DB so it stays
  //     truthful as the rate evolves. Reads s.liquidated and s.total
  //     (both populated in fetchProtocolState).
  (s) => {
    const rate = s.total > 0 ? (s.liquidated / s.total) * 100 : 0;
    const rateStr = rate < 0.01 ? "<0.01%" : `${rate.toFixed(2)}%`;
    return `🛡 *${rateStr}* lifetime liquidation rate (${s.liquidated} of ${s.total} loans). Short terms + low LTV + active token-health watcher.`;
  },
  // 4. Token coverage
  (s) => `🪙 *${s.tokens}* approved collateral tokens. Run \`/tokens\` to see the full list.`,
  // 5. Command nudge — /ca rotation
  () => `💡 \`/ca\` drops the \$MAGPIE contract address (Token-2022, 6 decimals). Copy-safe.`,
  // 6. Command nudge — /how rotation
  () => `📚 New to Magpie? \`/how\` walks through the borrow → repay flow in 5 steps.`,
  // 7. Holder rewards reminder
  () => `💎 \$MAGPIE holders earn *10%* of all protocol loan fees, distributed in SOL on a randomized 5-10 day cadence. \`/holders\` for the full mechanic.`,
  // 8. Safety reminder (rotates with the four-handle trust line)
  () => `🛡 Quick reminder: Magpie has *exactly four* official accounts. Anyone else claiming to be us is a scammer. Verify at magpie.capital/links.`,
  // 9. Two-surface reminder
  () => `📲 Two Magpies: *@magpie\\_capital\\_bot* (your private wallet) and *@magpietalk* (this community). No DM support. No airdrops. No surprises.`,
  // 10. Lifetime repaid milestone
  (s) => `✅ *${s.repaid}* loans repaid lifetime. Zero LP losses. Every flow on-chain.`,
];

const VIBE_INTERVAL_MS = 60_000; // check every minute; gate logic decides if we actually post

async function sweepVibePosts(botApi) {
  if (PROACTIVE_DISABLED) return;
  let chats;
  try {
    chats = await listEnabledChats();
  } catch {
    return;
  }
  if (chats.length === 0) return;

  let state = null;
  try {
    state = await fetchProtocolState();
  } catch (err) {
    console.warn("[proactive] vibe state fetch failed:", err.message);
    return;
  }

  for (const c of chats) {
    const chatId = Number(c.chat_id);
    const s = vibeChat(chatId);
    const now = Date.now();
    // Jittered gap so posts don't all happen at minute-multiples
    const jitter = (Math.random() * 2 - 1) * VIBE_JITTER_MS;
    if (now - s.lastVibeAt < (VIBE_BASE_GAP_MS + jitter)) continue;
    // Don't talk over humans
    if (s.lastHumanAt && now - s.lastHumanAt < VIBE_HUMAN_QUIET_MS) continue;
    // Don't stack on another Pip post
    const lastAny = lastAnyPipPostAt.get(chatId) || 0;
    if (now - lastAny < VIBE_PIP_GAP_MS) continue;

    // Pick the next rotator that returns non-null content
    let text = null;
    for (let tries = 0; tries < VIBE_ROTATORS.length; tries++) {
      const fn = VIBE_ROTATORS[(s.idx + tries) % VIBE_ROTATORS.length];
      const candidate = fn(state);
      if (candidate) {
        text = candidate;
        s.idx = (s.idx + tries + 1) % VIBE_ROTATORS.length;
        break;
      }
    }
    if (!text) continue;

    try {
      await botApi.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      s.lastVibeAt = now;
      noteProactivePost(chatId);
    } catch (err) {
      console.warn(`[proactive] vibe post to ${chatId} failed:`, err.message);
    }
  }
}

/* ────────────────────────── STARTUP ─────────────────────────── */

let questionTimer = null;
let milestoneTimer = null;
let hintTimer = null;
let vibeTimer = null;

export function startCommunityProactive(bot) {
  if (PROACTIVE_DISABLED) {
    console.log("[proactive] DISABLED via PIP_PROACTIVE_DISABLED");
    return;
  }
  console.log(
    `[proactive] starting — pickup ${Math.round(QUESTION_PICKUP_INTERVAL_MS/60000)}min (max ${DAILY_PROACTIVE_MAX}/chat/day), ` +
    `milestones ${Math.round(MILESTONE_INTERVAL_MS/60000)}min, ` +
    `cmd hints ${Math.round(COMMAND_HINT_GAP_MS/60000)}min + ${COMMAND_HINT_MIN_MESSAGES} msgs`,
  );
  questionTimer = setInterval(() => {
    sweepProactiveQuestions(bot.api).catch((err) =>
      console.error("[proactive] question sweep failed:", err.message),
    );
  }, QUESTION_PICKUP_INTERVAL_MS);
  milestoneTimer = setInterval(() => {
    sweepMilestones(bot.api).catch((err) =>
      console.error("[proactive] milestone sweep failed:", err.message),
    );
  }, MILESTONE_INTERVAL_MS);
  hintTimer = setInterval(() => {
    sweepCommandHints(bot.api).catch((err) =>
      console.error("[proactive] command hint sweep failed:", err.message),
    );
  }, COMMAND_HINT_INTERVAL_MS);
  // Vibe poster — checks every minute, posts only when gap + quiet-chat
  // + no-recent-Pip-post conditions all met. Default cadence ~7min,
  // configurable via PIP_VIBE_GAP_MIN env var (minimum 3).
  vibeTimer = setInterval(() => {
    sweepVibePosts(bot.api).catch((err) =>
      console.error("[proactive] vibe sweep failed:", err.message),
    );
  }, VIBE_INTERVAL_MS);
}

export function stopCommunityProactive() {
  if (questionTimer) clearInterval(questionTimer);
  if (milestoneTimer) clearInterval(milestoneTimer);
  if (hintTimer) clearInterval(hintTimer);
  if (vibeTimer) clearInterval(vibeTimer);
  questionTimer = null;
  milestoneTimer = null;
  hintTimer = null;
}
