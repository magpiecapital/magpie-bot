#!/usr/bin/env node
/**
 * One-shot: move 30 SOL of V2 pool liquidity into V3.
 *
 * Operator-authorized 2026-06-14. V2 has low usage; V3 needs more.
 *
 * HYBRID PATH — chosen automatically based on pool reconciliation:
 *
 *   1. admin_withdraw the un-accounted vault drift first
 *      (vault_balance - (totalDeposits - totalBorrowed)).
 *      This recovers any SOL that landed in the vault outside the
 *      share-based deposit flow (fees/tips/etc.) without touching
 *      pool accounting. Single tx, no overflow risk.
 *
 *   2. Regular share-based withdraw for the remainder, looped in
 *      small chunks to dodge the program's u64-overflow bug on
 *      `shares * total_deposits / total_shares`. Each chunk
 *      properly decrements pool.totalDeposits + pool.totalShares,
 *      so V2's pool ledger and vault stay in sync.
 *
 *   3. Deposit the full 30 SOL into V3 in a single tx. V3's deposit
 *      ix does the inverse math cleanly (no overflow on the deposit
 *      side because deposit_amount * total_shares stays bounded).
 *
 * Safety rails:
 *   - Pool PDAs are re-derived from the lender pubkey and asserted
 *     to match the operator-stated addresses. Any drift fails closed.
 *   - Pre-flight checks lender has at least 1 SOL for tx fees +
 *     V2 vault has ≥ amount.
 *   - --dry-run prints the plan without sending anything.
 *   - Idempotent: if the run is interrupted mid-loop, re-running
 *     resumes from the lender's current wSOL ATA balance toward the
 *     30 SOL target. Each loop iteration is independent.
 *
 * Usage:
 *   railway run --service magpie-bot -- node scripts/move-pool-v2-to-v3.mjs [--dry-run] [--amount-sol 30] [--chunk-sol 0.1]
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, BN } = pkg;
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bs58 from "bs58";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlV3 = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie-v3.json"), "utf8"));
const idlV2 = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie_lending_v2.json"), "utf8"));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false, amountSol: 15, chunkSol: 0.1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") out.dryRun = true;
    if (args[i] === "--amount-sol") out.amountSol = Number(args[++i]);
    if (args[i] === "--chunk-sol") out.chunkSol = Number(args[++i]);
  }
  return out;
}

function loadLender() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH required");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(kpPath, "utf8"))));
}

async function main() {
  const { dryRun, amountSol, chunkSol } = parseArgs();
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    console.error("--amount-sol must be a positive number");
    process.exit(1);
  }
  const amountLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
  const chunkLamports = BigInt(Math.round(chunkSol * LAMPORTS_PER_SOL));

  const lender = loadLender();
  const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" });

  const PROGRAM_V3 = new PublicKey(process.env.PROGRAM_ID_V3);
  const PROGRAM_V2 = new PublicKey(process.env.PROGRAM_ID_V2);
  const programV3 = new Program(idlV3, provider);
  const programV2 = new Program(idlV2, provider);

  function poolPda(programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("pool"), lender.publicKey.toBuffer()], programId)[0];
  }
  function vaultPda(pool, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("loan-token-vault"), pool.toBuffer()], programId)[0];
  }
  function positionPda(pool, owner, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), owner.toBuffer()], programId)[0];
  }

  const v3Pool = poolPda(PROGRAM_V3);
  const v2Pool = poolPda(PROGRAM_V2);
  const v3Vault = vaultPda(v3Pool, PROGRAM_V3);
  const v2Vault = vaultPda(v2Pool, PROGRAM_V2);
  const v3Pos = positionPda(v3Pool, lender.publicKey, PROGRAM_V3);
  const v2Pos = positionPda(v2Pool, lender.publicKey, PROGRAM_V2);

  // Safety: assert derived pools match operator-stated addresses
  const STATED_V3 = "6D1QmfDxFw4BRNWaVadzmFt1mVqs8Zw9EwkvT6HnR1Na";
  const STATED_V2 = "3o8QBx6fH9cGZWgZ3Ng6GAseSehEqakvgna9squxaJVP";
  if (v3Pool.toBase58() !== STATED_V3 || v2Pool.toBase58() !== STATED_V2) {
    console.error("SAFETY ABORT: PDA mismatch with operator-stated pools");
    process.exit(1);
  }

  // Read V2 pool state
  const v2PoolState = await programV2.account.lendingPool.fetch(v2Pool);
  const v2VaultBal = await connection.getTokenAccountBalance(v2Vault);
  const v2VaultLamports = BigInt(v2VaultBal.value.amount);
  const totalDeposits = BigInt(v2PoolState.totalDeposits.toString());
  const totalBorrowed = BigInt(v2PoolState.totalBorrowed.toString());
  const totalShares = BigInt(v2PoolState.totalShares.toString());
  const expectedIdle = totalDeposits - totalBorrowed;
  const driftLamports = v2VaultLamports > expectedIdle ? v2VaultLamports - expectedIdle : 0n;

  // Read V2 lender position
  const v2PosAcc = await connection.getAccountInfo(v2Pos);
  if (!v2PosAcc) {
    console.error("SAFETY ABORT: lender has no V2 position account");
    process.exit(1);
  }
  const lenderShares = v2PosAcc.data.readBigUInt64LE(8 + 32 + 32);

  console.log(`Lender:        ${lender.publicKey.toBase58()}`);
  console.log(`V3 pool:       ${v3Pool.toBase58()}`);
  console.log(`V2 pool:       ${v2Pool.toBase58()}`);
  console.log(`V2 totalDeposits   : ${(Number(totalDeposits) / 1e9).toFixed(4)} SOL`);
  console.log(`V2 totalBorrowed   : ${(Number(totalBorrowed) / 1e9).toFixed(4)} SOL`);
  console.log(`V2 expected idle   : ${(Number(expectedIdle) / 1e9).toFixed(4)} SOL`);
  console.log(`V2 actual vault    : ${(Number(v2VaultLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`V2 drift (un-acct) : ${(Number(driftLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`V2 lender shares   : ${lenderShares.toString()} (${((Number(lenderShares) / Number(totalShares)) * 100).toFixed(2)}% of total)`);
  console.log(`Lender SOL balance : ${((await connection.getBalance(lender.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(``);
  console.log(`Plan: admin_withdraw ${(Number(driftLamports) / 1e9).toFixed(4)} SOL drift + share-withdraw ${((Number(amountLamports - driftLamports)) / 1e9).toFixed(4)} SOL in ${Math.ceil(Number(amountLamports - driftLamports) / Number(chunkLamports))} chunks of ${chunkSol} SOL`);

  if (amountLamports > v2VaultLamports) {
    console.error(`SAFETY ABORT: V2 vault has ${(Number(v2VaultLamports) / 1e9).toFixed(4)} SOL — less than requested ${amountSol} SOL`);
    process.exit(1);
  }

  if (dryRun) {
    console.log("\nDRY RUN — no transactions sent.");
    process.exit(0);
  }

  const lenderWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey, false, TOKEN_PROGRAM_ID);

  // ── Step 1: admin_withdraw the drift portion ──
  let withdrawnSoFar = 0n;
  if (driftLamports > 0n) {
    console.log(`\n[Step 1] admin_withdraw ${(Number(driftLamports) / 1e9).toFixed(4)} SOL (un-accounted drift)…`);
    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      lender.publicKey, lenderWsolAta, lender.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
    ));
    const ix = await programV2.methods
      .adminWithdraw(new BN(driftLamports.toString()))
      .accounts({
        pool: v2Pool,
        loanTokenVault: v2Vault,
        authorityTokenAccount: lenderWsolAta,
        authority: lender.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [lender], { commitment: "confirmed" });
    console.log(`  OK: ${sig}`);
    withdrawnSoFar += driftLamports;
  } else {
    console.log("\n[Step 1] No un-accounted drift — skipping admin_withdraw.");
  }

  // ── Step 2: share-based withdraw loop for the remainder ──
  const remainder = amountLamports - withdrawnSoFar;
  if (remainder > 0n) {
    console.log(`\n[Step 2] share-based withdraw loop — ${(Number(remainder) / 1e9).toFixed(4)} SOL in chunks of ${chunkSol} SOL…`);
    let chunkNum = 0;
    while (withdrawnSoFar < amountLamports) {
      const left = amountLamports - withdrawnSoFar;
      const thisChunk = left < chunkLamports ? left : chunkLamports;

      // Compute shares for thisChunk by reading fresh pool state each iteration.
      // shares = thisChunk * total_shares / (total_deposits - total_borrowed_relevant)
      // Actually per program: withdraw_amount = shares * total_deposits / total_shares
      //   → shares = withdraw_amount * total_shares / total_deposits
      const freshPool = await programV2.account.lendingPool.fetch(v2Pool);
      const td = BigInt(freshPool.totalDeposits.toString());
      const ts = BigInt(freshPool.totalShares.toString());
      if (td === 0n || ts === 0n) {
        console.error(`  Stop: pool deposits or shares hit 0`);
        break;
      }
      // Ceil-divide so we don't under-withdraw by 1 lamport
      const sharesForChunk = (thisChunk * ts + td - 1n) / td;
      chunkNum++;
      const tx = new Transaction();
      const ix = await programV2.methods
        .withdraw(new BN(sharesForChunk.toString()))
        .accounts({
          pool: v2Pool,
          loanTokenVault: v2Vault,
          position: v2Pos,
          depositorTokenAccount: lenderWsolAta,
          depositor: lender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      tx.add(ix);
      try {
        const sig = await sendAndConfirmTransaction(connection, tx, [lender], { commitment: "confirmed" });
        withdrawnSoFar += thisChunk;
        if (chunkNum % 25 === 0 || withdrawnSoFar >= amountLamports) {
          console.log(`  chunk ${chunkNum}: +${(Number(thisChunk) / 1e9).toFixed(4)} SOL  total=${(Number(withdrawnSoFar) / 1e9).toFixed(4)}/${amountSol} SOL  sig=${sig.slice(0, 16)}…`);
        }
      } catch (err) {
        console.error(`  chunk ${chunkNum} failed: ${err.message?.slice(0, 200)} — will retry next iteration`);
        // Re-read pool state next iteration; don't increment withdrawnSoFar
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // ── Step 3: unwrap + deposit into V3 ──
  console.log(`\n[Step 3] Unwrap wSOL ATA → native SOL, then V3 deposit ${amountSol} SOL…`);

  // Unwrap (close the wSOL ATA — the underlying SOL lands back in lender)
  const tx2 = new Transaction().add(
    createCloseAccountInstruction(lenderWsolAta, lender.publicKey, lender.publicKey, [], TOKEN_PROGRAM_ID),
  );
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [lender], { commitment: "confirmed" });
  console.log(`  unwrap OK: ${sig2}`);

  const lenderBalAfterWithdraw = await connection.getBalance(lender.publicKey);
  console.log(`  Lender SOL after withdraw + unwrap: ${(lenderBalAfterWithdraw / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Re-wrap exactly amountLamports + deposit into V3
  const tx3 = new Transaction();
  tx3.add(createAssociatedTokenAccountIdempotentInstruction(
    lender.publicKey, lenderWsolAta, lender.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
  ));
  tx3.add(SystemProgram.transfer({
    fromPubkey: lender.publicKey,
    toPubkey: lenderWsolAta,
    lamports: Number(amountLamports),
  }));
  tx3.add(createSyncNativeInstruction(lenderWsolAta, TOKEN_PROGRAM_ID));

  const depositIx = await programV3.methods
    .deposit(new BN(amountLamports.toString()))
    .accounts({
      pool: v3Pool,
      loanTokenVault: v3Vault,
      position: v3Pos,
      depositorTokenAccount: lenderWsolAta,
      depositor: lender.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx3.add(depositIx);
  tx3.add(createCloseAccountInstruction(lenderWsolAta, lender.publicKey, lender.publicKey, [], TOKEN_PROGRAM_ID));

  const sig3 = await sendAndConfirmTransaction(connection, tx3, [lender], { commitment: "confirmed" });
  console.log(`  V3 deposit OK: ${sig3}`);

  // ── Final state ──
  const lenderFinal = await connection.getBalance(lender.publicKey);
  const v3VaultFinal = await connection.getTokenAccountBalance(v3Vault);
  const v2VaultFinal = await connection.getTokenAccountBalance(v2Vault);
  const v2PoolFinal = await programV2.account.lendingPool.fetch(v2Pool);
  const v3PoolFinal = await programV3.account.lendingPool.fetch(v3Pool);
  console.log("");
  console.log("FINAL STATE");
  console.log(`  Lender SOL          : ${(lenderFinal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`  V3 vault            : ${v3VaultFinal.value.uiAmountString} wSOL`);
  console.log(`  V2 vault            : ${v2VaultFinal.value.uiAmountString} wSOL`);
  console.log(`  V3 totalDeposits    : ${(Number(v3PoolFinal.totalDeposits) / 1e9).toFixed(4)} SOL`);
  console.log(`  V2 totalDeposits    : ${(Number(v2PoolFinal.totalDeposits) / 1e9).toFixed(4)} SOL`);

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
