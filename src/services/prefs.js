/**
 * Per-user notification & behavior preferences.
 *
 * Every user has exactly one row in user_prefs, created lazily on first
 * access. All defaults match the migration (everything on, auto-repay off).
 */
import { query } from "../db/pool.js";

const DEFAULTS = {
  notify_deposits: true,
  notify_loan_warnings: true,
  notify_liquidations: true,
  notify_health: true,
  auto_repay: false,
  auto_protect: false,
};

export async function getPrefs(userId) {
  const { rows } = await query(
    `SELECT notify_deposits, notify_loan_warnings, notify_liquidations,
            notify_health, auto_repay, auto_protect
     FROM user_prefs WHERE user_id = $1`,
    [userId],
  );
  if (rows[0]) return rows[0];
  // Lazy insert with defaults so subsequent reads return a row.
  await query(
    `INSERT INTO user_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId],
  );
  return { ...DEFAULTS };
}

const ALLOWED = new Map(
  Object.keys(DEFAULTS).map((k) => [k, k]),
);

export async function togglePref(userId, key) {
  const col = ALLOWED.get(key);
  if (!col) throw new Error(`unknown pref: ${key}`);
  await getPrefs(userId); // ensure row exists
  // col is guaranteed to be one of our hardcoded column names from DEFAULTS
  const { rows } = await query(
    `UPDATE user_prefs SET ${col} = NOT ${col}, updated_at = NOW()
     WHERE user_id = $1
     RETURNING ${col}`,
    [userId],
  );
  return rows[0][col];
}
