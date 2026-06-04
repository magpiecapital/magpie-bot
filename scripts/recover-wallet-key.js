#!/usr/bin/env node
/**
 * Wallet key recovery script.
 *
 * USE WHEN: a user's wallet key was overwritten in the primary DB
 * (Railway) by the pre-fix /import behavior. This script reads the
 * encrypted_secret from the SECONDARY DB (Neon cold standby), decrypts
 * it with WALLET_ENCRYPTION_KEY, derives the public key, and verifies
 * it matches the expected wallet pubkey before printing anything.
 *
 * Usage:
 *   DATABASE_URL_SECONDARY=postgresql://... \
 *   WALLET_ENCRYPTION_KEY=... \
 *   node scripts/recover-wallet-key.js <target_pubkey>
 *
 * Example:
 *   node scripts/recover-wallet-key.js 2FGSXjT4TavT2YKmZbXXmrCtpF7C1ouKhbgvqTGNyakK
 *
 * Output:
 *   On success: prints the base58 private key + verification status
 *   On failure: explains exactly which check failed so you know which
 *               recovery path to try next (Railway backups, etc.)
 *
 * Safety:
 *   • The script VERIFIES the decrypted key derives to the expected
 *     pubkey BEFORE printing. If it doesn't match, Neon was synced
 *     AFTER the overwrite — we need a Railway backup instead.
 *   • Read-only on the database. Never modifies anything.
 *   • Doesn't broadcast any transactions — just retrieves the key.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import pkg from "pg";
const { Pool } = pkg;

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

const targetPubkey = process.argv[2];
if (!targetPubkey) {
  console.error("Usage: node scripts/recover-wallet-key.js <target_pubkey>");
  process.exit(1);
}

const neonUrl = process.env.DATABASE_URL_SECONDARY;
const encKeyHex = process.env.WALLET_ENCRYPTION_KEY;

if (!neonUrl) {
  console.error("ERROR: DATABASE_URL_SECONDARY (Neon connection string) not set.");
  console.error("Set it inline:");
  console.error("  DATABASE_URL_SECONDARY=postgresql://... node scripts/recover-wallet-key.js <pubkey>");
  process.exit(1);
}
if (!encKeyHex) {
  console.error("ERROR: WALLET_ENCRYPTION_KEY not set");
  process.exit(1);
}

const encKey = Buffer.from(encKeyHex, "hex");
if (encKey.length !== KEY_LEN) {
  console.error(`ERROR: WALLET_ENCRYPTION_KEY must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars)`);
  process.exit(1);
}

function decrypt(ciphertext, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGO, encKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function main() {
  console.log(`\n═══════════ Wallet Key Recovery ═══════════\n`);
  console.log(`Target pubkey:  ${targetPubkey}`);
  console.log(`Source DB:      Neon (secondary / cold standby)`);
  console.log(`Encryption:     AES-256-GCM\n`);

  const pool = new Pool({
    connectionString: neonUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  // Step 1: find the row
  console.log("[1/4] Looking up wallet row in Neon...");
  const { rows } = await pool.query(
    `SELECT id, user_id, public_key, encrypted_secret, nonce, auth_tag, created_at
     FROM wallets WHERE public_key = $1 LIMIT 1`,
    [targetPubkey],
  );

  if (rows.length === 0) {
    console.log("  ❌ NOT FOUND in Neon.");
    console.log("\n  This means Neon either:");
    console.log("    a) was never populated (no replication set up)");
    console.log("    b) was synced AFTER the wallet was deleted somehow");
    console.log("    c) the user used a different secondary DB");
    console.log("\n  → Try Railway point-in-time backups instead.");
    await pool.end();
    process.exit(2);
  }
  const row = rows[0];
  console.log(`  ✓ Row found. id=${row.id}, user_id=${row.user_id}, created=${row.created_at.toISOString()}`);

  // Step 2: decrypt
  console.log("\n[2/4] Decrypting encrypted_secret with WALLET_ENCRYPTION_KEY...");
  let secret;
  try {
    secret = decrypt(row.encrypted_secret, row.nonce, row.auth_tag);
  } catch (err) {
    console.log(`  ❌ DECRYPT FAILED: ${err.message}`);
    console.log("\n  This means either:");
    console.log("    a) WALLET_ENCRYPTION_KEY is wrong (mismatched with what encrypted the secret)");
    console.log("    b) The encrypted bytes are corrupted");
    console.log("\n  Verify the WALLET_ENCRYPTION_KEY matches what was used at /start time.");
    await pool.end();
    process.exit(3);
  }
  console.log(`  ✓ Decrypt successful. Secret length: ${secret.length} bytes`);

  if (secret.length !== 64) {
    console.log(`  ⚠️  Expected 64-byte Solana secret key, got ${secret.length} bytes.`);
    console.log("    This may still be a valid 32-byte seed — attempting to derive Keypair...");
  }

  // Step 3: derive pubkey
  console.log("\n[3/4] Deriving public key from decrypted secret...");
  let kp;
  try {
    kp = Keypair.fromSecretKey(new Uint8Array(secret));
  } catch (err) {
    console.log(`  ❌ KEYPAIR DERIVATION FAILED: ${err.message}`);
    await pool.end();
    process.exit(4);
  }
  const derivedPubkey = kp.publicKey.toBase58();
  console.log(`  Derived pubkey: ${derivedPubkey}`);

  // Step 4: VERIFY it matches the target. CRITICAL safety check.
  console.log("\n[4/4] Verifying derived pubkey matches target...");
  if (derivedPubkey !== targetPubkey) {
    console.log(`  ❌ MISMATCH`);
    console.log(`     Expected: ${targetPubkey}`);
    console.log(`     Got:      ${derivedPubkey}`);
    console.log("\n  This means Neon was synced AFTER the /import overwrite happened.");
    console.log("  The key we just decrypted is the WRONG one (probably the imported wallet's).");
    console.log("\n  → Try Railway point-in-time backups instead. The Railway dashboard has");
    console.log("    automated backups; restore one from before the user's /import time.");
    await pool.end();
    process.exit(5);
  }
  console.log("  ✓ MATCH. We have the right key.");

  // Output the recovered key
  const base58Key = bs58.encode(secret);
  console.log(`\n═══════════ ✅ RECOVERED ═══════════\n`);
  console.log(`Target wallet:    ${targetPubkey}`);
  console.log(`Private key (base58, KEEP SECRET):\n`);
  console.log(`  ${base58Key}\n`);
  console.log(`What to do next:`);
  console.log(`  1. Save this key somewhere SECURE (it's the wallet's only access).`);
  console.log(`  2. To recover funds for the user, EITHER:`);
  console.log(`     a) Have the user paste this key into /import on the bot. The bot will`);
  console.log(`        add it as their wallet (now non-destructive), they can /wallets to`);
  console.log(`        activate it, then /repay + /withdraw.`);
  console.log(`     b) OR run scripts/drain-wallet.js to programmatically transfer SOL + tokens`);
  console.log(`        to a destination wallet of the user's choosing.`);
  console.log(`\n  NEVER paste this key into a public chat, GitHub, or screenshot.\n`);

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
