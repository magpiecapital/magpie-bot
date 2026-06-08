#!/usr/bin/env node
/**
 * Force-liquidate a loan via the on-chain liquidate_loan instruction.
 *
 * The contract decides whether liquidation is legal — this script just
 * SUBMITS the ix. If the loan is not yet due AND the contract requires
 * `dueTimestamp` to have passed, the tx will fail and no state changes.
 * That's fine — running this is non-destructive on a failed attempt.
 *
 * Usage:
 *   railway run node scripts/force-liquidate-loan.js <loan_id>
 *   railway run node scripts/force-liquidate-loan.js <loan_id> --execute
 *
 *   <loan_id> is the on-chain PDA address (base58), not the DB row id.
 *   Look it up in /admin or via `SELECT loan_id FROM loans WHERE id = X`.
 *
 * Why this exists: the keeper only runs after the loan's dueTimestamp.
 * For exploit loans where the collateral has already been dumped, we
 * may want to attempt liquidation early — even if the contract refuses,
 * trying is harmless and we want the operator's-eye-view ability to do
 * so without redeploying.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PublicKey, ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { connection } from "../src/solana/connection.js";
import { getProgramForSigner } from "../src/solana/program.js";

const loanArg = process.argv.find((a) => !a.startsWith("-") && a.length >= 32);
const execute = process.argv.includes("--execute");

if (!loanArg) {
  console.error("Usage: railway run node scripts/force-liquidate-loan.js <loan_pubkey> [--execute]");
  process.exit(1);
}

function loadKeeper() {
  const b58 = process.env.KEEPER_PRIVATE_KEY || process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.KEEPER_KEYPAIR_PATH || process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("Need KEEPER_PRIVATE_KEY or LENDER_PRIVATE_KEY in env");
  const raw = JSON.parse(fs.readFileSync(path.resolve(kpPath), "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

console.log("─".repeat(60));
console.log(`Loan PDA:  ${loanArg}`);
console.log(`Mode:      ${execute ? "EXECUTE" : "DRY-RUN (no --execute)"}`);
console.log("─".repeat(60));

const keeper = loadKeeper();
const program = getProgramForSigner(keeper);
const loanPubkey = new PublicKey(loanArg);

const loanData = await program.account.loan.fetch(loanPubkey);
const nowSec = Math.floor(Date.now() / 1000);
const dueSec = loanData.dueTimestamp.toNumber();
const overdue = nowSec > dueSec;
console.log(`Borrower:  ${loanData.borrower.toBase58()}`);
console.log(`Mint:      ${loanData.collateralMint.toBase58()}`);
console.log(`Pool:      ${loanData.pool.toBase58()}`);
console.log(`Status:    ${overdue ? "OVERDUE" : "NOT-YET-DUE (will likely fail on chain)"}`);
console.log(`Due in:    ${overdue ? -(nowSec - dueSec) : dueSec - nowSec}s`);

if (!execute) {
  console.log("\nDRY-RUN complete. Re-run with --execute to attempt the liquidation tx.");
  process.exit(0);
}

const poolData = await program.account.lendingPool.fetch(loanData.pool);

const [collateralVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("collateral-vault"), loanPubkey.toBuffer()],
  program.programId,
);

const mintInfo = await connection.getAccountInfo(loanData.collateralMint);
const collateralTokenProgram =
  mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

const keeperAta = await getOrCreateAssociatedTokenAccount(
  connection,
  keeper,
  loanData.collateralMint,
  keeper.publicKey,
  false,
  "confirmed",
  undefined,
  collateralTokenProgram,
);
const authorityAta = await getOrCreateAssociatedTokenAccount(
  connection,
  keeper,
  loanData.collateralMint,
  poolData.authority,
  false,
  "confirmed",
  undefined,
  collateralTokenProgram,
);

try {
  const sig = await program.methods
    .liquidateLoan()
    .accounts({
      pool: loanData.pool,
      loan: loanPubkey,
      collateralMint: loanData.collateralMint,
      collateralVault: collateralVaultPda,
      keeperCollateralAccount: keeperAta.address,
      authorityCollateralAccount: authorityAta.address,
      keeper: keeper.publicKey,
      tokenProgram: collateralTokenProgram,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ])
    .rpc({ commitment: "confirmed" });
  console.log(`\n✅ Liquidated. tx: ${sig}`);
} catch (err) {
  console.error(`\n❌ Liquidation failed: ${err.message}`);
  console.error(`(If the loan is not yet due, the on-chain program likely rejected the ix. That is expected behavior — wait until dueTimestamp.)`);
  process.exit(1);
}
