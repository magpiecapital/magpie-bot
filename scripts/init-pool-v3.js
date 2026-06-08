#!/usr/bin/env node
/**
 * Initialize the v3 lending pool on mainnet.
 *
 * v3 is the TWAP-protected parallel program. It has its own pool PDAs
 * (derived from its program ID), separate from v1 and v2. v1 + v2 are
 * untouched by this script. Same fee parameters as v1/v2 for economic
 * consistency.
 *
 * Prereqs:
 *   1. v3 anchor build done: target/deploy/magpie_lending_v3.so exists
 *   2. v3 program deployed to mainnet (`anchor deploy --provider.cluster mainnet`)
 *   3. PROGRAM_ID_V3 env var set, OR pass it via cmdline:
 *        node scripts/init-pool-v3.js <PROGRAM_ID_V3>
 *   4. src/solana/idl/magpie_lending_v3.json exists (anchor build produces it)
 *
 * Same authority as v1/v2 (single-lender-wallet model). Idempotent — re-running
 * after a successful init is a no-op.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet } = anchor;

const V3_PROGRAM_ID_STR = process.argv[2] || process.env.PROGRAM_ID_V3;
if (!V3_PROGRAM_ID_STR) {
  console.error("Usage: node scripts/init-pool-v3.js <PROGRAM_ID_V3>");
  console.error("       OR set PROGRAM_ID_V3 env var");
  process.exit(1);
}
const V3_PROGRAM_ID = new PublicKey(V3_PROGRAM_ID_STR);

const IDL_PATH = "./src/solana/idl/magpie_lending_v3.json";
if (!existsSync(IDL_PATH)) {
  console.error(`Missing ${IDL_PATH} — run 'anchor build' in programs/magpie-lending-v3 first and copy the IDL.`);
  process.exit(1);
}

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

function loadLender() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const path = process.env.LENDER_KEYPAIR_PATH || "./lender-keypair.json";
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

const lender = loadLender();
console.log(`Lender:     ${lender.publicKey.toBase58()}`);
console.log(`RPC:        ${RPC}`);
console.log(`v3 program: ${V3_PROGRAM_ID.toBase58()}`);

const connection = new Connection(RPC, "confirmed");
const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
const provider = new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lender.publicKey.toBuffer()],
  V3_PROGRAM_ID,
);
const [loanTokenVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), poolPda.toBuffer()],
  V3_PROGRAM_ID,
);

console.log(`\nv3 pool PDA:             ${poolPda.toBase58()}`);
console.log(`v3 loan token vault PDA: ${loanTokenVaultPda.toBase58()}`);

const existing = await connection.getAccountInfo(poolPda);
if (existing) {
  console.log(`\n✓ v3 pool already initialized (size ${existing.data.length}b). Nothing to do.`);
  process.exit(0);
}

const protocolFeeBps = 2000; // 20% — matches v1/v2
const keeperRewardBps = 500; // 5%  — matches v1/v2
console.log(`\nInitializing v3 pool with protocol_fee=${protocolFeeBps}bps, keeper_reward=${keeperRewardBps}bps...`);

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

  console.log(`\n✓✓✓ v3 pool initialized`);
  console.log(`  tx: ${sig}`);
  console.log(`  pool: ${poolPda.toBase58()}`);
  console.log(`  loan_token_vault: ${loanTokenVaultPda.toBase58()}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Set PROGRAM_ID_V3=${V3_PROGRAM_ID.toBase58()} on Railway`);
  console.log(`  2. Restart the bot — the price-attestor will start writing TWAP samples`);
  console.log(`  3. Wait ~30 min for buffers to warm (min 8 samples + 5 min history per mint)`);
  console.log(`  4. Set ROUTE_MEMECOINS_TO_V3=true on Railway → new memecoin borrows route to v3`);
} catch (e) {
  console.error(`\n✗ Pool init failed: ${e.message}`);
  if (e.logs) {
    console.error("Logs (last 10):");
    for (const l of e.logs.slice(-10)) console.error("  " + l);
  }
  process.exit(1);
}
