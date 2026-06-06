/**
 * Pip cost-protection gate.
 *
 * Two protections sit around the expensive chatWithAgent call for
 * site-initiated AI chats (/api/v1/ai/chat):
 *
 *   1. Per-user daily message cap. Resets every 24h from first
 *      message in the window. Prevents one user from draining the
 *      Anthropic budget.
 *
 *   2. Off-topic streak detection. Each incoming message is
 *      classified by a cheap Haiku call: is it about Magpie / the
 *      user's account / the protocol, or is it small talk / random?
 *      Three off-topic in a row → polite redirect + cooldown.
 *      Cooldown auto-clears when the user comes back with a
 *      Magpie-related question.
 *
 * The fast gates (cooldown + daily cap) run BEFORE chatWithAgent so
 * we can short-circuit. The classifier runs IN PARALLEL with the
 * agent (see applyTopicGate) — Haiku ~400ms beats Sonnet ~2-6s, so
 * the user pays Sonnet latency only, not the sum. If the classifier
 * comes back "off" with streak reaching the limit, we discard the
 * Sonnet response and serve the cooldown copy instead. Small waste
 * on the rare cooldown case for much faster typical responses.
 *
 * "A few jokes is fine" — the gate only fires after THREE consecutive
 * off-topic messages. Mixed conversation (one off-topic, then a
 * magpie question, then another tangent) doesn't trigger it.
 */
import { query } from "../db/pool.js";

const DAILY_CAP = Number(process.env.PIP_DAILY_CAP || 50);
const OFFTOPIC_LIMIT = 3;
const COOLDOWN_MINUTES = 30;

const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

const CLASSIFIER_PROMPT = `You decide if a message belongs in a chat with Pip, the Magpie Capital AI agent.

ON-TOPIC = anything about:
  • Magpie protocol, lending, borrowing, repaying, liquidations
  • The user's loans, credit score, wallet, balance, earnings
  • $MAGPIE token, holders, referrals, LPs, /earn
  • Site or bot features ("how do I do X")
  • Account / security / locks / privacy / data
  • Crypto / Solana / DeFi mechanics that the user is trying to apply
  • Greetings, thanks, follow-up questions, very brief small talk
    ("hey", "thanks", "ok", "cool") — these are FINE
  • Reasonable problem-solving banter

OFF-TOPIC = clearly nothing to do with Magpie or the user's account:
  • Sports scores, movie reviews, recipes, dating advice
  • Random tangents that have continued for several messages
  • Trying to use Pip as a general-purpose chatbot
  • Trying to get Pip to write code/essays/etc unrelated to Magpie

Output STRICTLY one word: "on" or "off". No punctuation, no explanation.`;

async function classify(message) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // No key configured → don't block legitimate users; treat all as
    // on-topic. Matches ai-support.js's graceful-degrade behavior.
    return "on";
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 4,
        temperature: 0,
        system: CLASSIFIER_PROMPT,
        messages: [{ role: "user", content: message.slice(0, 1500) }],
      }),
    });
    if (!res.ok) {
      console.warn("[ai-gate] classifier HTTP", res.status, "→ defaulting on-topic");
      return "on";
    }
    const body = await res.json();
    const block = Array.isArray(body?.content) ? body.content[0] : null;
    const text = block?.type === "text" ? String(block.text || "").trim().toLowerCase() : "on";
    return text.startsWith("off") ? "off" : "on";
  } catch (err) {
    // If the classifier itself fails, default to "on" — don't block
    // legitimate users because Anthropic had a hiccup.
    console.warn("[ai-gate] classifier error, defaulting on-topic:", err.message);
    return "on";
  }
}

async function getOrCreateUsage(userId) {
  const { rows } = await query(
    `INSERT INTO ai_chat_usage(user_id) VALUES($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING messages_24h, window_start, offtopic_streak, cooldown_until`,
    [userId],
  );
  if (rows[0]) return rows[0];
  const { rows: [row] } = await query(
    `SELECT messages_24h, window_start, offtopic_streak, cooldown_until
       FROM ai_chat_usage WHERE user_id = $1`,
    [userId],
  );
  return row;
}

