#!/usr/bin/env node
/**
 * Recover a wallet's private key from the wallet_snapshots audit log.
 *
 * Use when:
 *   - A user's live `wallets.encrypted_secret` row was overwritten/corrupted
 *   - The original snapshot was recorded (going forward, EVERY wallet
 *     create + import writes a snapshot, so this should always work for
 *     wallets created after this feature shipped)
 *
 * Tries primary (Railway) first. Falls back to secondary (Neon) if set.
 *
 * Usage:
 *   node scripts/recover-from-snapshots.js <target_pubkey>
 *
 * Example:
 *   node scripts/recover-from-snapshots.js 2FGSXjT4TavT2YKmZbXXmrCtpF7C1ouKhbgvqTGNyakK
 *
 * Output:
 *   On match: prints the recovered base58 private key + verification
 *   On no-match: explains exactly what was found and why it failed
 */
import "dotenv/config";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import pkg from "pg";
const { Pool } = pkg;

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;

const targetPubkey = process.argv[2];
if (!targetPubkey) {
  console.error("Usage: node scripts/recover-from-snapshots.js <target_pubkey>");
  process.exit(1);
}

const encKeyHex = process.env.WALLET_ENCRYPTION_KEY;
if (!encKeyHex) {
  console.error("ERROR: WALLET_ENCRYPTION_KEY not set");
  process.exit(1);
}
const encKey = Buffer.from(encKeyHex, "hex");

function decrypt(ciphertext, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGO, encKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function tryDatabase(url, label) {
  if (!url) return null;
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  try {
    console.log(`\n[${label}] Looking for snapshots of ${targetPubkey}...`);
    const { rows } = await pool.query(
      `SELECT id, wallet_id, user_id, encrypted_secret, nonce, auth_tag,
              source, trigger, snapshotted_at
       FROM wallet_snapshots WHERE public_key = $1
       ORDER BY snapshotted_at ASC`,
      [targetPubkey],
    );
    if (rows.length === 0) {
      console.log(`  No snapshots found on ${label}.`);
      return null;
    }
    console.log(`  Found ${rows.length} snapshot(s) — trying each...`);
    for (const snap of rows) {
      try {
        const secret = decrypt(snap.encrypted_secret, snap.nonce, snap.auth_tag);
        const kp = Keypair.fromSecretKey(new Uint8Array(secret));
        const derived = kp.publicKey.toBase58();
        if (derived === targetPubkey) {
          console.log(`  ✓ Snapshot id=${snap.id} (${snap.trigger}, ${snap.snapshotted_at.toISOString()}) — MATCH`);
          return { secret, snapshot: snap, label };
        }
        console.log(`  ✗ Snapshot id=${snap.id} decrypts to ${derived.slice(0, 8)}... (not target)`);
      } catch (err) {
        console.log(`  ✗ Snapshot id=${snap.id} decrypt failed: ${err.message}`);
      }
    }
    return null;
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log("═══════════ Wallet Recovery from Snapshots ═══════════");
  console.log(`Target: ${targetPubkey}`);

  if (encKey.length !== KEY_LEN) {
    console.error(`ERROR: WALLET_ENCRYPTION_KEY must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars)`);
    process.exit(1);
  }

  // Try primary first
  let result = await tryDatabase(process.env.DATABASE_URL, "Railway primary");
  // Then secondary
  if (!result) {
    result = await tryDatabase(process.env.DATABASE_URL_SECONDARY, "Neon secondary");
  }

  if (!result) {
    console.log("\n❌ NO RECOVERY POSSIBLE");
    console.log("Neither primary nor secondary DB has a snapshot of this wallet.");
    console.log("Likely cause: wallet was created BEFORE the wallet_snapshots feature shipped,");
    console.log("OR the snapshot insert failed at create time.");
    console.log("\nIf you have any user-side backup of the key, that's the only remaining path.");
    process.exit(2);
  }

  const base58Key = bs58.encode(result.secret);
  console.log(`\n═══════════ ✅ RECOVERED ═══════════`);
  console.log(`Source: ${result.label}`);
  console.log(`Snapshot trigger: ${result.snapshot.trigger}`);
  console.log(`Recorded at: ${result.snapshot.snapshotted_at.toISOString()}`);
  console.log(`\nPrivate key (base58, KEEP SECRET):\n  ${base58Key}\n`);
  console.log("Next steps:");
  console.log("  1. Save this key in a secure place (1Password / Apple Keychain / etc.)");
  console.log("  2. Either:");
  console.log("     a) Have the user /import it back into their account, OR");
  console.log("     b) Run scripts/drain-wallet.js to programmatically transfer funds out");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
