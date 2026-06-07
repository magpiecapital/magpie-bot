/**
 * Community moderation — strike policy.
 *
 * Single source of truth for how many infractions a user has within a
 * rolling window, and what action level that should trigger.
 *
 * Operator directive: "we aren't accidentally kicking out good members
 * from the get-go". This module is the answer — every moderation
 * subsystem (FUD classifier, image classifier, scam pattern, URL
 * filter, quarantine) goes through `applyStrike()` so penalties scale
 * gradually instead of slamming a stranger on their first misstep.
 *
 * Design:
 *   - Strikes are derived from community_mod_actions (no new table).
 *     The `action` column tells us which kind of infraction occurred;
 *     we filter to STRIKE_ACTIONS only.
 *   - Rolling window: STRIKE_WINDOW_DAYS (default 30). An infraction
 *     that's older than that effectively decays — good behavior is
 *     rewarded by old strikes falling off.
 *   - Trusted members (Magpie wallet holders) get a -1 level shift.
 *     A trusted user's strike 1 is treated like a stranger's strike 0,
 *     etc. They get a free "first misread" pass.
 *
 * Strike → action mapping (after the trusted shift):
 *   level 0 → "note"          → silent log, no DM
 *   level 1 → "warn"          → soft-warn DM, no restriction
 *   level 2 → "final_warn"    → soft-warn DM with "next strike mutes"
 *   level 3 → "short_mute"    → 1h mute + warn DM + operator flag
 *   level 4 → "long_mute"     → 24h mute + warn DM + operator flag
 *   level 5+ → "review"       → no auto-action, operator flag only
 *
 * We NEVER auto-ban. The highest level escalates to operator review.
 */
import { query } from "../db/pool.js";
import { findUserByTelegramId } from "./users.js";

const STRIKE_WINDOW_DAYS = Math.max(1, Number(process.env.COMMUNITY_STRIKE_WINDOW_DAYS) || 30);

// Action strings (from community_mod_actions.action) that count as
// strikes. Keep this list in sync with the action labels emitted by
// the moderation handlers — adding a new auto-mod action should also
// add it here if it should count toward strikes.
const STRIKE_ACTIONS = new Set([
  "delete_link",
  "delete_scam_pattern",
  "delete_handle_impersonation",
  "delete_quarantine_media",
  "delete_quarantine_rate",
  "fud_misinformation",
  "fud_harassment",
  "fud_coordinated_fud",
  "fud_ban_worthy",
  "image_scam_screenshot",
  "image_impersonation_screenshot",
  "image_fud_screenshot",
  "image_nsfw_or_violence",
]);

/**
 * Count strikes against a user in the current window. Cheap query —
 * already-indexed (chat_id, created_at DESC).
 */
export async function countStrikes(chatId, userId) {
  try {
    const { rows: [r] } = await query(
      `SELECT COUNT(*)::int AS n
         FROM community_mod_actions
        WHERE chat_id = $1
          AND user_id = $2
          AND action = ANY($3::text[])
          AND created_at > NOW() - ($4 || ' days')::interval`,
      [Number(chatId), Number(userId), [...STRIKE_ACTIONS], String(STRIKE_WINDOW_DAYS)],
    );
    return r?.n ?? 0;
  } catch (err) {
    console.warn("[strikes] countStrikes failed:", err.message);
    return 0;
  }
}

/**
 * Is this user a "trusted" member? Same gate as the FUD-classifier
 * leniency: any TG user that's a Magpie wallet holder is considered
 * trusted. Trusted users get a -1 strike shift.
 */
export async function isTrustedMember(telegramId) {
  if (!telegramId) return false;
  try {
    const user = await findUserByTelegramId(telegramId);
    return !!user;
  } catch {
    return false;
  }
}

/**
 * Map a strike level to the policy action.
 * Returns { level, action, mute_sec, warn, flag_operator, note }.
 */
