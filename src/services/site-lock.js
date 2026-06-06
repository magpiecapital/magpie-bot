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

/**
 * Set/extend the site lock. setBy is a free-text label — "self" when
 * the user runs /lock themselves, the operator's @handle for
 * /adminlock, "callback" for inline-button locks. Logged into
 * site_lock_events for audit trail.
 */
export async function setSiteLock(userId, hours, opts = {}) {
  const clamped = Math.max(1, Math.min(MAX_LOCK_HOURS, Math.floor(hours)));
  const setBy = opts.setBy || "self";
  const reason = opts.reason || null;
  await query(
    `UPDATE users SET site_locked_until = NOW() + ($2 || ' hours')::interval WHERE id = $1`,
    [userId, String(clamped)],
  );
  await query(
    `INSERT INTO site_lock_events(user_id, action, hours, set_by, reason)
     VALUES($1, 'set', $2, $3, $4)`,
    [userId, clamped, setBy, reason],
  ).catch((err) => console.warn("[site-lock] event log failed:", err.message));
  return { hours: clamped };
}

export async function clearSiteLock(userId, opts = {}) {
  const setBy = opts.setBy || "self";
  await query(`UPDATE users SET site_locked_until = NULL WHERE id = $1`, [userId]);
  await query(
    `INSERT INTO site_lock_events(user_id, action, set_by) VALUES($1, 'clear', $2)`,
    [userId, setBy],
  ).catch((err) => console.warn("[site-lock] event log failed:", err.message));
}

/**
 * Recent lock history for a user. Used by /security to show audit
 * trail, and by the dashboard for the same purpose.
 */
export async function getLockHistory(userId, limit = 10) {
  const { rows } = await query(
    `SELECT id, action, hours, set_by, reason, created_at
       FROM site_lock_events
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
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
