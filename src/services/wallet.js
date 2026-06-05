/**
 * Wallet service — supports multiple wallets per user with one
 * active wallet at a time.
 *
 * Schema invariant: at most one wallet per user has is_active=TRUE
 * (enforced by partial unique index `wallets_one_active_per_user_idx`).
 * Every loan/repay/etc tx signs with the ACTIVE wallet.
 *
 * Users can:
 *   • /import — adds a new wallet, makes it active (siblings deactivated)
 *   • /wallets — lists their wallets + switches active
 *   • /export — exports the active wallet's secret
 */
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { query } from "../db/pool.js";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

// Maximum number of wallets per user. Covers normal use (Magpie
// custodial + a few external wallets) while keeping the /wallets UI
// scannable and bounding any potential abuse. Re-importing an existing
// wallet doesn't count toward this cap (it just re-activates the row).
export const MAX_WALLETS_PER_USER = 10;
export class WalletLimitError extends Error {
  constructor(currentCount, max) {
    super(`User has ${currentCount} wallets; max is ${max}`);
    this.name = "WalletLimitError";
    this.currentCount = currentCount;
    this.max = max;
  }
}

function getKey() {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex) throw new Error("WALLET_ENCRYPTION_KEY not set");
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LEN) {
    throw new Error(`WALLET_ENCRYPTION_KEY must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars)`);
  }
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decrypt(ciphertext, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Get or create the ACTIVE wallet for a user. If they have no wallets
 * yet, generate a custodial one and mark it active.
 *
 * Returns { publicKey, walletId, source, label } — secret never returned.
 */
export async function ensureWallet(userId) {
  // Look for the active wallet first
  const existing = await query(
    `SELECT id, public_key, source, label
       FROM wallets
      WHERE user_id = $1 AND is_active = TRUE
      LIMIT 1`,
    [userId],
  );
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    return {
      publicKey: r.public_key,
      walletId: r.id,
      source: r.source,
      label: r.label,
    };
  }

  // No active wallet. Are there any inactive ones? If so, activate
  // the oldest custodial one (this can happen if data was migrated).
  const any = await query(
    `SELECT id, public_key, source, label FROM wallets
      WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId],
  );
  if (any.rows.length > 0) {
    const r = any.rows[0];
    await query(`UPDATE wallets SET is_active = TRUE WHERE id = $1`, [r.id]);
    return {
      publicKey: r.public_key,
      walletId: r.id,
      source: r.source,
      label: r.label,
    };
  }

  // No wallets at all — generate a new custodial one.
  const kp = Keypair.generate();
  const secretBuf = Buffer.from(kp.secretKey);
  const { ciphertext, iv, authTag } = encrypt(secretBuf);
  const publicKey = kp.publicKey.toBase58();

  const { rows: [inserted] } = await query(
    `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag,
                          source, label, is_active)
     VALUES ($1, $2, $3, $4, $5, 'custodial', 'Magpie wallet', TRUE)
     RETURNING id`,
    [userId, publicKey, ciphertext, iv, authTag],
  );
  // The `wallets_auto_snapshot` DB trigger writes a wallet_snapshots
  // row automatically on every INSERT — no app-side call needed.

  return {
    publicKey,
    walletId: inserted.id,
    source: "custodial",
    label: "Magpie wallet",
  };
}

/**
 * Load the full Keypair for the user's ACTIVE wallet.
 * Use sparingly — keep in memory only as long as needed.
 */
export async function loadKeypair(userId) {
  const { rows } = await query(
    `SELECT encrypted_secret, nonce, auth_tag
       FROM wallets
      WHERE user_id = $1 AND is_active = TRUE
      LIMIT 1`,
    [userId],
  );
  if (rows.length === 0) throw new Error("No active wallet found");
  const row = rows[0];
  const secret = decrypt(row.encrypted_secret, row.nonce, row.auth_tag);
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

/**
 * List ALL wallets for a user (active + inactive). Used by the
 * /wallets command for display + switching.
 *
 * Returns array of { id, publicKey, source, label, isActive, createdAt }.
 * Secrets are never returned.
 */
export async function listWallets(userId) {
  const { rows } = await query(
    `SELECT id, public_key, source, label, is_active, created_at
       FROM wallets
      WHERE user_id = $1
      ORDER BY is_active DESC, created_at ASC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    publicKey: r.public_key,
    source: r.source,
    label: r.label || (r.source === "custodial" ? "Magpie wallet" : "Imported"),
    isActive: r.is_active,
    createdAt: r.created_at,
  }));
}

