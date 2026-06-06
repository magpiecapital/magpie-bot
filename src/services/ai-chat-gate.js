/**
 * Pip availability gate.
 *
 * Single protection now: a per-user daily message cap on site-initiated
 * AI chats (/api/v1/ai/chat). Resets every 24h from the first message
 * in the window. Prevents one user from draining the Anthropic budget.
 *
 * Previously there was also a topic-classifier + off-topic cooldown that
 * paused conversations for 30 min after 3 consecutive off-topic messages.
 * That was too aggressive — Pip should be available 24/7. The system
 * prompt now handles "steer back to Magpie" entirely on its own, no
 * classifier required.
 */
import { query } from "../db/pool.js";

const DAILY_CAP = Number(process.env.PIP_DAILY_CAP || 50);

async function getOrCreateUsage(userId) {
  const { rows } = await query(
    `INSERT INTO ai_chat_usage(user_id) VALUES($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING messages_24h, window_start`,
    [userId],
  );
  if (rows[0]) return rows[0];
  const { rows: [row] } = await query(
    `SELECT messages_24h, window_start
       FROM ai_chat_usage WHERE user_id = $1`,
    [userId],
  );
  return row;
}

/**
 * Fast pre-flight: daily cap only. Synchronous-fast (one DB read,
 * maybe one write to roll the 24h window). NO Anthropic call.
 * Always run BEFORE kicking off the main chat.
 */
export async function preflightFast({ userId }) {
  const usage = await getOrCreateUsage(userId);

  const windowExpired = !usage.window_start ||
    (Date.now() - new Date(usage.window_start).getTime()) > 24 * 3600 * 1000;
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
 * Per-message bookkeeping. Increment the daily-cap counter. Kept as a
 * separate function (and still callable in parallel with the agent)
 * so the caller's call-site doesn't have to change.
 */
export async function applyTopicGate({ userId }) {
  await query(
    `UPDATE ai_chat_usage
        SET messages_24h = messages_24h + 1,
            offtopic_streak = 0,
            cooldown_until = NULL,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
  return { ok: true };
}

/**
 * Legacy composite. Kept for any caller that didn't migrate to the
 * split form.
 */
export async function preflightAiChat({ userId }) {
  const fast = await preflightFast({ userId });
  if (!fast.ok) return fast;
  return applyTopicGate({ userId });
}
