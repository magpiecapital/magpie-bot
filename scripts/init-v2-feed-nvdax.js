#!/usr/bin/env node
/**
 * One-off: initialize the v2 price feed PDA for NVDAx on mainnet.
 *
 * This is a final pre-launch validation. The earlier empirical test ran on
 * a local validator with NVDAx cloned in; this confirms the same code path
 * works against the real mainnet NVDAx mint with all its extensions live.
 *
 * Safe: just creates a price-feed PDA on v2. Doesn't enable the mint for
 * users, doesn't affect any v1 loans, doesn't move user funds. If it
 * succeeds, we have empirical mainnet evidence v2's anchor-spl 0.31 fixes
 * the Token-2022-with-extensions deserialization issue.
 *
 * Idempotent — re-running is a no-op if the feed already exists.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet } = anchor;

const V2_PROGRAM_ID = new PublicKey("4EcnHCEgMTfaXrLwn4sv7a9BPHQekKANzQEr7bA2rUzW");
const NVDAX_MINT = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
const LENDER_KP_PATH = process.env.LENDER_KEYPAIR_PATH ?? "./lender-keypair-v2.json";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC, "confirmed");
const lender = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(LENDER_KP_PATH, "utf8"))),
);
const idl = JSON.parse(readFileSync("./src/solana/idl/magpie_lending_v2.json", "utf8"));
const provider = new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" });
const program = new Program(idl, provider);

const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lender.publicKey.toBuffer()],
  V2_PROGRAM_ID,
);
const [priceFeedPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("price"), NVDAX_MINT.toBuffer(), poolPda.toBuffer()],
  V2_PROGRAM_ID,
);

console.log(`v2 pool:       ${poolPda.toBase58()}`);
console.log(`v2 price feed: ${priceFeedPda.toBase58()}`);

const existing = await connection.getAccountInfo(priceFeedPda);
if (existing) {
  console.log(`\n✓ v2 NVDAx price feed already exists (${existing.data.length}b). No-op.`);
  process.exit(0);
}

console.log(`\nInitializing v2 price feed for NVDAx on MAINNET...`);
console.log(`(If this fails with InvalidAccountData, v2 has the same bug as v1 — abort.)`);
try {
  const sig = await program.methods
    .initializePriceFeed()
    .accounts({
      pool: poolPda,
      mint: NVDAX_MINT,
      priceFeed: priceFeedPda,
      authority: lender.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ])
    .rpc({ commitment: "confirmed" });
  console.log(`\n✓✓✓ MAINNET PRICE FEED INITIALIZED for NVDAx via v2`);
  console.log(`  tx: ${sig}`);
  console.log(`  Empirically confirms v2 fixes the Token-2022 extension issue on mainnet.`);
} catch (e) {
  console.error(`\n✗ Failed: ${e.message}`);
  if (e.logs) {
    console.error("Logs:");
    for (const l of e.logs.slice(-10)) console.error("  " + l);
  }
  process.exit(1);
}
