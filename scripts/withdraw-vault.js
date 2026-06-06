/**
 * Withdraw SOL from the Magpie lending vault.
 *
 * Usage:
 *   node scripts/withdraw-vault.js --amount 1.5    # withdraw 1.5 SOL worth of shares
 *   node scripts/withdraw-vault.js --all            # withdraw everything
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

/**
 * Read a u64 from a buffer at offset (little-endian).
 */
function readU64(buf, offset) {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  return BigInt(lo) + (BigInt(hi) << 32n);
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

  // Check vault balance
  const vaultInfo = await connection.getTokenAccountBalance(loanTokenVault).catch(() => null);
  if (!vaultInfo) {
    console.log("Vault not found or empty. Nothing to withdraw.");
    return;
  }
  console.log(`\nVault balance: ${vaultInfo.value.uiAmount} wSOL`);

  // Read position account raw data to get shares
  // DepositorPosition layout: 8-byte discriminator + 32-byte pool + 32-byte depositor + 8-byte shares
  const positionAcct = await connection.getAccountInfo(position);
  if (!positionAcct) {
    console.log("No position found. You have no shares to withdraw.");
    return;
  }
  const totalShares = readU64(positionAcct.data, 8 + 32 + 32); // after discriminator + pool + depositor
  console.log(`Your shares: ${totalShares}`);

  if (totalShares === 0n) {
    console.log("No shares to withdraw.");
    return;
  }

  // Read pool account to get total_shares for partial withdrawal calc
  // LendingPool layout: 8-byte disc + 32 authority + 32 loan_token_mint + 32 loan_token_vault +
  //   8 total_deposits + 8 total_borrowed + 8 total_shares + ...
  const poolAcct = await connection.getAccountInfo(lendingPool);
  const poolTotalShares = readU64(poolAcct.data, 8 + 32 + 32 + 32 + 8 + 8);

  // Calculate shares to withdraw
  let sharesToWithdraw;
  if (all) {
    sharesToWithdraw = totalShares;
  } else if (amount > 0) {
    const vaultLamports = BigInt(vaultInfo.value.amount);
    const lamportsRequested = BigInt(Math.floor(amount * 1e9));
    sharesToWithdraw = (lamportsRequested * poolTotalShares) / vaultLamports;
    if (sharesToWithdraw > totalShares) sharesToWithdraw = totalShares;
  } else {
    console.log("Specify --amount <SOL> or --all");
    return;
  }

  console.log(`\nWithdrawing ${sharesToWithdraw} shares...`);

  // Ensure wSOL ATA exists
  const depositorAta = getAssociatedTokenAddressSync(
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
      depositorAta,
      lender.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );

  // Withdraw
  const withdrawIx = await program.methods
    .withdraw(new BN(sharesToWithdraw.toString()))
    .accounts({
      pool: lendingPool,
      loanTokenVault,
      position,
      depositorTokenAccount: depositorAta,
      depositor: lender.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(withdrawIx);

  // Close wSOL account to unwrap back to native SOL
  tx.add(
    createCloseAccountInstruction(
      depositorAta,
      lender.publicKey,
      lender.publicKey,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [lender]);
  console.log("✓ Withdrawal complete:", sig);

  const balance = await connection.getBalance(lender.publicKey);
  console.log(`\nWallet balance: ${balance / 1e9} SOL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
