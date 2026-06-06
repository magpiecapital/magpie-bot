/**
 * Emergency admin withdrawal from the Magpie lending vault.
 * Bypasses share accounting — only the pool authority can call this.
 *
 * Usage:
 *   node scripts/admin-withdraw.js --amount 2.0    # withdraw 2 SOL
 *   node scripts/admin-withdraw.js --all            # withdraw everything
 *
 * Requires LENDER_KEYPAIR_PATH in env (path to solana keypair JSON).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, BN } = pkg;
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
  const out = { amount: 0, all: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amount") out.amount = Number(args[++i]);
    if (args[i] === "--all") out.all = true;
  }
  return out;
}

async function main() {
  const { amount, all } = parseArgs();

  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("LENDER_KEYPAIR_PATH not set");

  const lender = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(kpPath, "utf8"))),
  );
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const provider = new AnchorProvider(connection, new Wallet(lender), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const programId = new PublicKey(idl.address);

  console.log("Authority:", lender.publicKey.toBase58());
  console.log("Cluster:  ", provider.connection.rpcEndpoint);

  // Derive PDAs
  const [lendingPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lender.publicKey.toBuffer()],
    programId,
  );
  const [loanTokenVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan-token-vault"), lendingPool.toBuffer()],
    programId,
  );

  console.log("Pool:     ", lendingPool.toBase58());
  console.log("Vault:    ", loanTokenVault.toBase58());

  // Check vault balance
  const vaultInfo = await connection.getTokenAccountBalance(loanTokenVault).catch(() => null);
  if (!vaultInfo || vaultInfo.value.uiAmount === 0) {
    console.log("Vault is empty. Nothing to withdraw.");
    return;
  }
  console.log(`\nVault balance: ${vaultInfo.value.uiAmount} wSOL`);

  // Calculate amount
  let lamports;
  if (all) {
    lamports = BigInt(vaultInfo.value.amount);
  } else if (amount > 0) {
    lamports = BigInt(Math.floor(amount * 1e9));
    const vaultLamports = BigInt(vaultInfo.value.amount);
    if (lamports > vaultLamports) lamports = vaultLamports;
  } else {
    console.log("Specify --amount <SOL> or --all");
    return;
  }

  console.log(`\nAdmin withdrawing ${Number(lamports) / 1e9} SOL (${lamports} lamports)...`);

  // Authority's wSOL ATA
  const authorityAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    lender.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction();

  // Create ATA if needed
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      lender.publicKey,
      authorityAta,
      lender.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );

  // Admin withdraw
  const ix = await program.methods
    .adminWithdraw(new BN(lamports.toString()))
    .accounts({
      pool: lendingPool,
      loanTokenVault,
      authorityTokenAccount: authorityAta,
      authority: lender.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);

  // Close wSOL account to unwrap back to native SOL
  tx.add(
    createCloseAccountInstruction(
      authorityAta,
      lender.publicKey,
      lender.publicKey,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [lender]);
  console.log("✓ Admin withdrawal complete:", sig);

  const balance = await connection.getBalance(lender.publicKey);
  console.log(`\nWallet balance: ${balance / 1e9} SOL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
