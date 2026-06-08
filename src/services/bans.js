/**
 * Per-user / per-wallet ban registry. Operator-controlled.
 *
 * Used by the borrow flow (commands/borrow.js + api/cosign-borrow.js)
 * to refuse loan opens from known-bad actors before any cosign or
 * on-chain ix is built. Read-only from the protocol's perspective —
 * never moves funds, only blocks new loan opens.
 *
 * Why both user-level AND wallet-level:
 *   - User bans catch the same person opening loans from any of their
 *     wallets under the same telegram_id.
 *   - Wallet bans catch the same wallet being reused under a NEW
 *     telegram_id (the operator-flagged attacker just creates a new
 *     account and re-imports the same sweep wallet — wallet ban
 *     defeats that).
 *
 * Fail-open by design — if the DB lookup fails, the check returns
 * `false` (not banned) so transient DB issues never block legit
 * users from borrowing. The ban list is a defense layer ON TOP of
 * the existing protocol gates, not a single point of failure.
 */
import { query } from "../db/pool.js";

/** Returns true if the user is in banned_users. Fail-open on errors. */
export async function isUserBanned(userId) {
  if (!userId) return false;
  try {
    const { rows } = await query(
      `SELECT 1 FROM banned_users WHERE user_id = $1 LIMIT 1`,
      [Number(userId)],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn("[bans] isUserBanned failed (fail-open):", err.message);
    return false;
  }
}

/** Returns true if the telegram_id is banned (regardless of user_id). */
export async function isTelegramIdBanned(telegramId) {
  if (!telegramId) return false;
  try {
    const { rows } = await query(
      `SELECT 1 FROM banned_users WHERE telegram_id = $1 LIMIT 1`,
      [Number(telegramId)],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn("[bans] isTelegramIdBanned failed (fail-open):", err.message);
    return false;
  }
}

/** Returns true if the wallet pubkey is in banned_wallets. */
export async function isWalletBanned(pubkey) {
  if (!pubkey) return false;
  try {
    const { rows } = await query(
      `SELECT 1 FROM banned_wallets WHERE wallet_pubkey = $1 LIMIT 1`,
      [String(pubkey)],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn("[bans] isWalletBanned failed (fail-open):", err.message);
    return false;
  }
}

/**
 * The full pre-borrow check: examines user_id, telegram_id, AND every
 * wallet pubkey associated with the user. Returns `null` if clean,
 * or `{ blocked: true, reason }` if blocked.
 */
export async function preBorrowBanCheck({ userId, telegramId, walletPubkey }) {
  try {
    if (await isUserBanned(userId)) {
      return { blocked: true, reason: "user_banned" };
    }
    if (telegramId && await isTelegramIdBanned(telegramId)) {
      return { blocked: true, reason: "telegram_id_banned" };
    }
    if (walletPubkey && await isWalletBanned(walletPubkey)) {
      return { blocked: true, reason: "wallet_banned" };
    }
    // Also check every wallet ever registered to this user — catches
    // the case where they switch to a different wallet to dodge the
    // wallet-level ban.
    if (userId) {
      const { rows } = await query(
        `SELECT bw.wallet_pubkey
           FROM wallets w
           JOIN banned_wallets bw ON bw.wallet_pubkey = w.public_key
          WHERE w.user_id = $1
          LIMIT 1`,
        [Number(userId)],
      );
      if (rows.length) {
        return { blocked: true, reason: "user_has_banned_wallet" };
      }
    }
    return null;
  } catch (err) {
    console.warn("[bans] preBorrowBanCheck failed (fail-open):", err.message);
    return null;
  }
}

/* ────────────────────── OPERATOR ACTIONS ────────────────────── */

export async function banUser({ userId, telegramId, reason, bannedBy, notes }) {
  await query(
    `INSERT INTO banned_users (user_id, telegram_id, reason, banned_by, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
        SET telegram_id = EXCLUDED.telegram_id,
            reason = EXCLUDED.reason,
            banned_by = EXCLUDED.banned_by,
            notes = EXCLUDED.notes,
            banned_at = NOW()`,
    [Number(userId), telegramId ? Number(telegramId) : null, reason ?? null, bannedBy ?? null, notes ?? null],
  );
}

export async function unbanUser(userId) {
  const { rowCount } = await query(
    `DELETE FROM banned_users WHERE user_id = $1`,
    [Number(userId)],
  );
  return rowCount;
}

export async function banWallet({ pubkey, reason, bannedBy, relatedUserId, notes }) {
  await query(
    `INSERT INTO banned_wallets (wallet_pubkey, reason, banned_by, related_user_id, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (wallet_pubkey) DO UPDATE
        SET reason = EXCLUDED.reason,
            banned_by = EXCLUDED.banned_by,
            related_user_id = EXCLUDED.related_user_id,
            notes = EXCLUDED.notes,
            banned_at = NOW()`,
    [String(pubkey), reason ?? null, bannedBy ?? null, relatedUserId ? Number(relatedUserId) : null, notes ?? null],
  );
}

export async function unbanWallet(pubkey) {
  const { rowCount } = await query(
    `DELETE FROM banned_wallets WHERE wallet_pubkey = $1`,
    [String(pubkey)],
  );
  return rowCount;
}
