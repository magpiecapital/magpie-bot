#!/usr/bin/env node
/**
 * One-shot: deposit SOL into the V4 lending pool from the lender keypair.
 *
 * Identical flow to scripts/deposit-to-pool.js but routes against V4 using
 * the freshly-built mainnet IDL. Used for the operator-canary 1 SOL seed.
 *
 * Usage:
 *   PROGRAM_ID_V4=<...> \
 *   LENDER_KEYPAIR_PATH=./lender-keypair.json \
 *   SOLANA_RPC_URL=<...> \
 *   node scripts/deposit-to-v4.mjs <sol_amount>
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchor;

const amountSolArg = parseFloat(process.argv[2]);
if (!amountSolArg || amountSolArg <= 0) {
  console.error("Usage: node scripts/deposit-to-v4.mjs <sol_amount>");
  process.exit(1);
}

const V4_PROGRAM_ID_STR = process.env.PROGRAM_ID_V4;
if (!V4_PROGRAM_ID_STR) {
  console.error("PROGRAM_ID_V4 env required");
  process.exit(1);
}
const V4_PROGRAM_ID = new PublicKey(V4_PROGRAM_ID_STR);

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const IDL_PATH = "./src/solana/idl/magpie-v4.json";
if (!existsSync(IDL_PATH)) {
  console.error(`Missing ${IDL_PATH}`);
  process.exit(1);
}

const kpPath = process.env.LENDER_KEYPAIR_PATH || "lender-keypair.json";
const lender = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))),
);

const connection = new Connection(RPC, "confirmed");
const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
idl.address = V4_PROGRAM_ID.toBase58();
const provider = new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [pool] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lender.publicKey.toBuffer()],
  V4_PROGRAM_ID,
);
const [loanTokenVault] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), pool.toBuffer()],
  V4_PROGRAM_ID,
);
const [position] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), pool.toBuffer(), lender.publicKey.toBuffer()],
  V4_PROGRAM_ID,
);

const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey);
const lamports = BigInt(Math.floor(amountSolArg * 1e9));

console.log(`V4 deposit:`);
console.log(`  lender:      ${lender.publicKey.toBase58()}`);
console.log(`  amount:      ${amountSolArg} SOL (${lamports} lamports)`);
console.log(`  v4 program:  ${V4_PROGRAM_ID.toBase58()}`);
console.log(`  pool:        ${pool.toBase58()}`);
console.log(`  vault:       ${loanTokenVault.toBase58()}`);
console.log(`  position:    ${position.toBase58()}`);

const preIxs = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  createAssociatedTokenAccountIdempotentInstruction(
    lender.publicKey, wsolAta, lender.publicKey, NATIVE_MINT,
  ),
  SystemProgram.transfer({
    fromPubkey: lender.publicKey, toPubkey: wsolAta, lamports,
  }),
  createSyncNativeInstruction(wsolAta),
];
const postIxs = [
  createCloseAccountInstruction(wsolAta, lender.publicKey, lender.publicKey),
];

const sig = await program.methods
  .deposit(new BN(lamports.toString()))
  .accounts({
    pool,
    loanTokenVault,
    position,
    depositorTokenAccount: wsolAta,
    depositor: lender.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .preInstructions(preIxs)
  .postInstructions(postIxs)
  .rpc({ commitment: "confirmed" });

console.log(`\nDeposit confirmed`);
console.log(`  tx: ${sig}`);
console.log(`  https://solscan.io/tx/${sig}`);

const p = await program.account.lendingPool.fetch(pool);
console.log(`  pool TVL after deposit: ${(Number(p.totalDeposits) / 1e9).toFixed(6)} SOL`);
console.log(`  total shares:           ${p.totalShares.toString()}`);
process.exit(0);
