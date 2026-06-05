#!/usr/bin/env node
/**
 * Empirical validation of v2 against a cloned NVDAx mint on a local validator.
 *
 * Proves the actual fix: v2's newer anchor-spl can deserialize an NVDAx mint
 * (Token-2022 with PausableConfig + ScaledUiAmountConfig extensions) where
 * v1 errors with InvalidAccountData.
 *
 * Setup expected before running:
 *   1. Local validator running at http://localhost:8899
 *   2. NVDAx mint cloned from mainnet (use --clone flag at validator start)
 *   3. v2 program deployed to local at PROGRAM_ID_V2
 *   4. Deployer wallet (~/.config/solana/magpie-devnet-deployer.json) funded
 *
 * What this test does:
 *   1. Reads the cloned NVDAx mint via @solana/spl-token to confirm clone worked
 *   2. Calls v2.initialize_price_feed for NVDAx (forces the program to
 *      deserialize the mint via Anchor's InterfaceAccount<MintIfc>)
 *   3. If init_price_feed succeeds → v2 fixes the extension-deserialization bug
 *
 * Notes:
 *   - This does NOT test the full borrow path (would need a holder ATA)
 *   - But init_price_feed exercises the same MintIfc deserializer that the
 *     borrow path uses, so success here is high-confidence evidence v2 works.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, BN } = anchor;

const RPC = "http://localhost:8899";
const V2_PROGRAM_ID = new PublicKey("4EcnHCEgMTfaXrLwn4sv7a9BPHQekKANzQEr7bA2rUzW");
const NVDAX_MINT = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
const DEPLOYER_KP_PATH = path.join(homedir(), ".config/solana/magpie-devnet-deployer.json");

const connection = new Connection(RPC, "confirmed");
const deployerKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(DEPLOYER_KP_PATH, "utf8"))),
);
console.log(`Deployer: ${deployerKp.publicKey.toBase58()}`);

const idlPath = path.join(process.cwd(), "src/solana/idl/magpie_lending_v2.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const provider = new AnchorProvider(connection, new Wallet(deployerKp), { commitment: "confirmed" });
const program = new Program(idl, provider);

console.log("\n═══ STEP 1: Verify NVDAx mint cloned and parses ═══");
const mintInfo = await getMint(connection, NVDAX_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
const exts = getExtensionTypes(mintInfo.tlvData).map((t) => ExtensionType[t] ?? `unknown(${t})`);
console.log(`  Mint OK. decimals=${mintInfo.decimals}, supply=${mintInfo.supply}`);
console.log(`  Extensions (${exts.length}): ${exts.join(", ")}`);
const has_pausable = exts.includes("PausableConfig");
const has_scaled = exts.includes("ScaledUiAmountConfig");
console.log(`  Has the extensions that broke v1: PausableConfig=${has_pausable}, ScaledUiAmountConfig=${has_scaled}`);
if (!has_pausable || !has_scaled) {
  console.log("  ✗ Test mint doesn't have the target extensions — cannot validate fix.");
  process.exit(1);
}

console.log("\n═══ STEP 2: Initialize v2 lending pool ═══");
const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), deployerKp.publicKey.toBuffer()],
  V2_PROGRAM_ID,
);
const [loanTokenVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("loan-token-vault"), poolPda.toBuffer()],
  V2_PROGRAM_ID,
);
const wsolMint = new PublicKey("So11111111111111111111111111111111111111112");
const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const existingPool = await connection.getAccountInfo(poolPda);
if (existingPool) {
  console.log(`  Pool already exists at ${poolPda.toBase58()} — skipping init`);
} else {
  try {
    const sig = await program.methods
      .initializePool(500, 100)  // protocol_fee_bps=5%, keeper_reward_bps=1%
      .accounts({
        pool: poolPda,
        loanTokenVault: loanTokenVaultPda,
        loanTokenMint: wsolMint,
        authority: deployerKp.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: tokenProgramId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc({ commitment: "confirmed" });
    console.log(`  ✓ Pool initialized at ${poolPda.toBase58()}`);
    console.log(`    tx: ${sig}`);
  } catch (e) {
    console.log(`  ✗ Pool init failed: ${e.message}`);
    if (e.logs) for (const l of e.logs.slice(-10)) console.log("    "+l);
    process.exit(1);
  }
}

console.log("\n═══ STEP 3: Initialize price feed for NVDAx (THE CRITICAL TEST) ═══");
const [priceFeedPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("price"), NVDAX_MINT.toBuffer(), poolPda.toBuffer()],
  V2_PROGRAM_ID,
);
const existingFeed = await connection.getAccountInfo(priceFeedPda);
if (existingFeed) {
  console.log(`  Price feed already exists at ${priceFeedPda.toBase58()}`);
  console.log("  ✓ (Existing feed implies a prior init succeeded — v2 already validated against this mint)");
  process.exit(0);
}

console.log(`  Attempting init_price_feed for NVDAx via v2 program...`);
console.log(`  (this is where v1 fails with InvalidAccountData — extension deserialization)`);
try {
  const sig = await program.methods
    .initializePriceFeed()
    .accounts({
      pool: poolPda,
      mint: NVDAX_MINT,
      priceFeed: priceFeedPda,
      authority: deployerKp.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ])
    .rpc({ commitment: "confirmed" });
  console.log(`  ✓✓✓ PRICE FEED INITIALIZED — v2 successfully deserialized NVDAx mint`);
  console.log(`    Price feed PDA: ${priceFeedPda.toBase58()}`);
  console.log(`    tx: ${sig}`);
  console.log("");
  console.log("  This empirically validates the fix: anchor-spl 0.31's spl-token-2022 v5+");
  console.log("  recognizes PausableConfig + ScaledUiAmountConfig extensions where v3 did not.");
  console.log("  Mainnet deploy of v2 should now unblock RWA collateral end-to-end.");
} catch (e) {
  console.log(`  ✗ init_price_feed FAILED: ${e.message}`);
  if (e.logs) {
    console.log("  Program logs (last 12):");
    for (const l of e.logs.slice(-12)) console.log("    "+l);
  }
  process.exit(1);
}
