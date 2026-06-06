/**
 * Deposit SOL into the Magpie lending vault via the deposit instruction.
 *
 * Usage:
 *   node scripts/deposit-vault.js --amount 0.1
 *
 * Requires LENDER_KEYPAIR_PATH in env (path to solana keypair JSON).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
  const out = { amount: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amount") out.amount = Number(args[++i]);
  }
  return out;
}

async function main() {
  const { amount } = parseArgs();
  if (amount <= 0) throw new Error("Specify --amount <SOL>");

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

  console.log("Lender:  ", lender.publicKey.toBase58());
  console.log("Cluster: ", provider.connection.rpcEndpoint);

  // Derive PDAs
  const [lendingPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lender.publicKey.toBuffer()],
    programId,
  );
  const [loanTokenVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan-token-vault"), lendingPool.toBuffer()],
    programId,
  );
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), lendingPool.toBuffer(), lender.publicKey.toBuffer()],
    programId,
  );

  console.log("Pool:    ", lendingPool.toBase58());
  console.log("Vault:   ", loanTokenVault.toBase58());
  console.log("Position:", position.toBase58());

  // Check vault before
  const vaultBefore = await connection.getTokenAccountBalance(loanTokenVault).catch(() => null);
  console.log(`\nVault balance before: ${vaultBefore?.value.uiAmount ?? 0} wSOL`);

  const lamports = BigInt(Math.floor(amount * 1e9));
  console.log(`Depositing ${amount} SOL (${lamports} lamports)...`);

  // Depositor's wSOL ATA
  const depositorAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    lender.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction();

  // 1. Create wSOL ATA if needed
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      lender.publicKey,
      depositorAta,
      lender.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );

  // 2. Transfer SOL into the wSOL ATA and sync
  tx.add(
    SystemProgram.transfer({
      fromPubkey: lender.publicKey,
      toPubkey: depositorAta,
      lamports,
    }),
    createSyncNativeInstruction(depositorAta, TOKEN_PROGRAM_ID),
  );

  // 3. Call deposit instruction
  const depositIx = await program.methods
    .deposit(new BN(lamports.toString()))
    .accounts({
      pool: lendingPool,
      loanTokenVault,
      position,
      depositorTokenAccount: depositorAta,
      depositor: lender.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx.add(depositIx);

  const sig = await sendAndConfirmTransaction(connection, tx, [lender]);
  console.log("✓ Deposit complete:", sig);

  // Verify
  const vaultAfter = await connection.getTokenAccountBalance(loanTokenVault).catch(() => null);
  console.log(`\nVault balance after: ${vaultAfter?.value.uiAmount ?? 0} wSOL`);

  const balance = await connection.getBalance(lender.publicKey);
  console.log(`Wallet balance: ${balance / 1e9} SOL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
