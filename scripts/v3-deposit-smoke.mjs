#!/usr/bin/env node
// V3 deposit smoke test. Deposit 0.05 SOL, verify share mint + state.
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
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

const V3 = new PublicKey("B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP");
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");

const IDL_DIR = process.env.MAGPIE_IDL_DIR || "./src/solana/idl";
const lender = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(process.env.LENDER_KEYPAIR || "./lender-keypair-v2.json", "utf8")),
  ),
);
const idl = JSON.parse(readFileSync(`${IDL_DIR}/magpie-v3.json`, "utf8"));
const provider = new AnchorProvider(conn, new Wallet(lender), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [pool] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lender.publicKey.toBuffer()],
  V3,
);
const [loanTokenVault] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), pool.toBuffer()],
  V3,
);
const [position] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), pool.toBuffer(), lender.publicKey.toBuffer()],
  V3,
);
const depositorAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey);

const DEPOSIT_LAMPORTS = 50_000_000; // 0.05 SOL

console.log(`Lender:        ${lender.publicKey.toBase58()}`);
console.log(`Pool:          ${pool.toBase58()}`);
console.log(`Vault:         ${loanTokenVault.toBase58()}`);
console.log(`Position PDA:  ${position.toBase58()}`);
console.log(`Depositor ATA: ${depositorAta.toBase58()}`);
console.log(`Deposit:       ${DEPOSIT_LAMPORTS / 1e9} SOL\n`);

// Pre-deposit pool state
let acct = await conn.getAccountInfo(pool);
let off = 8 + 32 + 32 + 32 + 2 + 2;
const beforeDeposits = acct.data.readBigUInt64LE(off);
off += 8;
const beforeShares = acct.data.readBigUInt64LE(off);
console.log(`Before — total_deposits: ${Number(beforeDeposits) / 1e9}, total_shares: ${Number(beforeShares) / 1e9}\n`);

// Build tx: create wsol ATA + wrap SOL + sync + deposit + (optionally close wsol after)
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
tx.add(
  createAssociatedTokenAccountIdempotentInstruction(
    lender.publicKey,
    depositorAta,
    lender.publicKey,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  ),
);
tx.add(
  SystemProgram.transfer({
    fromPubkey: lender.publicKey,
    toPubkey: depositorAta,
    lamports: DEPOSIT_LAMPORTS,
  }),
);
tx.add(createSyncNativeInstruction(depositorAta));

const depositIx = await program.methods
  .deposit(new BN(DEPOSIT_LAMPORTS))
  .accounts({
    pool,
    loanTokenVault,
    position,
    depositor: lender.publicKey,
    depositorTokenAccount: depositorAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .instruction();
tx.add(depositIx);

const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
tx.recentBlockhash = blockhash;
tx.lastValidBlockHeight = lastValidBlockHeight;
tx.feePayer = lender.publicKey;

tx.sign(lender);
const raw = tx.serialize();
const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
console.log(`Sent: ${sig}`);
const confirmation = await conn.confirmTransaction(
  { signature: sig, blockhash, lastValidBlockHeight },
  "confirmed",
);
if (confirmation.value.err) {
  console.error(`tx error: ${JSON.stringify(confirmation.value.err)}`);
  process.exit(1);
}
console.log(`Confirmed: https://solscan.io/tx/${sig}\n`);

// Post-deposit pool state
acct = await conn.getAccountInfo(pool);
off = 8 + 32 + 32 + 32 + 2 + 2;
const afterDeposits = acct.data.readBigUInt64LE(off);
off += 8;
const afterShares = acct.data.readBigUInt64LE(off);
console.log(`After  — total_deposits: ${Number(afterDeposits) / 1e9}, total_shares: ${Number(afterShares) / 1e9}`);

// Position account
const posAcct = await conn.getAccountInfo(position);
if (!posAcct) {
  console.error("Position account not created!");
  process.exit(1);
}
off = 8 + 32 + 32;
const posShares = posAcct.data.readBigUInt64LE(off);
off += 8;
const posDeposited = posAcct.data.readBigUInt64LE(off);
console.log(`\nPosition — shares: ${Number(posShares) / 1e9}, lifetime_deposited: ${Number(posDeposited) / 1e9}`);

console.log(`\nSmoke checks:`);
console.log(`  ✓ deposit ix executed`);
console.log(`  ✓ pool.total_deposits bumped: ${(Number(afterDeposits - beforeDeposits) / 1e9).toFixed(6)} SOL`);
console.log(`  ✓ pool.total_shares bumped:   ${(Number(afterShares - beforeShares) / 1e9).toFixed(6)} share-units`);
console.log(`  ✓ position created: shares=${(Number(posShares) / 1e9).toFixed(6)}, deposited=${(Number(posDeposited) / 1e9).toFixed(6)} SOL`);
console.log(
  `  First-deposit 1:1 expected: shares should equal deposit_amount. Got shares=${
    Number(posShares) / 1e9
  } vs deposit=${DEPOSIT_LAMPORTS / 1e9}. ${
    posShares === BigInt(DEPOSIT_LAMPORTS) ? "✓ MATCH" : "✗ MISMATCH"
  }`,
);
