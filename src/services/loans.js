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
import {
  getProgramForSigner,
  PROGRAM_ID,
  chooseProgramIdForCategory,
  chooseProgramIdForLoan,
} from "../solana/program.js";
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
 * Get the live on-chain amount owed for a loan. The DB column
 * `original_loan_amount_lamports` should reflect partial repays (it's
 * decremented by recordPartialRepay), but those writes can fail silently
 * — leaving the DB stale while the chain stays correct. Every user-
 * facing surface (positions, repay, partialrepay, extend) should call
 * this to display the truth. Opportunistically heals the DB if drift is
 * detected, so the system self-corrects over time.
 *
 * Returns a BigInt of lamports owed. Falls back to the DB value if the
 * on-chain fetch fails (e.g., RPC blip).
 */
export async function getLiveOwedLamports(loan) {
  try {
    const { getReadOnlyProgram } = await import("../solana/program.js");
    const programId = chooseProgramIdForLoan(loan);
    const program = getReadOnlyProgram(programId);
    const onChain = await program.account.loan.fetch(new PublicKey(loan.loan_pda));
    const live = BigInt(onChain.repayAmount.toString());
    const stored = BigInt(loan.original_loan_amount_lamports);
    if (live !== stored) {
      // Fire-and-forget DB heal
      query(
        `UPDATE loans SET original_loan_amount_lamports = $2, updated_at = NOW() WHERE id = $1`,
        [loan.id, live.toString()],
      ).catch(() => {});
    }
    return live;
  } catch {
    return BigInt(loan.original_loan_amount_lamports);
  }
}

/**
 * Pre-flight wallet-ownership check. Reads the on-chain loan PDA and
 * compares the stored `borrower` pubkey against the wallet currently
 * tied to this user account. If they don't match, the user changed
 * wallets after taking out the loan (typically via /import) — repaying,
 * extending, topping up, etc. will fail on-chain with ConstraintHasOne.
 *
 * This function lets every loan-action command catch that BEFORE
 * building the tx — so users see a clear, friendly explanation instead
 * of a cryptic Solana error.
 *
 * Returns:
 *   { ok: true }                                                if wallets match
 *   { ok: false, reason: "wallet_mismatch", currentWallet, borrowerWallet, loanId }
 *                                                              if mismatched
 *   { ok: true, skipped: true }                                 on RPC blip (don't block the user)
 */
