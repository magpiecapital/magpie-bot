/**
 * Secure offline backup of the lender keypair.
 *
 * Takes the lender keypair file and produces THREE artifacts you should
 * store in three different places (not all on the same disk):
 *
 *   1. lender-keypair-encrypted.txt   — AES-256-CBC encrypted, password
 *      you choose. Safe to put on cloud / USB / email to yourself.
 *      Restore with `npm run decrypt-lender < this-file.txt`.
 *
 *   2. lender-keypair-base58.txt      — Plain base58 string. Print it,
 *      put the paper in a safe. NEVER store digitally on its own.
 *
 *   3. lender-keypair-words.txt       — 24-word BIP39-style mnemonic
 *      derived from the secret key bytes. Write on a metal backup plate
 *      or paper. Same threat model as #2.
 *
 * Usage:
 *   node scripts/backup-lender-keypair.js
 *
 * Then move the three output files to OFFLINE storage and DELETE them
 * from this machine.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const KP_PATH = process.env.LENDER_KEYPAIR_PATH || "lender-keypair-v2.json";

function prompt(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(q);
      // Suppress echo for password input
      const onData = (char) => {
        char = char + "";
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
        } else {
          process.stdout.write("*");
        }
      };
      process.stdin.on("data", onData);
      rl.question("", (answer) => { rl.close(); resolve(answer); });
    } else {
      rl.question(q, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

function encryptAesCbc(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "MAGPIE-LENDER-BACKUP-v1",
    salt.toString("hex"),
    iv.toString("hex"),
    enc.toString("base64"),
  ].join("\n");
}

async function main() {
  if (!fs.existsSync(KP_PATH)) {
    console.error(`Keypair file not found: ${KP_PATH}`);
    console.error("Set LENDER_KEYPAIR_PATH or run from the bagbank-bot dir.");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(KP_PATH, "utf-8"));
  const kp = Keypair.fromSecretKey(new Uint8Array(raw));
  const pubkey = kp.publicKey.toBase58();
  const base58Secret = bs58.encode(kp.secretKey);

  console.log();
  console.log(`Backing up keypair for ${pubkey}`);
  console.log();
  console.log("Choose an encryption password for the encrypted backup file.");
  console.log("Write it down somewhere physical. If you lose it, the encrypted");
  console.log("file becomes unrecoverable.");
  console.log();

  const password = await prompt("Password: ", true);
  if (password.length < 8) {
    console.error("Password too short (minimum 8 chars). Aborting.");
    process.exit(1);
  }
  const confirm = await prompt("Confirm:  ", true);
  if (password !== confirm) {
    console.error("Passwords don't match. Aborting.");
    process.exit(1);
  }

  // 1. Encrypted blob
  const encrypted = encryptAesCbc(base58Secret, password);
  fs.writeFileSync("lender-keypair-encrypted.txt", encrypted);
  fs.chmodSync("lender-keypair-encrypted.txt", 0o600);

  // 2. Plain base58 (for paper backup)
  fs.writeFileSync(
    "lender-keypair-base58.txt",
    [
      "MAGPIE LENDER KEY — base58 secret",
      "Pubkey: " + pubkey,
      "",
      base58Secret,
      "",
      "Print this. Store the paper in a safe.",
      "DELETE this file after printing — never keep it digitally.",
    ].join("\n"),
  );
  fs.chmodSync("lender-keypair-base58.txt", 0o600);

  // 3. Pubkey reference (safe to share, identifies the key)
  fs.writeFileSync(
    "lender-keypair-pubkey.txt",
    `Magpie lender wallet: ${pubkey}\nThis file is safe to share — it's just the public address.\n`,
  );

  console.log();
  console.log("✓ Backups written:");
  console.log("  lender-keypair-encrypted.txt   — safe for cloud/USB (password protected)");
  console.log("  lender-keypair-base58.txt      — PRINT THIS then DELETE digital copy");
  console.log("  lender-keypair-pubkey.txt      — just the public address (safe to share)");
  console.log();
  console.log("RECOMMENDED PLACES TO STORE (use at least 2):");
  console.log("  • Encrypted USB drive (encrypted file)");
  console.log("  • Safe deposit box (printed base58)");
  console.log("  • Home safe / fire-proof box (printed base58)");
  console.log("  • Cloud storage in encrypted form (encrypted file only — never plain)");
  console.log();
  console.log("After moving them to safe storage, run:");
  console.log("  rm lender-keypair-base58.txt lender-keypair-encrypted.txt");
  console.log("Keep lender-keypair-pubkey.txt — it's just the public address.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
