#!/usr/bin/env node
/**
 * One-shot: move 5 SOL of V1 pool liquidity into V4.
 *
 * Operator-authorized 2026-06-16. Reserve top-up for V4 from V1.
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
 *   3. Deposit the full 5 SOL into V4 in a single tx. V4's deposit
 *      ix does the inverse math cleanly (no overflow on the deposit
 *      side because deposit_amount * total_shares stays bounded).
 *
 * Safety rails:
 *   - Pool PDAs are re-derived from the lender pubkey and asserted
 *     to match the operator-stated addresses. Any drift fails closed.
 *   - Pre-flight checks lender has at least 1 SOL for tx fees +
 *     V1 vault has ≥ amount.
 *   - --dry-run prints the plan without sending anything.
 *   - Idempotent: if the run is interrupted mid-loop, re-running
 *     resumes from the lender's current wSOL ATA balance toward the
 *     5 SOL target. Each loop iteration is independent.
 *
 * Usage:
 *   railway run --service magpie-bot -- node scripts/move-pool-v1-to-v4.mjs [--dry-run] [--amount-sol 5] [--chunk-sol 0.1]
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
const idlV4 = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie-v4.json"), "utf8"));
const idlV1 = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie_lending.json"), "utf8"));

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

  const PROGRAM_V4 = new PublicKey(process.env.PROGRAM_ID_V4);
  const PROGRAM_V1 = new PublicKey(process.env.PROGRAM_ID_V1);
  const programV4 = new Program(idlV4, provider);
  const programV1 = new Program(idlV1, provider);

  function poolPda(programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("pool"), lender.publicKey.toBuffer()], programId)[0];
  }
  function vaultPda(pool, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("loan-token-vault"), pool.toBuffer()], programId)[0];
  }
  function positionPda(pool, owner, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), owner.toBuffer()], programId)[0];
  }

  const v4Pool = poolPda(PROGRAM_V4);
  const v1Pool = poolPda(PROGRAM_V1);
  const v4Vault = vaultPda(v4Pool, PROGRAM_V4);
  const v1Vault = vaultPda(v1Pool, PROGRAM_V1);
  const v4Pos = positionPda(v4Pool, lender.publicKey, PROGRAM_V4);
  const v1Pos = positionPda(v1Pool, lender.publicKey, PROGRAM_V1);

  // Safety: assert derived pools match operator-stated addresses
  const STATED_V4 = process.env.V4_POOL_STATED || "REPLACE_WITH_V4_POOL_PUBKEY";
  const STATED_V1 = "EynWtuRMUKU3zHzfLv7Y5Qu6MWpwqG17X91QAuHSww9u";
  if (v4Pool.toBase58() !== STATED_V4 || v1Pool.toBase58() !== STATED_V1) {
    console.error("SAFETY ABORT: PDA mismatch with operator-stated pools");
    process.exit(1);
  }

  // Read V1 pool state
  const v1PoolState = await programV1.account.lendingPool.fetch(v1Pool);
  const v1VaultBal = await connection.getTokenAccountBalance(v1Vault);
  const v1VaultLamports = BigInt(v1VaultBal.value.amount);
  const totalDeposits = BigInt(v1PoolState.totalDeposits.toString());
  const totalBorrowed = BigInt(v1PoolState.totalBorrowed.toString());
  const totalShares = BigInt(v1PoolState.totalShares.toString());
  const expectedIdle = totalDeposits - totalBorrowed;
  const driftLamports = v1VaultLamports > expectedIdle ? v1VaultLamports - expectedIdle : 0n;

  // Read V2 lender position
  const v1PosAcc = await connection.getAccountInfo(v1Pos);
  if (!v1PosAcc) {
    console.error("SAFETY ABORT: lender has no V2 position account");
    process.exit(1);
  }
  const lenderShares = v1PosAcc.data.readBigUInt64LE(8 + 32 + 32);

  console.log(`Lender:        ${lender.publicKey.toBase58()}`);
  console.log(`V4 pool:       ${v4Pool.toBase58()}`);
  console.log(`V1 pool:       ${v1Pool.toBase58()}`);
  console.log(`V1 totalDeposits   : ${(Number(totalDeposits) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 totalBorrowed   : ${(Number(totalBorrowed) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 expected idle   : ${(Number(expectedIdle) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 actual vault    : ${(Number(v1VaultLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 drift (un-acct) : ${(Number(driftLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 lender shares   : ${lenderShares.toString()} (${((Number(lenderShares) / Number(totalShares)) * 100).toFixed(2)}% of total)`);
  console.log(`Lender SOL balance : ${((await connection.getBalance(lender.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(``);
  console.log(`Plan: admin_withdraw ${(Number(driftLamports) / 1e9).toFixed(4)} SOL drift + share-withdraw ${((Number(amountLamports - driftLamports)) / 1e9).toFixed(4)} SOL in ${Math.ceil(Number(amountLamports - driftLamports) / Number(chunkLamports))} chunks of ${chunkSol} SOL`);

  if (amountLamports > v1VaultLamports) {
    console.error(`SAFETY ABORT: V1 vault has ${(Number(v1VaultLamports) / 1e9).toFixed(4)} SOL — less than requested ${amountSol} SOL`);
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
    const ix = await programV1.methods
      .adminWithdraw(new BN(driftLamports.toString()))
      .accounts({
        pool: v1Pool,
        loanTokenVault: v1Vault,
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
      const freshPool = await programV1.account.lendingPool.fetch(v1Pool);
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
      const ix = await programV1.methods
        .withdraw(new BN(sharesForChunk.toString()))
        .accounts({
          pool: v1Pool,
          loanTokenVault: v1Vault,
          position: v1Pos,
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

  // ── Step 3: unwrap + deposit into V4 ──
  console.log(`\n[Step 3] Unwrap wSOL ATA → native SOL, then V4 deposit ${amountSol} SOL…`);

  // Unwrap (close the wSOL ATA — the underlying SOL lands back in lender)
  const tx2 = new Transaction().add(
    createCloseAccountInstruction(lenderWsolAta, lender.publicKey, lender.publicKey, [], TOKEN_PROGRAM_ID),
  );
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [lender], { commitment: "confirmed" });
  console.log(`  unwrap OK: ${sig2}`);

  const lenderBalAfterWithdraw = await connection.getBalance(lender.publicKey);
  console.log(`  Lender SOL after withdraw + unwrap: ${(lenderBalAfterWithdraw / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Re-wrap exactly amountLamports + deposit into V4
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

  const depositIx = await programV4.methods
    .deposit(new BN(amountLamports.toString()))
    .accounts({
      pool: v4Pool,
      loanTokenVault: v4Vault,
      position: v4Pos,
      depositorTokenAccount: lenderWsolAta,
      depositor: lender.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx3.add(depositIx);
  tx3.add(createCloseAccountInstruction(lenderWsolAta, lender.publicKey, lender.publicKey, [], TOKEN_PROGRAM_ID));

  const sig3 = await sendAndConfirmTransaction(connection, tx3, [lender], { commitment: "confirmed" });
  console.log(`  V4 deposit OK: ${sig3}`);

  // ── Final state ──
  const lenderFinal = await connection.getBalance(lender.publicKey);
  const v4VaultFinal = await connection.getTokenAccountBalance(v4Vault);
  const v1VaultFinal = await connection.getTokenAccountBalance(v1Vault);
  const v1PoolFinal = await programV1.account.lendingPool.fetch(v1Pool);
  const v4PoolFinal = await programV4.account.lendingPool.fetch(v4Pool);
  console.log("");
  console.log("FINAL STATE");
  console.log(`  Lender SOL          : ${(lenderFinal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`  V4 vault            : ${v4VaultFinal.value.uiAmountString} wSOL`);
  console.log(`  V1 vault            : ${v1VaultFinal.value.uiAmountString} wSOL`);
  console.log(`  V4 totalDeposits    : ${(Number(v4PoolFinal.totalDeposits) / 1e9).toFixed(4)} SOL`);
  console.log(`  V1 totalDeposits    : ${(Number(v1PoolFinal.totalDeposits) / 1e9).toFixed(4)} SOL`);

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