/**
 * Switch the active wallet for a user. Deactivates all the user's
 * other wallets and activates the specified one — atomic via a
 * transaction so we never have zero or two actives.
 */
export async function setActiveWallet(userId, walletId) {
  // Verify ownership before flipping anything
  const { rows } = await query(
    `SELECT id FROM wallets WHERE id = $1 AND user_id = $2`,
    [walletId, userId],
  );
  if (rows.length === 0) {
    throw new Error("Wallet not found or not yours");
  }
  // Atomic flip: deactivate all of this user's wallets, then activate one.
  // The partial unique index would reject the second UPDATE if we set
  // before unsetting, so order matters.
  await query(`UPDATE wallets SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`, [userId]);
  await query(`UPDATE wallets SET is_active = TRUE WHERE id = $1`, [walletId]);
}

/**
 * Import an existing wallet. ADDS a new wallet (or activates an
 * existing one with the same public key), and makes it active.
 *
 * NEVER overwrites or destroys an existing wallet's secret —
 * the user's other wallets are preserved and they can switch
 * back via /wallets any time.
 *
 * Returns { publicKey, walletId, alreadyExisted }.
 */
export async function importWallet(userId, base58PrivateKey) {
  const decoded = bs58.decode(base58PrivateKey);
  const kp = Keypair.fromSecretKey(decoded);
  const publicKey = kp.publicKey.toBase58();

  // Already have this wallet? Just activate it. Re-imports don't count
  // toward the wallet cap — they're a no-op on the count.
  const existing = await query(
    `SELECT id FROM wallets WHERE user_id = $1 AND public_key = $2 LIMIT 1`,
    [userId, publicKey],
  );
  if (existing.rows.length > 0) {
    await setActiveWallet(userId, existing.rows[0].id);
    return { publicKey, walletId: existing.rows[0].id, alreadyExisted: true };
  }

  // Hard cap on wallets per user. New wallet only (re-imports already
  // returned above). If they're at the limit, refuse — caller will
  // surface a friendly message via the WalletLimitError type.
  const { rows: [count] } = await query(
    `SELECT COUNT(*)::int AS n FROM wallets WHERE user_id = $1`,
    [userId],
  );
  if ((count?.n || 0) >= MAX_WALLETS_PER_USER) {
    throw new WalletLimitError(count.n, MAX_WALLETS_PER_USER);
  }

  // New wallet — insert it. Deactivate all current actives first so
  // the partial unique index doesn't reject the new one.
  await query(`UPDATE wallets SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`, [userId]);

  const secretBuf = Buffer.from(kp.secretKey);
  const { ciphertext, iv, authTag } = encrypt(secretBuf);
  const { rows: [inserted] } = await query(
    `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag,
                          source, label, is_active)
     VALUES ($1, $2, $3, $4, $5, 'imported', 'Imported wallet', TRUE)
     RETURNING id`,
    [userId, publicKey, ciphertext, iv, authTag],
  );
  // The `wallets_auto_snapshot` DB trigger writes a wallet_snapshots
  // row automatically on every INSERT — no app-side call needed.

  // Mirror the user's aggregated credit score to the newly-imported
  // wallet on-chain so its reputation is visible from this signer the
  // moment any program reads it. Fire-and-forget — if the publisher
  // hits a transient RPC blip or the oracle isn't deployed yet, the
  // import flow doesn't care. The batch publisher will catch up on
  // its next cycle.
  (async () => {
    try {
      const { publishScoreOnChain } = await import("./credit-oracle-publisher.js");
      await publishScoreOnChain(userId);
    } catch (err) {
      console.warn("[wallet-import] credit publish failed (non-blocking):", err.message);
    }
  })();

  return { publicKey, walletId: inserted.id, alreadyExisted: false };
}

/**
 * Export base58 secret key for the ACTIVE wallet only.
 */
export async function exportSecret(userId) {
  const kp = await loadKeypair(userId);
  return bs58.encode(kp.secretKey);
}

