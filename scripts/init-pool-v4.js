#!/usr/bin/env node
/**
 * Initialize the v4 lending pool on the target cluster.
 *
 * v4 is the in-vault-auto-sell parallel program. Same pool PDA seeds
 * as v1/v2/v3 (`b"pool" + authority`) but derived under the v4 program
 * ID, so it gets its own pool account. v1/v2/v3 are untouched.
 *
 * Same protocol-fee + keeper-reward parameters as v1/v2/v3 for economic
 * consistency. Idempotent — re-running after a successful init logs
 * the existing pool and exits.
 *
 * Usage:
 *   node scripts/init-pool-v4.js <PROGRAM_ID_V4>     # explicit
 *   PROGRAM_ID_V4=<...> node scripts/init-pool-v4.js # env-driven
 *
 * Environment:
 *   SOLANA_RPC_URL          target cluster (default: mainnet-beta)
 *   LENDER_KEYPAIR_PATH     path to authority keypair (default ./lender-keypair.json)
 *   LENDER_PRIVATE_KEY      bs58 private key (overrides LENDER_KEYPAIR_PATH)
 *
 * For devnet smoke test:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   LENDER_KEYPAIR_PATH=~/.config/solana/backups/magpie-devnet-deployer-20260605.json \
 *   PROGRAM_ID_V4=BGBj6eiY6UszMmmwJiC6tVH13pnfbqxijstHDQgbxJNi \
 *   node scripts/init-pool-v4.js
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

const V4_PROGRAM_ID_STR = process.argv[2] || process.env.PROGRAM_ID_V4;
if (!V4_PROGRAM_ID_STR) {
  console.error("Usage: node scripts/init-pool-v4.js <PROGRAM_ID_V4>");
  console.error("       OR set PROGRAM_ID_V4 env var");
  process.exit(1);
}
const V4_PROGRAM_ID = new PublicKey(V4_PROGRAM_ID_STR);

const IDL_PATH = "./src/solana/idl/magpie-v4.json";
if (!existsSync(IDL_PATH)) {
  console.error(`Missing ${IDL_PATH} — generate it from the v4 anchor build first.`);
  process.exit(1);
}

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

function loadLender() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const rawPath = process.env.LENDER_KEYPAIR_PATH || "./lender-keypair.json";
  const path = rawPath.startsWith("~/")
    ? rawPath.replace(/^~/, process.env.HOME ?? "")
    : rawPath;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

const lender = loadLender();
console.log(`Lender:     ${lender.publicKey.toBase58()}`);
console.log(`RPC:        ${RPC}`);
console.log(`v4 program: ${V4_PROGRAM_ID.toBase58()}`);

const connection = new Connection(RPC, "confirmed");
const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
// Anchor 0.30+ Program constructor reads address from idl.address; we
// also pin it explicitly so a stale/placeholder address in the IDL can't
// cause a silent wrong-program dispatch.
idl.address = V4_PROGRAM_ID.toBase58();
const provider = new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lender.publicKey.toBuffer()],
  V4_PROGRAM_ID,
);
const [loanTokenVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), poolPda.toBuffer()],
  V4_PROGRAM_ID,
);

console.log(`\nv4 pool PDA:             ${poolPda.toBase58()}`);
console.log(`v4 loan token vault PDA: ${loanTokenVaultPda.toBase58()}`);

const existing = await connection.getAccountInfo(poolPda);
if (existing) {
  console.log(`\nv4 pool already initialized (size ${existing.data.length}b). Nothing to do.`);
  process.exit(0);
}

const protocolFeeBps = 2000; // 20% — matches v1/v2/v3
const keeperRewardBps = 500; // 5%  — matches v1/v2/v3
console.log(`\nInitializing v4 pool with protocol_fee=${protocolFeeBps}bps, keeper_reward=${keeperRewardBps}bps...`);

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

  console.log(`\nv4 pool initialized`);
  console.log(`  tx: ${sig}`);
  console.log(`  pool: ${poolPda.toBase58()}`);
  console.log(`  loan_token_vault: ${loanTokenVaultPda.toBase58()}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Set PROGRAM_ID_V4=${V4_PROGRAM_ID.toBase58()} on Railway`);
  console.log(`  2. Set ENGINE_AUTHORITY_V4 in engine env (must match on-chain ENGINE_AUTHORITY)`);
  console.log(`  3. Restart the bot — preflight registers v4`);
  console.log(`  4. Fund the pool: run scripts/move-pool-v2-to-v4.mjs once you're ready`);
  console.log(`  5. Flip ROUTE_MEMECOINS_TO_V4=true and ROUTE_RWA_TO_V4=true after operator canary`);
} catch (e) {
  console.error(`\nPool init failed: ${e.message}`);
  if (e.logs) {
    console.error("Logs (last 10):");
    for (const l of e.logs.slice(-10)) console.error("  " + l);
  }
  process.exit(1);
}
