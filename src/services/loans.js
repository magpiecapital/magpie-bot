import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
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
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { getProgramForSigner } from "../solana/program.js";
import {
  lendingPoolPda,
  loanTokenVaultPda,
  loanPda,
  collateralVaultPda,
  priceFeedPda,
} from "../solana/pdas.js";
import { loadKeypair } from "./wallet.js";
import { query } from "../db/pool.js";
import { recordCreditEvent } from "./credit-score.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

/**
 * Load the lender keypair. Prefers LENDER_PRIVATE_KEY env var (base58)
 * for production where there's no keypair file on disk; falls back to
 * LENDER_KEYPAIR_PATH file for local dev.
 */
function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

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

  // Authority must co-sign to attest the collateral value
  const lenderKeypair = loadLenderKeypair();

  const sig = await program.methods
    .requestAndFundLoan(
      new BN(collateralAmountRaw.toString()),
      loanOption,
      new BN(collateralValueLamports.toString()),
      loanId,
    )
    .accounts({
      pool: lendingPool,
      loanTokenVault,
      loan: loanAccount,
      collateralVault,
      collateralMint: collateralMintPk,
      borrowerCollateralAccount: borrowerCollateralAta,
      borrowerLoanTokenAccount: borrowerWsolAta,
      feeWalletTokenAccount: feeWalletWsolAta,
      borrower: borrower.publicKey,
      authority: LENDER_PUBKEY,
      priceFeed: priceFeedPda(collateralMintPk, lendingPool)[0],
      systemProgram: SystemProgram.programId,
      tokenProgram: collateralTokenProgram,
      loanTokenProgram,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([lenderKeypair])
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
      pool: lendingPool,
      loanTokenVault,
      loan: loanPdaPk,
      collateralMint: collateralMintPk,
      collateralVault,
      borrowerCollateralAccount: borrowerCollateralAta,
      borrowerLoanTokenAccount: borrowerWsolAta,
      borrower: borrower.publicKey,
      tokenProgram: collateralTokenProgram,
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

/**
 * Mark a loan as repaid AND record the corresponding credit event.
 * The event type is derived from when the user repaid relative to the
 * loan's due_timestamp:
 *   - repaid >24h before due  → repay_early  (+20)
 *   - repaid before due       → repay_ontime (+15)
 *   - repaid after due        → repay_late   (-10)
 */
export async function markLoanRepaid(loanDbId, txSignature) {
  const { rows: [loan] } = await query(
    `SELECT user_id, due_timestamp FROM loans WHERE id = $1`,
    [loanDbId],
  );

  await query(
    `UPDATE loans SET status='repaid', tx_signature=$2, updated_at=NOW() WHERE id=$1`,
    [loanDbId, txSignature],
  );

  if (loan) {
    const now = Date.now();
    const due = new Date(loan.due_timestamp).getTime();
    const eventType =
      now > due ? "repay_late"
      : (due - now) > 24 * 60 * 60 * 1000 ? "repay_early"
      : "repay_ontime";
    try {
      await recordCreditEvent(loan.user_id, eventType, loanDbId);
    } catch (err) {
      console.error("[loans] recordCreditEvent failed on repay:", err.message);
    }
  }
}

/**
 * Add more collateral to an existing loan (improves health ratio).
 * No fee charged. Collateral can be same mint as original loan.
 */
export async function executeAddCollateral({ userId, loanDbRow, extraRawAmount }) {
  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower);

  const collateralMintPk = new PublicKey(loanDbRow.collateral_mint);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const [collateralVault] = collateralVaultPda(loanPdaPk);
  const collateralTokenProgram = await getMintTokenProgram(loanDbRow.collateral_mint);

  const borrowerCollateralAta = getAssociatedTokenAddressSync(
    collateralMintPk,
    borrower.publicKey,
    false,
    collateralTokenProgram,
  );

  const sig = await program.methods
    .addCollateral(new BN(extraRawAmount.toString()))
    .accounts({
      loan: loanPdaPk,
      collateralMint: collateralMintPk,
      collateralVault,
      borrowerCollateralAccount: borrowerCollateralAta,
      borrower: borrower.publicKey,
      tokenProgram: collateralTokenProgram,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })])
    .rpc({ commitment: "confirmed" });

  return { signature: sig };
}