/**
 * Fast pre-flight: cooldown + daily cap. Synchronous-fast (one DB read,
 * maybe one write to roll the 24h window). NO Anthropic call. Always
 * run BEFORE kicking off the main chat — these conditions short-circuit
 * the expensive call.
 *
 * Returns:
 *   { ok: true } — proceed to chat + topic gate
 *   { ok: false, response, reason } — short-circuit with canned copy
 */
export async function preflightFast({ userId }) {
  const usage = await getOrCreateUsage(userId);

  // 1. Cooldown check (set by previous off-topic streak)
  if (usage.cooldown_until && new Date(usage.cooldown_until) > new Date()) {
    const minsLeft = Math.ceil(
      (new Date(usage.cooldown_until).getTime() - Date.now()) / 60_000,
    );
    return {
      ok: false,
      reason: "cooldown",
      response: `Stepped away for a sec — back in ~${minsLeft}m. If it's urgent, /support in the Telegram bot reaches the team directly.`,
    };
  }

  // 2. Daily cap (rolling 24h)
  const windowExpired = !usage.window_start || (Date.now() - new Date(usage.window_start).getTime()) > 24 * 3600 * 1000;
  if (windowExpired) {
    await query(
      `UPDATE ai_chat_usage
          SET messages_24h = 0, window_start = NOW(), updated_at = NOW()
        WHERE user_id = $1`,
      [userId],
    );
    usage.messages_24h = 0;
  }
  if (usage.messages_24h >= DAILY_CAP) {
    return {
      ok: false,
      reason: "daily_cap",
      response: `You've hit today's chat limit with me (${DAILY_CAP} messages). Back in ~24h — /support in the Telegram bot still works in the meantime.`,
    };
  }

  return { ok: true };
}

/**
 * Slow gate: run the Haiku classifier and update the off-topic streak.
 * Safe to invoke IN PARALLEL with chatWithAgent — the caller awaits
 * both, then decides whether to serve the agent's response or the
 * cooldown copy.
 *
 * Returns:
 *   { ok: true } — agent response is fine to serve
 *   { ok: false, response, reason } — serve this copy instead and
 *     discard the agent's reply (rare path)
 */
export async function applyTopicGate({ userId, message }) {
  // Re-read usage so we have the latest streak (in case another
  // concurrent message updated it). Cheap — single primary-key lookup.
  const { rows: [usage] } = await query(
    `SELECT offtopic_streak FROM ai_chat_usage WHERE user_id = $1`,
    [userId],
  );
  const currentStreak = usage?.offtopic_streak ?? 0;

  const topic = await classify(message);

  if (topic === "off") {
    const nextStreak = currentStreak + 1;
    if (nextStreak >= OFFTOPIC_LIMIT) {
      await query(
        `UPDATE ai_chat_usage
            SET offtopic_streak = 0,
                cooldown_until = NOW() + ($2 || ' minutes')::interval,
                messages_24h = messages_24h + 1,
                updated_at = NOW()
          WHERE user_id = $1`,
        [userId, String(COOLDOWN_MINUTES)],
      );
      return {
        ok: false,
        reason: "offtopic_cooldown",
        response: `Gotta hop for a bit — catch you in ${COOLDOWN_MINUTES} min? If something Magpie-related comes up urgent before then, /support in the Telegram bot pings the team.`,
      };
    }
    await query(
      `UPDATE ai_chat_usage
          SET offtopic_streak = $2,
              messages_24h = messages_24h + 1,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, nextStreak],
    );
    // Off-topic but under the limit — let the agent's response stand.
    return { ok: true };
  }

  // On-topic — reset streak, increment count.
  await query(
    `UPDATE ai_chat_usage
        SET offtopic_streak = 0,
            messages_24h = messages_24h + 1,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
  return { ok: true };
}

/**
 * Legacy composite: fast + slow gates in series. Retained for any
 * caller that doesn't want to parallelize. New code should use
 * preflightFast + applyTopicGate in parallel.
 */
export async function preflightAiChat({ userId, message }) {
  const fast = await preflightFast({ userId });
  if (!fast.ok) return fast;
  return applyTopicGate({ userId, message });
}
