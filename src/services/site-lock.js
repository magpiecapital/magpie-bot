/**
 * Site-lock kill-switch.
 *
 * A user who suspects their Phantom seed is compromised can set
 * `users.site_locked_until` to a future timestamp from TG (a different
 * auth surface — a stolen seed can't suppress a TG command). While
 * locked, every signed HTTP API endpoint rejects with 423 LOCKED.
 *
 * Helpers here are imported by each signed endpoint and called right
 * after the signer-is-linked check, before any destructive action.
 */
import { query } from "../db/pool.js";

const MAX_LOCK_HOURS = 720; // 30 days

/**
 * Returns { locked, until } for a user, by user_id.
 *
 * Returns `locked: false` for users without a row in users (shouldn't
 * happen for linked signers, but we treat missing as not-locked rather
 * than throwing so the endpoint can decide the response shape).
 */
export async function getSiteLock(userId) {
  if (!userId) return { locked: false, until: null };
  const { rows: [row] } = await query(
    `SELECT site_locked_until FROM users WHERE id = $1`,
    [userId],
  );
  if (!row?.site_locked_until) return { locked: false, until: null };
  const until = new Date(row.site_locked_until);
  if (until.getTime() <= Date.now()) {
    return { locked: false, until: null };
  }
  return { locked: true, until };
}

export async function setSiteLock(userId, hours) {
  const clamped = Math.max(1, Math.min(MAX_LOCK_HOURS, Math.floor(hours)));
  await query(
    `UPDATE users SET site_locked_until = NOW() + ($2 || ' hours')::interval WHERE id = $1`,
    [userId, String(clamped)],
  );
  return { hours: clamped };
}

export async function clearSiteLock(userId) {
  await query(`UPDATE users SET site_locked_until = NULL WHERE id = $1`, [userId]);
}

/**
 * Convenience for API handlers: return a 423 response shape if the
 * user is locked. Caller short-circuits the request.
 */
export async function rejectIfLocked(userId) {
  const { locked, until } = await getSiteLock(userId);
  if (!locked) return null;
  return {
    status: 423,
    body: {
      error: "Your account is locked",
      detail: `Site actions are paused until ${until.toISOString()}. Run /lock 0 in @magpie_capital_bot to remove the lock.`,
      locked_until: until.toISOString(),
    },
  };
}
