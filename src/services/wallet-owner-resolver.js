/**
 * Wallet → user_id resolver — the ONE correct way to look up which
 * Magpie user owns a given Solana pubkey.
 *
 * Why this exists:
 *
 *   A wallet pubkey can have MULTIPLE rows in the `wallets` table —
 *   one per (user_id, public_key) pair. This is by design: the site
 *   auto-creates a "site_native" user the first time someone connects
 *   a Phantom wallet, AND a separate "imported" row appears when the
 *   user later links that same wallet to their Telegram account.
 *
 *   Before this helper, the codebase had ~15 spots doing
 *     `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`
 *   with NO `ORDER BY`. Postgres returned whichever row it pleased,
 *   which was usually the older `site_native` row. New loans (and
 *   especially V3 RWA loans borrowed via the site) ended up under
 *   the site-only user_id rather than the TG-linked one. When the
 *   user ran /repay in Telegram, the loan didn't show up.
 *
 *   This helper picks the RIGHT user_id deterministically:
 *
 *     1. Prefer the row whose owning user has a non-null/non-zero
 *        telegram_id (that's the human controlling the wallet from TG).
 *     2. Among those, prefer is_active=TRUE rows (the user explicitly
 *        chose this wallet as their active one).
 *     3. Among those, prefer the most-recently-created row (the most
 *        recent intent wins).
 *     4. Fall back to any wallet row if no TG-linked rows exist (site-
 *        only users still get a valid user_id).
 *
 *   The bot's /repay, /topup, /extend, etc. all scope by user_id. Picking
 *   the TG-linked user_id whenever possible means loans always land in
 *   the correct user's TG-visible scope.
 *
 * Use this for every wallet → user_id lookup:
 *
 *     import { resolveWalletOwner } from "./wallet-owner-resolver.js";
 *     const userId = await resolveWalletOwner(borrowerPubkey);
 */

import { query } from "../db/pool.js";

/**
 * Look up the canonical user_id for a wallet pubkey.
 *
 * Returns the resolved user_id (string) or null if no wallet row exists.
 *
 * Implementation detail: a single ranked SELECT keeps this to one
 * round-trip. ORDER BY:
 *   - tg-linked rows first (NULLS LAST so a NULL telegram_id loses)
 *   - is_active DESC so explicit-current-wallet wins
 *   - created_at DESC so most-recent linkage wins on ties
 */
export async function resolveWalletOwner(publicKey) {
  if (!publicKey || typeof publicKey !== "string") return null;
  const { rows } = await query(
    `SELECT w.user_id
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      ORDER BY (u.telegram_id IS NOT NULL AND u.telegram_id > 0) DESC,
               w.is_active DESC,
               w.created_at DESC
      LIMIT 1`,
    [publicKey],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * Variant that returns the full wallet row (user_id + metadata) so
 * callers that need more than just the id (e.g. cosign-borrow checking
 * is_active) don't have to re-query.
 */
export async function resolveWalletOwnerRow(publicKey) {
  if (!publicKey || typeof publicKey !== "string") return null;
  const { rows } = await query(
    `SELECT w.user_id, w.public_key, w.is_active, w.source, w.label,
            w.created_at, u.telegram_id
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      ORDER BY (u.telegram_id IS NOT NULL AND u.telegram_id > 0) DESC,
               w.is_active DESC,
               w.created_at DESC
      LIMIT 1`,
    [publicKey],
  );
  return rows[0] ?? null;
}
