/**
 * One-time bootstrap: initialize the BagBank lending pool with wSOL as the
 * loan asset, and optionally seed the vault with wrapped SOL.
 *
 * Usage:
 *   node scripts/init-pool.js --fund 10
 *
 * Requires LENDER_KEYPAIR_PATH in env (path to solana keypair JSON).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(
  readFileSync(path.join(__dirname, "..", "src", "solana", "idl", "magpie_lending.json"), "utf8"),
);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { fund: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fund") out.fund = Number(args[++i]);
  }
  return out;
}

async function main() {
  const { fund } = parseArgs();

  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("LENDER_KEYPAIR_PATH not set");

  const lender = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(kpPath, "utf8"))),
  );
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed",
  );
  const provider = new AnchorProvider(connection, new Wallet(lender), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const programId = new PublicKey(idl.address);

  console.log("Lender:  ", lender.publicKey.toBase58());
  console.log("Program: ", programId.toBase58());
  console.log("Cluster: ", provider.connection.rpcEndpoint);

  const [lendingPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lender.publicKey.toBuffer()],
    programId,
  );
  const [loanTokenVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan-token-vault"), lendingPool.toBuffer()],
    programId,
  );

  console.log("Pool PDA:", lendingPool.toBase58());
  console.log("Vault:   ", loanTokenVault.toBase58());

  const poolInfo = await connection.getAccountInfo(lendingPool);
  if (poolInfo) {
    console.log("\n✓ Pool already initialized, skipping init.");
  } else {
    const protocolFeeBps = 2000; // 20% protocol fee
    const keeperRewardBps = 500; // 5% keeper liquidation bounty
    console.log("\nInitializing pool (protocol fee:", protocolFeeBps, "bps, keeper reward:", keeperRewardBps, "bps)...");
    const sig = await program.methods
      .initializePool(protocolFeeBps, keeperRewardBps)
      .accounts({
        pool: lendingPool,
        loanTokenVault,
        loanTokenMint: NATIVE_MINT,
        authority: lender.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });
    console.log("✓ Pool initialized:", sig);
  }

  // Also create the fee_wallet's wSOL ATA (needed by request_and_fund_loan).
  const feeAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    lender.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const feeAtaInfo = await connection.getAccountInfo(feeAta);
  if (!feeAtaInfo) {
    console.log("\nCreating fee wallet's wSOL ATA...");
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        lender.publicKey,
        feeAta,
        lender.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      ),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [lender]);
    console.log("✓ Fee ATA created:", sig);
  }

  if (fund > 0) {
    console.log(`\n⚠ To fund the vault, use the deposit script (creates withdrawable shares):`);
    console.log(`  LENDER_KEYPAIR_PATH=${kpPath} node scripts/deposit-vault.js --amount ${fund}`);
    console.log(`\n  Do NOT send SOL directly to the vault — it won't be withdrawable.`);
  }

  const vaultInfo = await connection.getTokenAccountBalance(loanTokenVault).catch(() => null);
  if (vaultInfo) {
    console.log(`\nVault balance: ${vaultInfo.value.uiAmount} wSOL`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