export async function checkLoanOwnership(userId, loan) {
  try {
    const { ensureWallet } = await import("./wallet.js");
    const current = await ensureWallet(userId);
    const currentPubkey = current.publicKey;

    const { getReadOnlyProgram } = await import("../solana/program.js");
    const programId = chooseProgramIdForLoan(loan);
    const program = getReadOnlyProgram(programId);
    const onChain = await program.account.loan.fetch(new PublicKey(loan.loan_pda));
    const borrowerPubkey = onChain.borrower.toBase58();

    if (currentPubkey !== borrowerPubkey) {
      return {
        ok: false,
        reason: "wallet_mismatch",
        currentWallet: currentPubkey,
        borrowerWallet: borrowerPubkey,
        loanId: loan.loan_id,
      };
    }
    return { ok: true };
  } catch (err) {
    // RPC blip — don't block the user. The tx will surface the error
    // via the translator if there's actually a problem.
    console.warn("[checkLoanOwnership] failed:", err?.message);
    return { ok: true, skipped: true };
  }
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
  // Look up the collateral's category to decide which lending program to use.
  // RWAs (stocks/ETFs/metals) route to v2 (newer anchor-spl with Token-2022
  // extension support); everything else routes to v1. If v2 isn't configured
  // (PROGRAM_ID_V2 env unset), every borrow routes to v1 — fail-safe.
  const { rows: catRows } = await query(
    `SELECT category FROM supported_mints WHERE mint = $1`,
    [collateralMint],
  );
  const category = catRows[0]?.category ?? "memecoin";
  const programId = chooseProgramIdForCategory(category);

  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower, programId);

  const collateralMintPk = new PublicKey(collateralMint);
  const loanTokenMintPk = NATIVE_MINT; // wSOL

  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);

  const collateralTokenProgram = await getMintTokenProgram(collateralMint);
  const loanTokenProgram = TOKEN_PROGRAM_ID; // wSOL is classic SPL

  const loanId = new BN(Date.now());
  const [loanAccount] = loanPda(borrower.publicKey, loanId, programId);
  const [collateralVault] = collateralVaultPda(loanAccount, programId);

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

  // Pre-instructions: create borrower's wSOL ATA AND fee wallet's wSOL ATA
  // if missing. The fee ATA can auto-close once its wSOL balance is drained
  // (wSOL accounts get closed to reclaim rent); without idempotently creating
  // it here, subsequent borrows fail with AccountNotInitialized on the
  // fee_wallet_token_account constraint. Borrower pays the rent (~0.002 SOL,
  // one-time) — fee ATA persists thereafter as long as it holds wSOL.
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      borrowerWsolAta,
      borrower.publicKey,
      loanTokenMintPk,
      loanTokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      feeWalletWsolAta,
      LENDER_PUBKEY,
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
      priceFeed: priceFeedPda(collateralMintPk, lendingPool, programId)[0],
      systemProgram: SystemProgram.programId,
      tokenProgram: collateralTokenProgram,
      loanTokenProgram,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([lenderKeypair])
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .rpc({ commitment: "confirmed" });

  return {
    signature: sig,
    loanId: loanId.toString(),
    loanPda: loanAccount.toBase58(),
    programId: programId.toBase58(),
  };
}

/**
 * Repay flow:
 *   1. Wrap SOL → wSOL in borrower's ATA (enough to cover original_loan_amount).
 *   2. Call repay_loan.
 *   3. Close wSOL ATA (recover rent, convert leftover wSOL back to SOL).
 */
