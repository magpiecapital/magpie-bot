#!/usr/bin/env node
/**
 * Send SOL from the lender wallet to a destination address.
 *
 * Used for operator-approved restitutions / credits / refunds.
 * Real-money operation — always dry-run first.
 *
 * Usage:
 *   node scripts/send-sol-from-lender.js --to <pubkey> --sol <N> --memo "<text>" --dry-run
 *   node scripts/send-sol-from-lender.js --to <pubkey> --sol <N> --memo "<text>" --execute
 */
import "dotenv/config";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const to = flag("--to");
const solStr = flag("--sol");
const memo = flag("--memo") ?? "";
const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");

if (!to || !solStr) {
  console.error('Usage: node scripts/send-sol-from-lender.js --to <pubkey> --sol <N> --memo "<text>" --dry-run|--execute');
  process.exit(1);
}
if (!dryRun && !execute) {
  console.error("Specify either --dry-run or --execute.");
  process.exit(1);
}

const sol = Number(solStr);
if (!Number.isFinite(sol) || sol <= 0 || sol > 5) {
  console.error("SOL amount must be > 0 and <= 5 (safety cap; raise the cap in source if you need more).");
  process.exit(1);
}
const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
const toPk = new PublicKey(to);

function loadLender() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const path = process.env.LENDER_KEYPAIR_PATH || "./lender-keypair.json";
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const lender = loadLender();
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "confirmed");

const balance = await connection.getBalance(lender.publicKey);
console.log("─── Transfer plan ───");
console.log(`From:     ${lender.publicKey.toBase58()}`);
console.log(`To:       ${toPk.toBase58()}`);
console.log(`Amount:   ${sol} SOL (${lamports} lamports)`);
console.log(`Memo:     ${memo || "(none)"}`);
console.log(`RPC:      ${RPC}`);
console.log(`Lender balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log("");

if (balance < lamports + 5_000_000) {
  console.error(`Lender balance too low — need ${sol + 0.005} SOL, have ${balance / LAMPORTS_PER_SOL}`);
  process.exit(1);
}

if (dryRun) {
  console.log("DRY-RUN — no tx submitted. Re-run with --execute to actually send.");
  process.exit(0);
}

const tx = new Transaction();
tx.add(
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
  SystemProgram.transfer({
    fromPubkey: lender.publicKey,
    toPubkey: toPk,
    lamports,
  }),
);
if (memo) {
  tx.add(new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, "utf8"),
  }));
}

try {
  const sig = await sendAndConfirmTransaction(connection, tx, [lender], {
    commitment: "confirmed",
    maxRetries: 3,
  });
  console.log(`✓ SENT. tx: ${sig}`);
  console.log(`  Solscan: https://solscan.io/tx/${sig}`);
  process.exit(0);
} catch (e) {
  console.error(`✗ Transfer failed: ${e.message}`);
  if (e.logs) for (const l of e.logs.slice(-5)) console.error("  " + l);
  process.exit(1);
}
