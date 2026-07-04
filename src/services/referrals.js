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

/* ─────────────────────── VANITY / CUSTOM CODES ─────────────────────── */

// Change cooldown so people can't grab + churn codes to squat.
const CODE_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Substrings that would let someone impersonate the protocol / staff in a
// referral link (ref=magpieofficial, ref=admin_support, …). Checked as a
// substring on the upper-cased code, so any code containing them is rejected.
const RESERVED_SUBSTRINGS = [
  "MAGPIE", "ADMIN", "OFFICIAL", "SUPPORT", "MODERATOR", "STAFF",
  "MAGPIELOANS", "MAGPIECAPITAL", "SOLANA", "SCAM", "AIRDROP", "GIVEAWAY",
];
// A minimal profanity/abuse blocklist (substring match on the upper-cased code).
const BANNED_SUBSTRINGS = ["FUCK", "SHIT", "CUNT", "NIGGER", "FAGGOT", "RAPE"];

/**
 * Validate a desired vanity code. Returns { ok, code } (normalized, upper)
 * or { ok:false, reason }. Charset is Telegram-deep-link safe (A-Z0-9_-)
 * so the t.me/…?start= link never breaks; stored upper-cased to match the
 * existing case-insensitive resolver.
 */
export function validateCustomCode(desired) {
  const code = String(desired || "").trim().toUpperCase();
  if (code.length < 3 || code.length > 20) {
    return { ok: false, reason: "Code must be 3–20 characters." };
  }
  if (!/^[A-Z0-9_-]+$/.test(code)) {
    return { ok: false, reason: "Use only letters, numbers, underscore (_) or hyphen (-)." };
  }
  if (/^[_-]|[_-]$/.test(code)) {
    return { ok: false, reason: "Code can't start or end with _ or -." };
  }
  if (RESERVED_SUBSTRINGS.some((s) => code.includes(s))) {
    return { ok: false, reason: "That code is reserved (looks like an official/impersonation name). Pick another." };
  }
  if (BANNED_SUBSTRINGS.some((s) => code.includes(s))) {
    return { ok: false, reason: "That code isn't allowed. Pick another." };
  }
  return { ok: true, code };
}

/**
 * Set a user's vanity referral code. Enforces validation, uniqueness, and a
 * 7-day change cooldown. Returns { ok:true, code } or { ok:false, reason }.
 * Never touches loans/collateral/rewards — only the user's own code string.
 */
export async function setCustomCode(userId, desired) {
  const v = validateCustomCode(desired);
  if (!v.ok) return v;

  // Ensure the user has a code row + read its change history.
  await getOrCreateCode(userId);
  const { rows } = await query(
    `SELECT code, code_updated_at FROM referral_codes WHERE user_id = $1`,
    [userId],
  );
  const current = rows[0];
  if (current && current.code === v.code) {
    return { ok: false, reason: "That's already your code." };
  }
  if (current?.code_updated_at) {
    const elapsed = Date.now() - new Date(current.code_updated_at).getTime();
    if (elapsed < CODE_CHANGE_COOLDOWN_MS) {
      const days = Math.ceil((CODE_CHANGE_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
      return { ok: false, reason: `You can change your code again in ${days} day${days === 1 ? "" : "s"}.` };
    }
  }

  try {
    await query(
      `UPDATE referral_codes
          SET code = $2, is_custom = TRUE, code_updated_at = NOW()
        WHERE user_id = $1`,
      [userId, v.code],
    );
  } catch (err) {
    if (err.code === "23505") return { ok: false, reason: "That code is already taken — try another." };
    throw err;
  }
  return { ok: true, code: v.code };
}
