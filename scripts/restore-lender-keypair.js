/**
 * Restore a lender keypair from the encrypted backup produced by
 * backup-lender-keypair.js. Use this if you lose the local keypair
 * file and need to recover it from the encrypted backup.
 *
 * Usage:
 *   node scripts/restore-lender-keypair.js lender-keypair-encrypted.txt
 *
 * Outputs lender-keypair-restored.json which you can rename to
 * lender-keypair-v2.json once you've verified it.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

function prompt(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node scripts/restore-lender-keypair.js <encrypted-file>");
    process.exit(1);
  }
  const data = fs.readFileSync(path, "utf-8").trim().split("\n");
  if (data[0] !== "MAGPIE-LENDER-BACKUP-v1") {
    console.error("Not a Magpie lender backup file");
    process.exit(1);
  }
  const [, saltHex, ivHex, encB64] = data;
  const password = await prompt("Password: ");
  const key = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(ivHex, "hex"));
  let dec;
  try {
    dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    console.error("Wrong password or corrupted file.");
    process.exit(1);
  }
  const secret = bs58.decode(dec);
  const kp = Keypair.fromSecretKey(secret);
  fs.writeFileSync("lender-keypair-restored.json", JSON.stringify(Array.from(secret)));
  fs.chmodSync("lender-keypair-restored.json", 0o600);
  console.log(`✓ Restored ${kp.publicKey.toBase58()} → lender-keypair-restored.json`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
