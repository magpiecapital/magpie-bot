/**
 * One-shot: deposit SOL into the Magpie lending pool from the lender keypair.
 * Wraps native SOL → wSOL, calls program.deposit(amount), then closes the
 * wSOL ATA to recover rent.
 *
 * Usage:
 *   LENDER_KEYPAIR_PATH=lender-keypair-v2.json node scripts/deposit-to-pool.js 3.0
 */
import "dotenv/config";
import fs from "node:fs";
import {
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
import BN from "bn.js";

const amountSolArg = parseFloat(process.argv[2]);
if (!amountSolArg || amountSolArg <= 0) {
  console.error("Usage: node scripts/deposit-to-pool.js <sol_amount>");
  process.exit(1);
}

async function main() {
  const { connection } = await import("../src/solana/connection.js");
  const { getProgramForSigner } = await import("../src/solana/program.js");
  const { lendingPoolPda, loanTokenVaultPda } = await import("../src/solana/pdas.js");

  const kpPath = process.env.LENDER_KEYPAIR_PATH || "lender-keypair-v2.json";
  const lender = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
  const program = getProgramForSigner(lender);

  const [pool] = lendingPoolPda(lender.publicKey);
  const [loanTokenVault] = loanTokenVaultPda(pool);
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), lender.publicKey.toBuffer()],
    program.programId,
  );

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey);
  const lamports = BigInt(Math.floor(amountSolArg * 1e9));

  console.log(`Depositing ${amountSolArg} SOL (${lamports} lamports) from ${lender.publicKey.toBase58()}…`);
  console.log(`  Pool:     ${pool.toBase58()}`);
  console.log(`  Position: ${position.toBase58()}`);

  // Pre: wrap SOL → wSOL into the depositor's ATA
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      lender.publicKey,
      wsolAta,
      lender.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: lender.publicKey,
      toPubkey: wsolAta,
      lamports,
    }),
    createSyncNativeInstruction(wsolAta),
  ];

  // Post: close ATA to recover rent (leftover wSOL → native SOL).
  const postIxs = [createCloseAccountInstruction(wsolAta, lender.publicKey, lender.publicKey)];

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

  console.log(`✓ Deposited. Tx: ${sig}`);
  console.log(`  https://solscan.io/tx/${sig}`);

  // Show fresh pool state
  const p = await program.account.lendingPool.fetch(pool);
  console.log(`  Pool TVL after deposit: ${(Number(p.totalDeposits) / 1e9).toFixed(6)} SOL`);
  console.log(`  Total shares:           ${p.totalShares.toString()}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
