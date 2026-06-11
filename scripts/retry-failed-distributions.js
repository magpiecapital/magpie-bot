#!/usr/bin/env node
/**
 * Retry single-tx sends for governance_distributions rows currently
 * marked status='failed'.
 *
 * The main executor batches 10 transfers per tx for efficiency, but
 * when one recipient is below rent-exempt minimum, the whole batch
 * fails — even the 9 valid recipients. This retry sends ONE recipient
 * per tx, so each succeeds or fails on its own.
 *
 * Updates the DB:
 *   - On success: tx_signature, sent_at, status='sent'
 *   - On failure: failure_reason updated; status stays 'failed'
 *
 * Usage:
 *   SENDER_KEYPAIR=/path/to/sender.json \
 *   SOLANA_RPC_URL=https://… \
 *     node scripts/retry-failed-distributions.js MGP-001               # dry-run (default)
 *     node scripts/retry-failed-distributions.js MGP-001 --execute \
 *       --confirm "I understand this is irreversible"                  # actually send
 */

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import pg from "pg";
import "dotenv/config";

const args = process.argv.slice(2);
const proposalId = args[0];
if (!proposalId || !/^MGP-\d{3}$/.test(proposalId)) {
  console.error("Usage: node scripts/retry-failed-distributions.js MGP-XXX [--execute --confirm \"I understand this is irreversible\"]");
  process.exit(1);
}
const executeFlagIdx = args.indexOf("--execute");
const confirmFlagIdx = args.indexOf("--confirm");
const EXECUTE = executeFlagIdx >= 0;
const CONFIRM_STRING = confirmFlagIdx >= 0 ? args[confirmFlagIdx + 1] : null;
const REQUIRED_CONFIRM = "I understand this is irreversible";
if (EXECUTE && CONFIRM_STRING !== REQUIRED_CONFIRM) {
  console.error(`--execute requires --confirm "${REQUIRED_CONFIRM}" exactly. Aborting.`);
  process.exit(1);
}
const DRY_RUN = !EXECUTE;

const keypairPath = process.env.SENDER_KEYPAIR;
if (!keypairPath) {
  console.error("SENDER_KEYPAIR env var not set");
  process.exit(1);
}

const senderRaw = JSON.parse(readFileSync(keypairPath, "utf8"));
const sender = Keypair.fromSecretKey(new Uint8Array(senderRaw));
console.log("Sender:", sender.publicKey.toBase58());

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTER_TX_DELAY_MS = Math.max(0, Number(process.env.INTER_TX_DELAY_MS) || 600);

const { rows: failed } = await pool.query(
  `SELECT wallet, allocated_lamports::text AS lamports
     FROM governance_distributions
    WHERE proposal_id = $1 AND status = 'failed'
    ORDER BY allocated_lamports DESC`,
  [proposalId],
);

console.log(`Failed recipients to retry: ${failed.length}`);
const totalLamports = failed.reduce((a, r) => a + BigInt(r.lamports), 0n);
console.log(`Total to resend           : ${(Number(totalLamports) / 1e9).toFixed(9)} SOL`);
const balance = await connection.getBalance(sender.publicKey);
console.log(`Sender balance            : ${(balance / 1e9).toFixed(6)} SOL`);
console.log(`Mode                      : ${DRY_RUN ? "DRY-RUN (no sends)" : "EXECUTE"}`);

if (DRY_RUN) {
  console.log("");
  console.log("Dry-run — no transactions sent. Re-run with:");
  console.log(`  --execute --confirm "${REQUIRED_CONFIRM}"`);
  await pool.end();
  process.exit(0);
}

let succeeded = 0;
let stillFailed = 0;
const stillFailedDetails = [];

for (let i = 0; i < failed.length; i++) {
  const { wallet, lamports } = failed[i];
  const amount = BigInt(lamports);
  process.stdout.write(`  ${i + 1}/${failed.length}  ${wallet.slice(0, 8)}…${wallet.slice(-4)}  ${(Number(amount) / 1e9).toFixed(9)} SOL  `);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: new PublicKey(wallet),
      lamports: amount,
    }),
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [sender], {
      commitment: "confirmed",
    });
    await pool.query(
      `UPDATE governance_distributions
          SET tx_signature = $1, sent_at = NOW(), status = 'sent', failure_reason = NULL
        WHERE proposal_id = $2 AND wallet = $3`,
      [sig, proposalId, wallet],
    );
    succeeded++;
    console.log(`✓ ${sig.slice(0, 16)}…`);
  } catch (err) {
    stillFailed++;
    const reason = (err.message || String(err)).slice(0, 300);
    stillFailedDetails.push({ wallet, lamports: amount.toString(), reason });
    await pool.query(
      `UPDATE governance_distributions
          SET failure_reason = $1
        WHERE proposal_id = $2 AND wallet = $3`,
      [reason, proposalId, wallet],
    );
    console.log(`✗ ${reason.slice(0, 70)}…`);
  }
  if (i + 1 < failed.length) await sleep(INTER_TX_DELAY_MS);
}

console.log("");
console.log("─── Retry complete ───");
console.log(`Succeeded     : ${succeeded}`);
console.log(`Still failed  : ${stillFailed}`);
if (stillFailedDetails.length > 0) {
  console.log("");
  console.log("Still-failing recipients (probably need wallet to be initialized on-chain first, OR amount is below rent-exempt minimum):");
  for (const f of stillFailedDetails) {
    console.log(`  ${f.wallet}  ${(Number(f.lamports) / 1e9).toFixed(9)} SOL`);
  }
}

await pool.end();
process.exit(0);