export async function executeRepay({ userId, loanDbRow }) {
  // Use the program the loan was originally created on (v1 for everything
  // pre-v2-launch, populated via the program_id column at borrow time).
  const programId = chooseProgramIdForLoan(loanDbRow);

  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower, programId);

  const collateralMintPk = new PublicKey(loanDbRow.collateral_mint);
  const loanTokenMintPk = NATIVE_MINT;

  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const [collateralVault] = collateralVaultPda(loanPdaPk, programId);

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

  // Read the LIVE on-chain repay_amount instead of trusting the DB column.
  // After partial repays, the on-chain repay_amount decrements but the DB
  // sync (recordPartialRepay) can fail silently — leaving the DB stale.
  // Using on-chain value here makes the repay tx wrap the correct amount
  // (only what's actually owed), and self-heals the DB row.
  let repayLamports;
  try {
    const liveLoan = await program.account.loan.fetch(loanPdaPk);
    repayLamports = BigInt(liveLoan.repayAmount.toString());
    // Opportunistic DB heal — bring the stored amount back in sync.
    if (BigInt(loanDbRow.original_loan_amount_lamports) !== repayLamports) {
      try {
        await query(
          `UPDATE loans SET original_loan_amount_lamports = $2, updated_at = NOW() WHERE id = $1`,
          [loanDbRow.id, repayLamports.toString()],
        );
        console.log(`[repay] Synced loan ${loanDbRow.id} from DB ${loanDbRow.original_loan_amount_lamports} to on-chain ${repayLamports}`);
      } catch (err) {
        console.warn("[repay] DB sync after on-chain read failed (proceeding):", err.message);
      }
    }
  } catch (err) {
    console.warn("[repay] on-chain fetch failed, falling back to DB:", err.message);
    repayLamports = BigInt(loanDbRow.original_loan_amount_lamports);
  }

  // Pre-instructions:
  //   1. Idempotent create of borrower's COLLATERAL ATA. The program returns
  //      collateral here on repay; if the user closed the ATA between borrow
  //      and repay (Phantom/Solflare let users close empty token accounts
  //      to reclaim rent), the tx fails with AccountNotInitialized on
  //      borrower_collateral_account. Cheap to recreate (~0.002 SOL rent,
  //      recoverable later).
  //   2. Wrap SOL → wSOL in borrower's loan-token ATA so they can pay back
  //      the principal: create ATA, fund it, sync_native.
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      borrowerCollateralAta,
      borrower.publicKey,
      collateralMintPk,
      collateralTokenProgram,
    ),
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
 *
 * Also credits the borrower's referrer (if any) with their share of the
 * loan fee. The fee is the difference between original (debt) and net
 * (received) — already known from the on-chain math.
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
  programId,
}) {
  const startTs = new Date();
  const dueTs = new Date(startTs.getTime() + durationDays * 24 * 60 * 60 * 1000);

  // Persist which program this loan was created against. Older callers that
  // don't pass programId fall through to v1 — matches the column backfill.
  const recordedProgramId = programId ?? PROGRAM_ID.toBase58();

  const { rows } = await query(
    `INSERT INTO loans (
       user_id, loan_id, loan_pda, collateral_mint, collateral_amount,
       loan_amount_lamports, original_loan_amount_lamports,
       ltv_percentage, duration_days,
       start_timestamp, due_timestamp, status, tx_signature, program_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13)
     RETURNING id`,
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
      recordedProgramId,
    ],
  );

  // Compute the on-chain fee once and feed it to all the off-chain accrual hooks
  // (referrals + $MAGPIE holder pool). fee = debt − received.
  const feeLamports = BigInt(originalLoanAmountLamports) - BigInt(loanAmountLamports);

  // Referral fee-share accrual
  try {
    const { accrueFromLoan } = await import("./referral-rewards.js");
    if (feeLamports > 0n) {
      await accrueFromLoan({
        refereeUserId: userId,
        loanDbId: rows[0].id,
        feeLamports,
        eventType: "borrow",
      });
    }
  } catch (err) {
    console.error("[loans] referral accrual on borrow failed (continuing):", err.message);
  }

  // $MAGPIE holder pool accrual (10% of fee)
  try {
    const { accrueToHolderPool } = await import("./magpie-holder-rewards.js");
    if (feeLamports > 0n) {
      await accrueToHolderPool(feeLamports);
    }
  } catch (err) {
    console.error("[loans] holder pool accrual on borrow failed (continuing):", err.message);
  }

  // LP Loyalty Bonus Pool accrual (2% of fee, sourced from protocol slice)
  try {
    const { accrueToLpLoyaltyPool } = await import("./lp-loyalty.js");
    if (feeLamports > 0n) {
      await accrueToLpLoyaltyPool(feeLamports);
    }
  } catch (err) {
    console.error("[loans] LP loyalty accrual on borrow failed (continuing):", err.message);
  }
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
    const onTime = now <= due;
    const eventType =
      !onTime ? "repay_late"
      : (due - now) > 24 * 60 * 60 * 1000 ? "repay_early"
      : "repay_ontime";
    try {
      await recordCreditEvent(loan.user_id, eventType, loanDbId);
    } catch (err) {
      console.error("[loans] recordCreditEvent failed on repay:", err.message);
    }
    // Streak tracking — increment on on-time, reset on late.
    try {
      if (onTime) {
        await query(
          `UPDATE users
              SET current_streak = current_streak + 1,
                  best_streak = GREATEST(best_streak, current_streak + 1),
                  last_repay_was_on_time = TRUE
            WHERE id = $1`,
          [loan.user_id],
        );
      } else {
        await query(
          `UPDATE users
              SET current_streak = 0,
                  last_repay_was_on_time = FALSE
            WHERE id = $1`,
          [loan.user_id],
        );
      }
    } catch (err) {
      console.error("[loans] streak update failed:", err.message);
    }
  }
}