function levelToAction(level) {
  if (level <= 0) {
    return { level, action: "note", mute_sec: 0, warn: false, flag_operator: false,
             note: "First brush — silent log, no penalty." };
  }
  if (level === 1) {
    return { level, action: "warn", mute_sec: 0, warn: true, flag_operator: false,
             note: "Warning #1 — friendly heads-up, no restriction." };
  }
  if (level === 2) {
    return { level, action: "final_warn", mute_sec: 0, warn: true, flag_operator: false,
             note: "Warning #2 — final warning before any mute." };
  }
  if (level === 3) {
    return { level, action: "short_mute", mute_sec: 3600, warn: true, flag_operator: true,
             note: "Strike 3 — 1h mute. Operator pinged." };
  }
  if (level === 4) {
    return { level, action: "long_mute", mute_sec: 86_400, warn: true, flag_operator: true,
             note: "Strike 4 — 24h mute. Operator pinged." };
  }
  // 5+ — never auto-ban. Operator decides.
  return { level, action: "review", mute_sec: 0, warn: false, flag_operator: true,
           note: `Strike ${level} — escalated to operator for review. No auto-action.` };
}

/**
 * Apply a strike for an infraction. Records the action in
 * community_mod_actions (so it counts toward future strike windows)
 * and returns the policy-driven action to apply NOW.
 *
 *   chatId    — group chat ID
 *   userId    — TG user ID of the offender
 *   reason    — short reason string (e.g. "url not on allowlist")
 *   meta      — { actionLabel } — the action label to record. MUST be
 *               in STRIKE_ACTIONS for the strike to count. If omitted,
 *               we still apply policy but don't double-record.
 *   trusted   — pass true if the user is a Magpie wallet holder
 *
 * Returns { level, action, mute_sec, warn, flag_operator, note,
 *           strike_in_window }
 */
export async function applyStrike(chatId, userId, reason, { actionLabel = null, trusted = false } = {}) {
  // Compute pre-existing strike count. If we ALSO log this incident as
  // a strike (actionLabel provided + on the list), that bumps the
  // effective count by 1.
  const existing = await countStrikes(chatId, userId);
  const willCount = actionLabel && STRIKE_ACTIONS.has(actionLabel);
  const effective = existing + (willCount ? 1 : 0);
  // Trusted shift: lower the effective level by 1 (but never below 0)
  const adjusted = Math.max(0, effective - (trusted ? 1 : 0));
  const decision = levelToAction(adjusted);
  return {
    ...decision,
    strike_in_window: effective,    // for display ("strike 2 of 5")
    raw_strikes: existing,           // pre-this-incident
    trusted_shift: trusted,
  };
}

/**
 * Render a user-facing string showing where they are in the policy.
 * Used in soft-warn DMs so users understand they're being treated
 * fairly, not arbitrarily kicked.
 */
export function strikeFooter(decision) {
  const STRIKE_MAX_LABEL = 4; // anything past 4 → operator review
  const shown = Math.min(decision.strike_in_window, STRIKE_MAX_LABEL);
  const trustNote = decision.trusted_shift
    ? " · _As a Magpie wallet holder, you get a one-strike grace before any mute kicks in._"
    : "";
  return `\n\n_Strike *${shown}/${STRIKE_MAX_LABEL}* in the last ${STRIKE_WINDOW_DAYS}-day window.${trustNote} Strikes decay over time — keep things chill and they fall off._`;
}

/**
 * Operator-facing: full strike record for a user across all chats they
 * participate in. Used by /strikes <user> command.
 */
export async function listRecentStrikes(userId, days = 90) {
  const { rows } = await query(
    `SELECT chat_id, action, reason, created_at
       FROM community_mod_actions
      WHERE user_id = $1
        AND action = ANY($2::text[])
        AND created_at > NOW() - ($3 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT 50`,
    [Number(userId), [...STRIKE_ACTIONS], String(days)],
  );
  return rows;
}

/**
 * Operator override: wipe a user's strike history in a chat. Used by
 * /clear_strikes — useful when an operator wants to give someone a
 * truly fresh start after manual review.
 */
export async function clearStrikes(chatId, userId) {
  try {
    const { rowCount } = await query(
      `DELETE FROM community_mod_actions
        WHERE chat_id = $1 AND user_id = $2 AND action = ANY($3::text[])`,
      [Number(chatId), Number(userId), [...STRIKE_ACTIONS]],
    );
    // Also reset the warned_count counter for cleanliness
    await query(
      `UPDATE community_members
          SET warned_count = 0
        WHERE chat_id = $1 AND user_id = $2`,
      [Number(chatId), Number(userId)],
    );
    return rowCount;
  } catch (err) {
    console.warn("[strikes] clearStrikes failed:", err.message);
    return 0;
  }
}