/**
 * Export base58 secret for a SPECIFIC wallet (by wallet id). Used
 * when the user wants to export an inactive wallet without first
 * having to switch to it.
 */
export async function exportSecretByWalletId(userId, walletId) {
  const { rows } = await query(
    `SELECT encrypted_secret, nonce, auth_tag
       FROM wallets WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [walletId, userId],
  );
  if (rows.length === 0) throw new Error("Wallet not found or not yours");
  const row = rows[0];
  const secret = decrypt(row.encrypted_secret, row.nonce, row.auth_tag);
  return bs58.encode(secret);
}

/**
 * Rename a wallet's label.
 */
export async function renameWallet(userId, walletId, label) {
  const clean = (label || "").trim().slice(0, 40);
  await query(
    `UPDATE wallets SET label = $1 WHERE id = $2 AND user_id = $3`,
    [clean || null, walletId, userId],
  );
}

// Errors specific to remove flow — caller maps these to friendly messages.
export class CannotRemoveActiveWalletError extends Error {
  constructor() {
    super("Active wallet cannot be removed. Switch to another wallet first.");
    this.name = "CannotRemoveActiveWalletError";
  }
}
export class WalletHasActiveLoansError extends Error {
  constructor(loanPdas) {
    super(`Wallet has ${loanPdas.length} active loan(s) tied to it on-chain.`);
    this.name = "WalletHasActiveLoansError";
    this.loanPdas = loanPdas;
  }
}

/**
 * Remove a wallet from the user's account, freeing a slot under the
 * 10-wallet cap so they can /import a different one.
 *
 * SAFETY GUARDS:
 *   - Refuses to remove the user's currently-active wallet (no orphaned
 *     signer state). They must /wallets switch first.
 *   - Refuses to remove a wallet that's the on-chain BORROWER of any
 *     active loan. Removing such a wallet would orphan the loan —
 *     exactly the wallet-loss bug class we fixed. Per the on-chain
 *     `Loan.borrower` field, we cross-reference each of the user's
 *     active loans and block removal if any borrow from this wallet.
 *   - The wallet_snapshots history is NEVER touched, so if the user
 *     ever wants to re-import the same wallet, the historical key
 *     material is preserved in the audit log.
 *
 * Returns nothing on success; throws one of the typed errors above on
 * refusal. Caller is responsible for rendering an appropriate message.
 */
export async function removeWallet(userId, walletId) {
  // 1. Verify ownership + fetch state
  const { rows } = await query(
    `SELECT id, public_key, is_active, label
       FROM wallets
      WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [walletId, userId],
  );
  if (rows.length === 0) throw new Error("Wallet not found or not yours");
  const wallet = rows[0];
  if (wallet.is_active) throw new CannotRemoveActiveWalletError();

  // 2. Cross-reference active loans against this wallet's pubkey.
  // The loans table only stores user_id + loan_pda, not the on-chain
  // borrower. So we fetch the borrower field from each loan PDA and
  // check if any match the wallet we're trying to remove.
  const { rows: activeLoans } = await query(
    `SELECT id, loan_pda FROM loans WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  if (activeLoans.length > 0) {
    const { getReadOnlyProgram } = await import("../solana/program.js");
    const program = getReadOnlyProgram();
    const tiedLoans = [];
    for (const l of activeLoans) {
      try {
        const onChain = await program.account.loan.fetch(new PublicKey(l.loan_pda));
        if (onChain.borrower?.toBase58?.() === wallet.public_key) {
          tiedLoans.push(l.loan_pda);
        }
      } catch (err) {
        // Couldn't fetch — fail safe: assume it might be tied, refuse removal.
        // This is rare (RPC blip) and the user can retry after a moment.
        console.warn(`[wallet-remove] couldn't verify loan ${l.loan_pda}: ${err.message}`);
        throw new Error(`Couldn't verify all active loans right now. Try again in a moment.`);
      }
    }
    if (tiedLoans.length > 0) {
      throw new WalletHasActiveLoansError(tiedLoans);
    }
  }

  // 3. Safe to remove. The wallet_snapshots audit log keeps the
  // encrypted_secret history regardless of this DELETE.
  await query(`DELETE FROM wallets WHERE id = $1 AND user_id = $2`, [walletId, userId]);
}