/**
 * Partial repay: pay down part of the loan (collateral stays locked).
 * Requires amount < original_loan_amount (full repayment must use /repay).
 */
export async function executePartialRepay({ userId, loanDbRow, repayLamports }) {
  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower);

  const loanTokenMintPk = NATIVE_MINT;
  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const loanTokenProgram = TOKEN_PROGRAM_ID;

  const borrowerWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    borrower.publicKey,
    false,
    loanTokenProgram,
  );

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
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
      lamports: BigInt(repayLamports.toString()),
    }),
    createSyncNativeInstruction(borrowerWsolAta, loanTokenProgram),
  ];

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
    .partialRepay(new BN(repayLamports.toString()))
    .accounts({
      pool: lendingPool,
      loanTokenVault,
      loan: loanPdaPk,
      borrowerLoanTokenAccount: borrowerWsolAta,
      borrower: borrower.publicKey,
      loanTokenProgram,
    })
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .rpc({ commitment: "confirmed" });

  return { signature: sig };
}

/**
 * Extend the loan by its original duration for the tier fee
 * (Express 3%, Quick 2%, Standard 1.5%).
 * If already past due, clock resets from now.
 */
export async function executeExtendLoan({ userId, loanDbRow }) {
  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower);

  const loanTokenMintPk = NATIVE_MINT;
  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const loanTokenProgram = TOKEN_PROGRAM_ID;

  const borrowerWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    borrower.publicKey,
    false,
    loanTokenProgram,
  );
  const feeWalletWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    LENDER_PUBKEY,
    false,
    loanTokenProgram,
  );

  // Fee = tier-dependent % of current original_loan_amount.
  // Express (30% LTV) = 3%, Quick (25%) = 2%, Standard (20%) = 1.5%
  const ltv = loanDbRow.ltv_percentage;
  const feeBps = ltv >= 30 ? 300n : ltv >= 25 ? 200n : 150n;
  const feeLamports = (BigInt(loanDbRow.original_loan_amount_lamports) * feeBps) / 10_000n;

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
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
      lamports: feeLamports,
    }),
    createSyncNativeInstruction(borrowerWsolAta, loanTokenProgram),
  ];

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
    .extendLoan()
    .accounts({
      pool: lendingPool,
      loanTokenVault,
      loan: loanPdaPk,
      borrowerLoanTokenAccount: borrowerWsolAta,
      feeWalletTokenAccount: feeWalletWsolAta,
      borrower: borrower.publicKey,
      loanTokenProgram,
    })
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .rpc({ commitment: "confirmed" });

  return { signature: sig, feeLamports: feeLamports.toString() };
}

/**
 * Persist collateral top-up in the DB.
 */
export async function recordAddCollateral(loanDbId, extraRawAmount, userId = null) {
  await query(
    `UPDATE loans
     SET collateral_amount = (collateral_amount::numeric + $2::numeric)::text,
         last_health_alert = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [loanDbId, extraRawAmount.toString()],
  );
  if (userId) {
    try { await recordCreditEvent(userId, "topup", loanDbId); } catch (_) {}
  }
}

/**
 * Persist partial repayment in the DB (decrements original_loan_amount).
 */
export async function recordPartialRepay(loanDbId, repayLamports, userId = null) {
  await query(
    `UPDATE loans
     SET original_loan_amount_lamports = (original_loan_amount_lamports::numeric - $2::numeric)::text,
         last_health_alert = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [loanDbId, repayLamports.toString()],
  );
  if (userId) {
    try { await recordCreditEvent(userId, "partial_repay", loanDbId); } catch (_) {}
  }
}

/**
 * Persist loan extension in the DB. Adds duration_days to due_timestamp,
 * or resets from now if the loan was already past due.
 */
export async function recordExtendLoan(loanDbId, userId = null) {
  await query(
    `UPDATE loans
     SET due_timestamp = CASE
           WHEN due_timestamp < NOW() THEN NOW() + (duration_days || ' days')::interval
           ELSE due_timestamp + (duration_days || ' days')::interval
         END,
         warned_24h_at = NULL,
         last_health_alert = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [loanDbId],
  );
  if (userId) {
    try { await recordCreditEvent(userId, "extend", loanDbId); } catch (_) {}
  }
}
