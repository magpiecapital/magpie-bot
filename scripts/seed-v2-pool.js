#!/usr/bin/env node
/**
 * Seed the v2 lending pool with a small amount of SOL so the operator
 * test borrow can actually receive a loan. Without this, every borrow
 * fails with InsufficientLiquidity (custom error 6005).
 *
 * Deposits 0.5 SOL — enough to cover a small operator test borrow plus
 * leave headroom. The depositor receives LP shares for this deposit
 * (recorded in the position PDA), so it's not a one-way drain — the
 * operator can withdraw later.
 *
 * Usage:
 *   PROGRAM_ID_V2=<id> SOLANA_RPC_URL=... LENDER_KEYPAIR_PATH=... \
 *     node scripts/seed-v2-pool.js
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, BN } = anchor;

const V2_PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID_V2);
const DEPOSIT_LAMPORTS = new BN(500_000_000); // 0.5 SOL
const LENDER_KP_PATH = process.env.LENDER_KEYPAIR_PATH ?? "./lender-keypair-v2.json";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC, "confirmed");
const depositor = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(LENDER_KP_PATH, "utf8"))),
);
console.log(`Depositor: ${depositor.publicKey.toBase58()}`);
console.log(`v2 program: ${V2_PROGRAM_ID.toBase58()}`);
console.log(`Deposit: ${Number(DEPOSIT_LAMPORTS) / 1e9} SOL`);

const idl = JSON.parse(readFileSync("./src/solana/idl/magpie_lending_v2.json", "utf8"));
const provider = new AnchorProvider(connection, new Wallet(depositor), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), depositor.publicKey.toBuffer()],
  V2_PROGRAM_ID,
);
const [loanTokenVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), poolPda.toBuffer()],
  V2_PROGRAM_ID,
);
const [positionPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), poolPda.toBuffer(), depositor.publicKey.toBuffer()],
  V2_PROGRAM_ID,
);
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, depositor.publicKey, false, TOKEN_PROGRAM_ID);

console.log(`\npool: ${poolPda.toBase58()}`);
console.log(`position: ${positionPda.toBase58()}`);
console.log(`wSOL ATA: ${wsolAta.toBase58()}`);

// Wrap SOL → wSOL in the depositor's ATA, then call deposit, then close ATA to refund leftover.
const preIxs = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  createAssociatedTokenAccountIdempotentInstruction(
    depositor.publicKey, wsolAta, depositor.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
  ),
  SystemProgram.transfer({
    fromPubkey: depositor.publicKey,
    toPubkey: wsolAta,
    lamports: BigInt(DEPOSIT_LAMPORTS.toString()),
  }),
  createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
];
const postIxs = [
  createCloseAccountInstruction(
    wsolAta, depositor.publicKey, depositor.publicKey, [], TOKEN_PROGRAM_ID,
  ),
];

try {
  const sig = await program.methods
    .deposit(DEPOSIT_LAMPORTS)
    .accounts({
      pool: poolPda,
      loanTokenVault: loanTokenVaultPda,
      position: positionPda,
      depositorTokenAccount: wsolAta,
      depositor: depositor.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .rpc({ commitment: "confirmed" });
  console.log(`\n✓✓✓ Pool seeded with ${Number(DEPOSIT_LAMPORTS) / 1e9} SOL`);
  console.log(`  tx: ${sig}`);
} catch (e) {
  console.error(`\n✗ Deposit failed: ${e.message}`);
  if (e.logs) for (const l of e.logs.slice(-8)) console.error("  " + l);
  process.exit(1);
}
