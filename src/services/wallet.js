import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { query } from "../db/pool.js";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

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
 * Get or create a custodial Solana wallet for a Telegram user.
 * Returns { publicKey: string } — secret is never returned here.
 */
export async function ensureWallet(userId) {
  const existing = await query("SELECT public_key FROM wallets WHERE user_id = $1", [userId]);
  if (existing.rows.length > 0) {
    return { publicKey: existing.rows[0].public_key };
  }

  const kp = Keypair.generate();
  const secretBuf = Buffer.from(kp.secretKey);
  const { ciphertext, iv, authTag } = encrypt(secretBuf);

  await query(
    `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, kp.publicKey.toBase58(), ciphertext, iv, authTag],
  );

  return { publicKey: kp.publicKey.toBase58() };
}

/**
 * Load the full Keypair for a user. Use sparingly — keep in memory only as long as needed.
 */
export async function loadKeypair(userId) {
  const { rows } = await query(
    "SELECT encrypted_secret, nonce, auth_tag FROM wallets WHERE user_id = $1",
    [userId],
  );
  if (rows.length === 0) throw new Error("Wallet not found");
  const row = rows[0];
  const secret = decrypt(row.encrypted_secret, row.nonce, row.auth_tag);
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

/**
 * Import an existing wallet by base58 private key.
 * Replaces any existing wallet for this user.
 * Returns { publicKey: string }.
 */
export async function importWallet(userId, base58PrivateKey) {
  const decoded = bs58.decode(base58PrivateKey);
  const kp = Keypair.fromSecretKey(decoded);
  const secretBuf = Buffer.from(kp.secretKey);
  const { ciphertext, iv, authTag } = encrypt(secretBuf);

  const existing = await query("SELECT id FROM wallets WHERE user_id = $1", [userId]);
  if (existing.rows.length > 0) {
    await query(
      `UPDATE wallets SET public_key = $2, encrypted_secret = $3, nonce = $4, auth_tag = $5
       WHERE user_id = $1`,
      [userId, kp.publicKey.toBase58(), ciphertext, iv, authTag],
    );
  } else {
    await query(
      `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, kp.publicKey.toBase58(), ciphertext, iv, authTag],
    );
  }

  return { publicKey: kp.publicKey.toBase58() };
}

/**
 * Export base58 secret key for user (used by /export command with confirmation).
 */
export async function exportSecret(userId) {
  const kp = await loadKeypair(userId);
  return bs58.encode(kp.secretKey);
}
