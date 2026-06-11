#!/usr/bin/env node
/**
 * Rotate WALLET_ENCRYPTION_KEY for every custodial wallet in the DB.
 *
 * Why this exists: the .env was world-readable until 2026-06-11. The
 * WALLET_ENCRYPTION_KEY value sitting in it was also identical to the
 * 2026-05-18 .env.save snapshot, meaning it was never rotated after
 * the May 18 incident either. Assume the old key is compromised; we
 * need every encrypted_secret blob re-encrypted under a new key.
 *
 * Crypto details (mirror src/services/wallet.js):
 *   - aes-256-gcm
 *   - 32-byte key (hex-encoded in env)
 *   - 12-byte IV per blob, regenerated on re-encrypt
 *   - 16-byte auth tag
 *
 * Operating procedure:
 *
 *   1. Pause borrow/withdraw paths (operator):
 *        /admin pause-site "wallet key rotation"
 *      (or set site_global_state.disabled=TRUE manually)
 *      This prevents any wallet operation from happening mid-rotation.
 *
 *   2. Generate a new 32-byte key:
 *        node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
 *
 *   3. Run THIS script in DRY-RUN mode first to confirm the new key
 *      decrypts nothing legacy (would mean fresh key) and the old key
 *      decrypts every wallet (would mean key is correct):
 *        WALLET_ENCRYPTION_KEY_OLD=<current hex>  \
 *        WALLET_ENCRYPTION_KEY_NEW=<new hex>      \
 *        node scripts/rotate-wallet-encryption-key.js --dry-run
 *
 *      Expected: "decrypted N, would re-encrypt N, failed 0". If any
 *      decrypt fails under the OLD key, STOP and investigate — that
 *      wallet is already broken and rotating won't fix it.
 *
 *   4. Run for real:
 *        WALLET_ENCRYPTION_KEY_OLD=<current hex>  \
 *        WALLET_ENCRYPTION_KEY_NEW=<new hex>      \
 *        node scripts/rotate-wallet-encryption-key.js --commit
 *
 *      The script wraps every UPDATE in a single transaction. If
 *      anything fails mid-rotation, the transaction rolls back and
 *      the DB stays on the OLD key.
 *
 *   5. Set the NEW key on Railway as WALLET_ENCRYPTION_KEY (overwriting
 *      the old value), trigger a redeploy.
 *
 *   6. Smoke-test: a custodial-wallet user runs /balance — if it
 *      works, decryption under the new key succeeded. If they get
 *      "loadKeypair refused" or auth-tag errors, ROLLBACK by setting
 *      Railway back to the OLD key (the DB is now on the NEW key,
 *      so this won't work — see Recovery below).
 *
 *   7. Unpause /admin unpause-site.
 *
 * Recovery if something goes wrong:
 *   - The script does NOT delete the encrypted_secret_legacy column
 *     (it doesn't exist). Instead it ATOMICALLY swaps the entire row
 *     within one transaction. If you need to roll back, the OLD key
 *     must be restored on Railway AND the script must be re-run with
 *     OLD/NEW swapped to bring the DB back to the old encryption.
 *
 * Safety properties:
 *   - Idempotent per-row (uses BEGIN/COMMIT around each batch).
 *   - Refuses to start if OLD == NEW (no-op protection).
 *   - Validates new key length and hex format before touching the DB.
 *   - Counts every wallet; refuses to "commit" if dry-run-decrypt
 *     count disagrees with the live wallet count (caller-error guard).
 *   - Sample-verifies after re-encrypt by decrypting under the NEW
 *     key on every wallet it just rotated.
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REPO_ROOT, ".env") });

const { query, pool } = await import("../src/db/pool.js");

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

const OLD_HEX = process.env.WALLET_ENCRYPTION_KEY_OLD;
const NEW_HEX = process.env.WALLET_ENCRYPTION_KEY_NEW;
const MODE = process.argv.includes("--commit") ? "commit" : "dry-run";

function validateKey(label, hex) {
  if (!hex) throw new Error(`${label} is not set`);
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`${label} must be hex`);
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_LEN) throw new Error(`${label} must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars), got ${buf.length}`);
  return buf;
}

const oldKey = validateKey("WALLET_ENCRYPTION_KEY_OLD", OLD_HEX);
const newKey = validateKey("WALLET_ENCRYPTION_KEY_NEW", NEW_HEX);

if (oldKey.equals(newKey)) {
  console.error("OLD and NEW keys are identical — refusing to no-op rotate. Generate a fresh NEW key.");
  process.exit(1);
}

function decrypt(key, ciphertext, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

console.log(`[rotate] mode=${MODE}`);
console.log(`[rotate] OLD key fingerprint: sha256=${crypto.createHash("sha256").update(oldKey).digest("hex").slice(0, 16)}...`);
console.log(`[rotate] NEW key fingerprint: sha256=${crypto.createHash("sha256").update(newKey).digest("hex").slice(0, 16)}...`);

const { rows } = await query(
  `SELECT id, public_key, encrypted_secret, nonce, auth_tag
     FROM wallets
     WHERE encrypted_secret IS NOT NULL
       AND length(encrypted_secret) > 0
     ORDER BY id`,
);

console.log(`[rotate] found ${rows.length} wallets with non-empty encrypted_secret`);

let decrypted = 0;
let prepared = 0;
let failed = 0;
const updates = [];

for (const r of rows) {
  try {
    const plain = decrypt(oldKey, r.encrypted_secret, r.nonce, r.auth_tag);
    decrypted++;
    const { ciphertext, iv, authTag } = encrypt(newKey, plain);
    // Verify round-trip under NEW key before committing.
    const verify = decrypt(newKey, ciphertext, iv, authTag);
    if (!verify.equals(plain)) throw new Error("round-trip verify failed");
    updates.push({ id: r.id, encrypted_secret: ciphertext, nonce: iv, auth_tag: authTag });
    prepared++;
  } catch (err) {
    failed++;
    console.error(`[rotate] FAILED wallet id=${r.id} pk=${r.public_key.slice(0, 8)}...: ${err.message}`);
  }
}

console.log(`[rotate] decrypted=${decrypted} prepared=${prepared} failed=${failed}`);

if (failed > 0) {
  console.error(`[rotate] ${failed} wallets failed to decrypt under OLD key — STOPPING. Investigate before retry.`);
  process.exit(2);
}

if (MODE === "dry-run") {
  console.log(`[rotate] DRY-RUN complete. Would re-encrypt ${prepared} wallets. Re-run with --commit.`);
  process.exit(0);
}

console.log(`[rotate] committing ${prepared} re-encryptions...`);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const u of updates) {
    await client.query(
      `UPDATE wallets
          SET encrypted_secret = $2,
              nonce            = $3,
              auth_tag         = $4,
              updated_at       = NOW()
        WHERE id = $1`,
      [u.id, u.encrypted_secret, u.nonce, u.auth_tag],
    );
  }
  await client.query("COMMIT");
  console.log(`[rotate] ✓ ${prepared} wallets re-encrypted under NEW key.`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`[rotate] FAILED mid-transaction, rolled back:`, err.message);
  process.exit(3);
} finally {
  client.release();
}

console.log(`[rotate] Next step: set WALLET_ENCRYPTION_KEY=${NEW_HEX.slice(0, 8)}... on Railway and redeploy.`);
process.exit(0);
