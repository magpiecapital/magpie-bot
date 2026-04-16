import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { getProgramForSigner } from "../solana/program.js";
import {
  lendingPoolPda,
  loanTokenVaultPda,
  loanPda,
  collateralVaultPda,
} from "../solana/pdas.js";
import { loadKeypair } from "./wallet.js";
import { query } from "../db/pool.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

// Detect whether a mint uses Token-2022 or classic Token program.
async function getMintTokenProgram(mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`Mint ${mint} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

/**
 * Borrow flow:
 *   1. Compute collateral value in lamports.
 *   2. Ensure borrower has wSOL ATA (will receive loan here).
 *   3. Send request_and_fund_loan tx.
 *   4. Close wSOL ATA (unwrap → native SOL) so user sees SOL.
 */
export async function executeBorrow({
  userId,
  collateralMint,
  collateralAmountRaw,
  collateralValueLamports,
  loanOption,
}) {
  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower);

  const collateralMintPk = new PublicKey(collateralMint);
  const loanTokenMintPk = NATIVE_MINT; // wSOL

  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool);

  const collateralTokenProgram = await getMintTokenProgram(collateralMint);
  const loanTokenProgram = TOKEN_PROGRAM_ID; // wSOL is classic SPL

  const loanId = new BN(Date.now());
  const [loanAccount] = loanPda(borrower.publicKey, loanId);
  const [collateralVault] = collateralVaultPda(loanAccount);

  const borrowerCollateralAta = getAssociatedTokenAddressSync(
    collateralMintPk,
    borrower.publicKey,
    false,
    collateralTokenProgram,
  );

  const borrowerWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    borrower.publicKey,
    false,
    loanTokenProgram,
  );

  // Fee wallet's wSOL ATA — lender is also the fee receiver by default.
  // (The lender sets their fee_wallet at pool init; we assume that's the same
  // address on the bot side. The on-chain program doesn't care — it just
  // transfers to whichever fee_wallet_token_account we pass in, but the pool
  // PDA was initialized to expect a specific fee_wallet's wSOL ATA.)
  const feeWalletWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    LENDER_PUBKEY,
    false,
    loanTokenProgram,
  );

  // Pre-instructions: create borrower's wSOL ATA if missing, and ensure fee ATA exists.
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      borrowerWsolAta,
      borrower.publicKey,
      loanTokenMintPk,
      loanTokenProgram,
    ),
  ];

  // Post-instruction: unwrap wSOL → native SOL by closing the account.
  const postIxs = [
    createCloseAccountInstruction(
      borrowerWsolAta,
      borrower.publicKey,
      borrower.publicKey,
      [],
      loanTokenProgram,
    ),
  ];

  const sig = await program.methods
    .requestAndFundLoan(
      new BN(collateralAmountRaw.toString()),
      loanOption,
      new BN(collateralValueLamports.toString()),
      loanId,
    )
    .accounts({
      loan: loanAccount,
      collateralVault,
      lendingPool,
      loanTokenVault,
      loanTokenMint: loanTokenMintPk,
      collateralMint: collateralMintPk,
      borrowerCollateralAccount: borrowerCollateralAta,
      borrowerLoanTokenAccount: borrowerWsolAta,
      feeWalletTokenAccount: feeWalletWsolAta,
      borrower: borrower.publicKey,
      systemProgram: SystemProgram.programId,
      collateralTokenProgram,
      loanTokenProgram,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .rpc({ commitment: "confirmed" });

  return { signature: sig, loanId: loanId.toString(), loanPda: loanAccount.toBase58() };
}

/**
 * Repay flow:
 *   1. Wrap SOL → wSOL in borrower's ATA (enough to cover original_loan_amount).
 *   2. Call repay_loan.
 *   3. Close wSOL ATA (recover rent, convert leftover wSOL back to SOL).
 */
export async function executeRepay({ userId, loanDbRow }) {
  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower);

  const collateralMintPk = new PublicKey(loanDbRow.collateral_mint);
  const loanTokenMintPk = NATIVE_MINT;

  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const [collateralVault] = collateralVaultPda(loanPdaPk);

  const collateralTokenProgram = await getMintTokenProgram(loanDbRow.collateral_mint);
  const loanTokenProgram = TOKEN_PROGRAM_ID;

  const borrowerCollateralAta = getAssociatedTokenAddressSync(
    collateralMintPk,
    borrower.publicKey,
    false,
    collateralTokenProgram,
  );
  const borrowerWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    borrower.publicKey,
    false,
    loanTokenProgram,
  );

  const repayLamports = BigInt(loanDbRow.original_loan_amount_lamports);

  // Wrap SOL → wSOL: create ATA, transfer lamports to it, sync_native.
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      borrowerWsolAta,
      borrower.publicKey,
      loanTokenMintPk,
      loanTokenProgram,
    ),
    SystemProgram.transfer({
      fromPubkey: borrower.publicKey,
      toPubkey: borrowerWsolAta,
      lamports: repayLamports,
    }),
    createSyncNativeInstruction(borrowerWsolAta, loanTokenProgram),
  ];

  // Close ATA after repayment to recover rent + any leftover wSOL.
  const postIxs = [
    createCloseAccountInstruction(
      borrowerWsolAta,
      borrower.publicKey,
      borrower.publicKey,
      [],
      loanTokenProgram,
    ),
  ];

  const sig = await program.methods
    .repayLoan()
    .accounts({
      loan: loanPdaPk,
      collateralVault,
      lendingPool,
      loanTokenVault,
      loanTokenMint: loanTokenMintPk,
      collateralMint: collateralMintPk,
      borrowerCollateralAccount: borrowerCollateralAta,
      borrowerLoanTokenAccount: borrowerWsolAta,
      borrower: borrower.publicKey,
      collateralTokenProgram,
      loanTokenProgram,
    })
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .rpc({ commitment: "confirmed" });

  return { signature: sig };
}

/**
 * Persist a new loan record after on-chain success.
 */
export async function recordLoan({
  userId,
  loanId,
  loanPda,
  collateralMint,
  collateralAmount,
  loanAmountLamports,
  originalLoanAmountLamports,
  ltvPercentage,
  durationDays,
  txSignature,
}) {
  const startTs = new Date();
  const dueTs = new Date(startTs.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO loans (
       user_id, loan_id, loan_pda, collateral_mint, collateral_amount,
       loan_amount_lamports, original_loan_amount_lamports,
       ltv_percentage, duration_days,
       start_timestamp, due_timestamp, status, tx_signature
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)`,
    [
      userId,
      loanId,
      loanPda,
      collateralMint,
      collateralAmount,
      loanAmountLamports,
      originalLoanAmountLamports,
      ltvPercentage,
      durationDays,
      startTs,
      dueTs,
      txSignature,
    ],
  );
}

export async function markLoanRepaid(loanDbId, txSignature) {
  await query(
    `UPDATE loans SET status='repaid', tx_signature=$2, updated_at=NOW() WHERE id=$1`,
    [loanDbId, txSignature],
  );
}