/**
 * Add more collateral to an existing loan (improves health ratio).
 * No fee charged. Collateral can be same mint as original loan.
 */
export async function executeAddCollateral({ userId, loanDbRow, extraRawAmount }) {
  const programId = chooseProgramIdForLoan(loanDbRow);

  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower, programId);

  const collateralMintPk = new PublicKey(loanDbRow.collateral_mint);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const [collateralVault] = collateralVaultPda(loanPdaPk, programId);
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
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ])
    .rpc({ commitment: "confirmed" });

  return { signature: sig };
}

/**
 * Partial repay: pay down part of the loan (collateral stays locked).
 * Requires amount < original_loan_amount (full repayment must use /repay).
 */
export async function executePartialRepay({ userId, loanDbRow, repayLamports }) {
  const programId = chooseProgramIdForLoan(loanDbRow);

  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower, programId);

  const loanTokenMintPk = NATIVE_MINT;
  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);
  const loanPdaPk = new PublicKey(loanDbRow.loan_pda);
  const loanTokenProgram = TOKEN_PROGRAM_ID;

  const borrowerWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk,
    borrower.publicKey,
    false,
    loanTokenProgram,
  );

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
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
  const programId = chooseProgramIdForLoan(loanDbRow);

  const borrower = await loadKeypair(userId);
  const program = getProgramForSigner(borrower, programId);

  const loanTokenMintPk = NATIVE_MINT;
  const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
  const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);
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

  // Fee = tier-dependent % of current OWED amount.
  // Express (30% LTV) = 3%, Quick (25%) = 2%, Standard (20%) = 1.5%
  // Read live on-chain owed so the fee math doesn't overcharge users
  // who've already partially repaid.
  const ltv = loanDbRow.ltv_percentage;
  const feeBps = ltv >= 30 ? 300n : ltv >= 25 ? 200n : 150n;
  const owedLive = await getLiveOwedLamports(loanDbRow);
  const feeLamports = (owedLive * feeBps) / 10_000n;

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      borrowerWsolAta,
      borrower.publicKey,
      loanTokenMintPk,
      loanTokenProgram,
    ),
    // Same safety as executeBorrow: ensure the fee wallet's wSOL ATA exists.
    createAssociatedTokenAccountIdempotentInstruction(
      borrower.publicKey,
      feeWalletWsolAta,
      LENDER_PUBKEY,
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

  // Referral fee-share accrual on the extend fee.
  try {
    const { accrueFromLoan } = await import("./referral-rewards.js");
    if (feeLamports > 0n) {
      await accrueFromLoan({
        refereeUserId: userId,
        loanDbId: loanDbRow.id,
        feeLamports,
        eventType: "extend",
      });
    }
  } catch (err) {
    console.error("[loans] referral accrual on extend failed (continuing):", err.message);
  }

  // $MAGPIE holder pool accrual on the extend fee.
  try {
    const { accrueToHolderPool } = await import("./magpie-holder-rewards.js");
    if (feeLamports > 0n) {
      await accrueToHolderPool(feeLamports);
    }
  } catch (err) {
    console.error("[loans] holder pool accrual on extend failed (continuing):", err.message);
  }

  // LP Loyalty Bonus Pool accrual on the extend fee.
  try {
    const { accrueToLpLoyaltyPool } = await import("./lp-loyalty.js");
    if (feeLamports > 0n) {
      await accrueToLpLoyaltyPool(feeLamports);
    }
  } catch (err) {
    console.error("[loans] LP loyalty accrual on extend failed (continuing):", err.message);
  }

  return { signature: sig, feeLamports: feeLamports.toString() };
}

/**
 * Persist collateral top-up in the DB.
 */
export async function recordAddCollateral(loanDbId, extraRawAmount, userId = null) {
  await query(
    `UPDATE loans
     SET collateral_amount = collateral_amount + $2::numeric,
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
     SET original_loan_amount_lamports = original_loan_amount_lamports - $2::numeric,
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
