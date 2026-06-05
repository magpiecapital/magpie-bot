#!/usr/bin/env node
/**
 * Initialize the v2 lending pool on mainnet.
 *
 * v2 has its own PDAs derived from its program ID, so it needs its own
 * pool initialized — completely separate from v1's pool. v1's pool, vaults,
 * and active loans are unaffected by this script.
 *
 * Same fee parameters as v1 (protocol_fee_bps=2000, keeper_reward_bps=500)
 * — keeps economics consistent regardless of which program services the loan.
 *
 * Authority: the same lender wallet that authorizes v1's pool. Single
 * authority across both programs (matches the existing single-wallet model).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, BN } = anchor;

const V2_PROGRAM_ID = new PublicKey("4EcnHCEgMTfaXrLwn4sv7a9BPHQekKANzQEr7bA2rUzW");
const LENDER_KP_PATH = process.env.LENDER_KEYPAIR_PATH ?? "./lender-keypair-v2.json";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC, "confirmed");
const lender = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(LENDER_KP_PATH, "utf8"))),
);
console.log(`Lender: ${lender.publicKey.toBase58()}`);
console.log(`RPC: ${RPC}`);
console.log(`v2 program: ${V2_PROGRAM_ID.toBase58()}`);

const idl = JSON.parse(readFileSync("./src/solana/idl/magpie_lending_v2.json", "utf8"));
const provider = new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lender.publicKey.toBuffer()],
  V2_PROGRAM_ID,
);
const [loanTokenVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), poolPda.toBuffer()],
  V2_PROGRAM_ID,
);

console.log(`\nv2 pool PDA:             ${poolPda.toBase58()}`);
console.log(`v2 loan token vault PDA: ${loanTokenVaultPda.toBase58()}`);

const existing = await connection.getAccountInfo(poolPda);
if (existing) {
  console.log(`\n✓ v2 pool already initialized (size ${existing.data.length}b). Nothing to do.`);
  process.exit(0);
}

const protocolFeeBps = 2000; // 20% — matches v1
const keeperRewardBps = 500; // 5%  — matches v1
console.log(`\nInitializing v2 pool with protocol_fee=${protocolFeeBps}bps, keeper_reward=${keeperRewardBps}bps...`);

try {
  const sig = await program.methods
    .initializePool(protocolFeeBps, keeperRewardBps)
    .accounts({
      pool: poolPda,
      loanTokenVault: loanTokenVaultPda,
      loanTokenMint: NATIVE_MINT,
      authority: lender.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ])
    .rpc({ commitment: "confirmed" });
  console.log(`\n✓✓✓ v2 pool initialized`);
  console.log(`  tx: ${sig}`);
  console.log(`  pool: ${poolPda.toBase58()}`);
  console.log(`  loan_token_vault: ${loanTokenVaultPda.toBase58()}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Set PROGRAM_ID_V2=${V2_PROGRAM_ID.toBase58()} on Railway`);
  console.log(`  2. Restart the bot to pick up the env var`);
  console.log(`  3. Operator test borrow against an NVDAx mint`);
} catch (e) {
  console.error(`\n✗ Pool init failed: ${e.message}`);
  if (e.logs) {
    console.error("Logs (last 10):");
    for (const l of e.logs.slice(-10)) console.error("  " + l);
  }
  process.exit(1);
}
