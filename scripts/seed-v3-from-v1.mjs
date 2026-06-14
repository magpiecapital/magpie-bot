#!/usr/bin/env node
/**
 * Seed the V3 pool with liquidity by moving SOL from V1.
 *
 * Same hybrid pattern as scripts/move-pool-v2-to-v1.mjs:
 *   1. admin_withdraw any un-accounted drift from V1 (single tx)
 *   2. Regular share-based withdraw for the rest (loop to dodge V1's
 *      u64 overflow on shares * total_deposits)
 *   3. Single V3 deposit (V3 fixed the overflow bug with u128 math,
 *      so the deposit side has no chunking concern)
 *
 * Default seed amount: 25 SOL. Keeps V1's idle vault healthy
 * (currently ~58 wSOL idle, leaves ~33 for memecoin borrows after
 * the seed) and gives V3 enough headroom to start serving RWA
 * borrows. Adjust via --amount-sol.
 *
 * Usage:
 *   railway run --service magpie-bot -- node scripts/seed-v3-from-v1.mjs [--dry-run] [--amount-sol 25] [--chunk-sol 0.1]
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
const idlV1 = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie_lending.json"), "utf8"));
const idlV3 = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie_lending_v3.json"), "utf8"));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false, amountSol: 25, chunkSol: 0.1 };
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

  const PROGRAM_V1 = new PublicKey(process.env.PROGRAM_ID);
  const PROGRAM_V3 = new PublicKey(process.env.PROGRAM_ID_V3);
  const programV1 = new Program(idlV1, provider);
  const programV3 = new Program(idlV3, provider);

  function poolPda(programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("pool"), lender.publicKey.toBuffer()], programId)[0];
  }
  function vaultPda(pool, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("loan-token-vault"), pool.toBuffer()], programId)[0];
  }
  function positionPda(pool, owner, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), owner.toBuffer()], programId)[0];
  }

  const v1Pool = poolPda(PROGRAM_V1);
  const v3Pool = poolPda(PROGRAM_V3);
  const v1Vault = vaultPda(v1Pool, PROGRAM_V1);
  const v3Vault = vaultPda(v3Pool, PROGRAM_V3);
  const v1Pos = positionPda(v1Pool, lender.publicKey, PROGRAM_V1);
  const v3Pos = positionPda(v3Pool, lender.publicKey, PROGRAM_V3);

  // Safety: assert derived V3 pool matches the memory-recorded address
  const STATED_V3 = "6D1QmfDxFw4BRNWaVadzmFt1mVqs8Zw9EwkvT6HnR1Na";
  if (v3Pool.toBase58() !== STATED_V3) {
    console.error(`SAFETY ABORT: derived V3 pool ${v3Pool.toBase58()} != known ${STATED_V3}`);
    process.exit(1);
  }

  // Read V1 pool state for drift computation
  const v1PoolState = await programV1.account.lendingPool.fetch(v1Pool);
  const v1VaultBal = await connection.getTokenAccountBalance(v1Vault);
  const v1VaultLamports = BigInt(v1VaultBal.value.amount);
  const totalDeposits = BigInt(v1PoolState.totalDeposits.toString());
  const totalBorrowed = BigInt(v1PoolState.totalBorrowed.toString());
  const expectedIdle = totalDeposits - totalBorrowed;
  const driftLamports = v1VaultLamports > expectedIdle ? v1VaultLamports - expectedIdle : 0n;

  // V1 lender position
  const v1PosAcc = await connection.getAccountInfo(v1Pos);
  if (!v1PosAcc) {
    console.error("SAFETY ABORT: lender has no V1 position account");
    process.exit(1);
  }
  const lenderShares = v1PosAcc.data.readBigUInt64LE(8 + 32 + 32);

  console.log(`Lender:              ${lender.publicKey.toBase58()}`);
  console.log(`V1 pool:             ${v1Pool.toBase58()}`);
  console.log(`V3 pool:             ${v3Pool.toBase58()}`);
  console.log(`V1 totalDeposits     : ${(Number(totalDeposits) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 totalBorrowed     : ${(Number(totalBorrowed) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 expected idle     : ${(Number(expectedIdle) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 actual vault      : ${(Number(v1VaultLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 drift (un-acct)   : ${(Number(driftLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`V1 lender shares     : ${lenderShares.toString()}`);
  console.log(`Lender SOL balance   : ${((await connection.getBalance(lender.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const usableDrift = driftLamports > amountLamports ? amountLamports : driftLamports;
  const shareWithdrawAmt = amountLamports - usableDrift;
  console.log(``);
  console.log(`Plan:`);
  console.log(`  admin_withdraw ${(Number(usableDrift) / 1e9).toFixed(4)} SOL drift (single tx)`);
  console.log(`  share-withdraw ${(Number(shareWithdrawAmt) / 1e9).toFixed(4)} SOL in ${Math.ceil(Number(shareWithdrawAmt) / Number(chunkLamports))} chunks of ${chunkSol} SOL`);
  console.log(`  V3 deposit ${amountSol} SOL (single tx; V3 has u128 math, no chunking needed)`);

  if (amountLamports > v1VaultLamports) {
    console.error(`SAFETY ABORT: V1 vault has ${(Number(v1VaultLamports) / 1e9).toFixed(4)} SOL — less than requested ${amountSol}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log("\nDRY RUN — no transactions sent.");
    process.exit(0);
  }

  const lenderWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey, false, TOKEN_PROGRAM_ID);

  // ── Step 1: admin_withdraw drift ──
  let withdrawnSoFar = 0n;
  if (usableDrift > 0n) {
    console.log(`\n[Step 1] admin_withdraw ${(Number(usableDrift) / 1e9).toFixed(4)} SOL drift…`);
    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      lender.publicKey, lenderWsolAta, lender.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
    ));
    const ix = await programV1.methods
      .adminWithdraw(new BN(usableDrift.toString()))
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
    withdrawnSoFar += usableDrift;
  } else {
    console.log(`\n[Step 1] No V1 drift — skipping admin_withdraw.`);
  }

  // ── Step 2: share-based withdraw loop ──
  if (withdrawnSoFar < amountLamports) {
    console.log(`\n[Step 2] share-based withdraw loop — ${(Number(amountLamports - withdrawnSoFar) / 1e9).toFixed(4)} SOL in chunks of ${chunkSol} SOL…`);
    let chunkNum = 0;
    while (withdrawnSoFar < amountLamports) {
      const left = amountLamports - withdrawnSoFar;
      const thisChunk = left < chunkLamports ? left : chunkLamports;
      const freshPool = await programV1.account.lendingPool.fetch(v1Pool);
      const td = BigInt(freshPool.totalDeposits.toString());
      const ts = BigInt(freshPool.totalShares.toString());
      if (td === 0n || ts === 0n) {
        console.error(`  Stop: pool deposits or shares hit 0`);
        break;
      }
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
          console.log(`  chunk ${chunkNum}: total=${(Number(withdrawnSoFar) / 1e9).toFixed(4)}/${amountSol} SOL  sig=${sig.slice(0, 16)}…`);
        }
      } catch (err) {
        console.error(`  chunk ${chunkNum} failed: ${err.message?.slice(0, 200)} — retrying next iteration`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // ── Step 3: unwrap + V3 deposit ──
  console.log(`\n[Step 3] Unwrap + V3 deposit ${amountSol} SOL…`);
  const tx2 = new Transaction().add(
    createCloseAccountInstruction(lenderWsolAta, lender.publicKey, lender.publicKey, [], TOKEN_PROGRAM_ID),
  );
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [lender], { commitment: "confirmed" });
  console.log(`  unwrap OK: ${sig2}`);

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
  const v1VaultFinal = await connection.getTokenAccountBalance(v1Vault);
  const v3VaultFinal = await connection.getTokenAccountBalance(v3Vault);
  const v1PoolFinal = await programV1.account.lendingPool.fetch(v1Pool);
  const v3PoolFinal = await programV3.account.lendingPool.fetch(v3Pool);
  console.log("");
  console.log("FINAL STATE");
  console.log(`  Lender SOL          : ${(lenderFinal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`  V1 vault            : ${v1VaultFinal.value.uiAmountString} wSOL`);
  console.log(`  V3 vault            : ${v3VaultFinal.value.uiAmountString} wSOL`);
  console.log(`  V1 totalDeposits    : ${(Number(v1PoolFinal.totalDeposits) / 1e9).toFixed(4)} SOL`);
  console.log(`  V3 totalDeposits    : ${(Number(v3PoolFinal.totalDeposits) / 1e9).toFixed(4)} SOL`);

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
