/**
 * Referral codes & attribution.
 *
 * Each user has a unique short code. When a new user runs `/start <code>`
 * before their first real activity, we write `referred_by`. The code is
 * case-insensitive on lookup but stored upper-cased.
 */
import crypto from "node:crypto";
import { query } from "../db/pool.js";

function generateCode() {
  // 6-char unambiguous alphabet (no 0/O/1/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * Get (or create) this user's referral code.
 */
export async function getOrCreateCode(userId) {
  const { rows } = await query(
    `SELECT code FROM referral_codes WHERE user_id = $1`,
    [userId],
  );
  if (rows[0]) return rows[0].code;

  // Retry on the (very unlikely) collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await query(
        `INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)`,
        [userId, code],
      );
      return code;
    } catch (err) {
      if (err.code !== "23505") throw err; // not a unique-violation
    }
  }
  throw new Error("Could not allocate referral code");
}

/**
 * Attribute `newUserId` to the owner of `code`, but only if the new user
 * hasn't been attributed yet and isn't the owner.
 * Returns the referrer's row ({ id, telegram_id }) on success, else null.
 */
export async function attribute(newUserId, code) {
  if (!code) return null;
  const { rows: codeRows } = await query(
    `SELECT user_id FROM referral_codes WHERE code = $1`,
    [code.toUpperCase()],
  );
  const referrerId = codeRows[0]?.user_id;
  if (!referrerId || referrerId === newUserId) return null;

  const { rowCount } = await query(
    `UPDATE users
       SET referred_by = $2, referred_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND referred_by IS NULL`,
    [newUserId, referrerId],
  );
  if (rowCount === 0) return null;

  const { rows: refRows } = await query(
    `SELECT id, telegram_id FROM users WHERE id = $1`,
    [referrerId],
  );
  return refRows[0] ?? null;
}

export async function referralStats(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total FROM users WHERE referred_by = $1`,
    [userId],
  );
  return { total: rows[0].total };
}
