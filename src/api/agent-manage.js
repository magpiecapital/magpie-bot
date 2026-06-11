/**
 * Agent loan-management endpoints.
 *
 *   POST /api/v1/agent/build-extend         — extend loan term
 *   POST /api/v1/agent/build-topup          — add collateral
 *   POST /api/v1/agent/build-partial-repay  — pay down PART of the loan
 *
 * All three:
 *   - Require X-Internal-Token (same as build-borrow / build-repay)
 *   - Verify on-chain that the requester's borrower_wallet matches
 *     the loan's actual borrower
 *   - Refuse suspended loans (exploit-detector flagged)
 *   - Refuse already-repaid/liquidated loans
 *   - Return an unsigned tx the agent signs + submits directly
 *
 * Like build-repay, NONE of these require lender authority co-signing.
 * The on-chain program's extend/add-collateral/partial-repay ixs are
 * all borrower-only.
 */
import { constantTimeEqual } from "./auth-utils.js";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { chooseProgramIdForLoan, getProgramForSigner } from "../solana/program.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";
import { rejectIfLocked } from "../services/site-lock.js";
import {
  lendingPoolPda,
  loanTokenVaultPda,
  collateralVaultPda,
} from "../solana/pdas.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function getMintTokenProgram(mintStr) {
  const info = await connection.getAccountInfo(new PublicKey(mintStr));
  if (!info) throw new Error(`Mint ${mintStr} not found on-chain`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Shared front-door for all three endpoints. Validates auth, body,
 * and on-chain borrower match. Returns either:
 *   { error: <response object> }      — caller should return it
 *   { loan, programId, onChainLoan, borrowerPk, loanPdaPk, program }
 *
 * loan is the DB row.
 */
async function commonPreflight(req, requiredFields = []) {
  if (req.method !== "POST") {
    return { error: { status: 405, body: { error: "POST only" } } };
  }
  if (process.env.AGENT_API_DISABLED === "true") {
    return { error: { status: 503, body: { error: "Agent API temporarily disabled" } } };
  }
  // Protocol-wide pause check (defense-in-depth alongside the
  // AGENT_API_DISABLED env var). If the operator pauses the whole
  // site during an incident, agent endpoints pause too — otherwise
  // an exploit could continue draining via the agent path.
  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return { error: globalReject };
  if (!INTERNAL_API_TOKEN) {
    return { error: { status: 500, body: { error: "Agent API not configured (server-side)" } } };
  }
  const auth = req.headers["x-internal-token"] || req.headers["authorization"] || "";
  const presented = String(auth).replace(/^Bearer\s+/i, "");
  if (!constantTimeEqual(presented, INTERNAL_API_TOKEN)) {
    return { error: { status: 401, body: { error: "unauthorized" } } };
  }

  let body;
  try { body = await readJsonBody(req); }
  catch { return { error: { status: 400, body: { error: "Invalid JSON body" } } }; }

  for (const f of requiredFields) {
    if (!body[f]) {
      return {
        error: { status: 400, body: { error: "missing_params", required: requiredFields } },
      };
    }
  }
  let borrowerPk, loanPdaPk;
  try {
    borrowerPk = new PublicKey(body.borrower_wallet);
    loanPdaPk = new PublicKey(body.loan_pda);
  } catch {
    return { error: { status: 400, body: { error: "invalid_pubkey" } } };
  }

  const { rows: loanRows } = await query(
    `SELECT id, loan_id, loan_pda, collateral_mint, collateral_amount, status, suspended,
            program_id, borrower_wallet, ltv_percentage, original_loan_amount_lamports,
            duration_days
       FROM loans WHERE loan_pda = $1 LIMIT 1`,
    [body.loan_pda],
  );
  if (!loanRows.length) {
    return { error: { status: 404, body: { error: "loan_not_found" } } };
  }
  const loan = loanRows[0];
  if (loan.status !== "active") {
    return { error: { status: 409, body: { error: "loan_not_active", current_status: loan.status } } };
  }
  if (loan.suspended) {
    return { error: { status: 403, body: { error: "loan_suspended" } } };
  }
  if (loan.borrower_wallet && loan.borrower_wallet !== body.borrower_wallet) {
    return { error: { status: 403, body: { error: "not_loan_borrower" } } };
  }

  // Per-user lock check (defense-in-depth). If the operator locked
  // this user during an investigation (via /lock_user), they
  // shouldn't be able to extend/topup/partial-repay via the agent
  // path either. Mirrors what cosign-borrow does.
  if (loan.borrower_wallet) {
    const { rows: [walletRow] } = await query(
      `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
      [loan.borrower_wallet],
    );
    if (walletRow?.user_id) {
      const lockReject = await rejectIfLocked(walletRow.user_id);
      if (lockReject) return { error: lockReject };
    }
  }

  const programId = chooseProgramIdForLoan(loan);
  const dummySigner = Keypair.generate();
  const program = getProgramForSigner(dummySigner, programId);
  const onChainLoan = await program.account.loan.fetch(loanPdaPk);
  if (!onChainLoan.borrower.equals(borrowerPk)) {
    return { error: { status: 403, body: { error: "not_loan_borrower_onchain" } } };
  }

  return { body, loan, programId, program, onChainLoan, borrowerPk, loanPdaPk };
}

async function finalizeAndReturn(tx, borrowerPk, summary, nextStep) {
  tx.feePayer = borrowerPk;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const txB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return { status: 200, body: { ok: true, partial_signed_tx_b64: txB64, summary, next_step: nextStep } };
}

// ─────────────────────────── EXTEND ───────────────────────────

export async function handleAgentBuildExtend(req) {
  const pre = await commonPreflight(req, ["borrower_wallet", "loan_pda"]);
  if (pre.error) return pre.error;
  const { loan, program, onChainLoan, borrowerPk, loanPdaPk, programId } = pre;

  try {
    const loanTokenProgram = TOKEN_PROGRAM_ID;
    const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
    const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);

    const borrowerWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, borrowerPk, false, loanTokenProgram);
    const feeWalletWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, LENDER_PUBKEY, false, loanTokenProgram);

    // Fee = tier-dependent % of current OWED (live on-chain).
    const ltv = loan.ltv_percentage;
    const feeBps = ltv >= 30 ? 300n : ltv >= 25 ? 200n : 150n;
    const owedLive = BigInt(onChainLoan.repayAmount.toString());
    const feeLamports = (owedLive * feeBps) / 10_000n;

    const preIxs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      createAssociatedTokenAccountIdempotentInstruction(borrowerPk, borrowerWsolAta, borrowerPk, NATIVE_MINT, loanTokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(borrowerPk, feeWalletWsolAta, LENDER_PUBKEY, NATIVE_MINT, loanTokenProgram),
      SystemProgram.transfer({ fromPubkey: borrowerPk, toPubkey: borrowerWsolAta, lamports: feeLamports }),
      createSyncNativeInstruction(borrowerWsolAta, loanTokenProgram),
    ];
    const postIxs = [
      createCloseAccountInstruction(borrowerWsolAta, borrowerPk, borrowerPk, [], loanTokenProgram),
    ];

    const ix = await program.methods
      .extendLoan()
      .accounts({
        pool: lendingPool,
        loanTokenVault,
        loan: loanPdaPk,
        borrowerLoanTokenAccount: borrowerWsolAta,
        feeWalletTokenAccount: feeWalletWsolAta,
        borrower: borrowerPk,
        loanTokenProgram,
      })
      .preInstructions(preIxs).postInstructions(postIxs).instruction();

    const tx = new Transaction(); tx.add(...preIxs, ix, ...postIxs);
    return await finalizeAndReturn(tx, borrowerPk, {
      loan_id: loan.loan_id,
      loan_pda: loan.loan_pda,
      extend_fee_lamports: feeLamports.toString(),
      extend_fee_sol: Number(feeLamports) / 1e9,
      extends_by_days: loan.duration_days,
    }, "Sign with borrower_wallet and submit directly. Extends the loan by its original duration; if past due, clock resets from now.");
  } catch (err) {
    console.error("[agent/build-extend] failed:", err);
    return { status: 500, body: { error: "tx_build_failed", detail: err.message?.slice(0, 200) } };
  }
}

// ─────────────────────────── TOPUP ───────────────────────────

export async function handleAgentBuildTopup(req) {
  const pre = await commonPreflight(req, ["borrower_wallet", "loan_pda", "extra_collateral_amount"]);
  if (pre.error) return pre.error;
  const { body, loan, program, borrowerPk, loanPdaPk, programId } = pre;
  if (!/^\d+$/.test(String(body.extra_collateral_amount))) {
    return { status: 400, body: { error: "extra_collateral_amount must be a u64 string in raw units" } };
  }

  try {
    const collateralMintPk = new PublicKey(loan.collateral_mint);
    const [collateralVault] = collateralVaultPda(loanPdaPk, programId);
    const collateralTokenProgram = await getMintTokenProgram(loan.collateral_mint);
    const borrowerCollateralAta = getAssociatedTokenAddressSync(collateralMintPk, borrowerPk, false, collateralTokenProgram);

    const preIxs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ];

    const ix = await program.methods
      .addCollateral(new BN(body.extra_collateral_amount))
      .accounts({
        loan: loanPdaPk,
        collateralMint: collateralMintPk,
        collateralVault,
        borrowerCollateralAccount: borrowerCollateralAta,
        borrower: borrowerPk,
        tokenProgram: collateralTokenProgram,
      })
      .preInstructions(preIxs).instruction();

    const tx = new Transaction(); tx.add(...preIxs, ix);
    return await finalizeAndReturn(tx, borrowerPk, {
      loan_id: loan.loan_id,
      loan_pda: loan.loan_pda,
      extra_collateral_raw: String(body.extra_collateral_amount),
    }, "Sign with borrower_wallet and submit directly. Adds collateral to the loan, lowering liquidation risk.");
  } catch (err) {
    console.error("[agent/build-topup] failed:", err);
    return { status: 500, body: { error: "tx_build_failed", detail: err.message?.slice(0, 200) } };
  }
}

// ───────────────────────── PARTIAL REPAY ─────────────────────────

export async function handleAgentBuildPartialRepay(req) {
  const pre = await commonPreflight(req, ["borrower_wallet", "loan_pda", "repay_lamports"]);
  if (pre.error) return pre.error;
  const { body, loan, program, onChainLoan, borrowerPk, loanPdaPk, programId } = pre;

  let repayLamports;
  try { repayLamports = BigInt(String(body.repay_lamports)); }
  catch { return { status: 400, body: { error: "repay_lamports must be a u64 string" } }; }

  if (repayLamports <= 0n) {
    return { status: 400, body: { error: "repay_lamports must be positive" } };
  }
  const owedLive = BigInt(onChainLoan.repayAmount.toString());
  if (repayLamports >= owedLive) {
    return {
      status: 400,
      body: {
        error: "use_full_repay_instead",
        detail: `repay_lamports (${repayLamports}) >= current owed (${owedLive}). Use POST /api/v1/agent/build-repay for full repayment.`,
      },
    };
  }

  try {
    const loanTokenProgram = TOKEN_PROGRAM_ID;
    const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
    const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);
    const borrowerWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, borrowerPk, false, loanTokenProgram);

    const preIxs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      createAssociatedTokenAccountIdempotentInstruction(borrowerPk, borrowerWsolAta, borrowerPk, NATIVE_MINT, loanTokenProgram),
      SystemProgram.transfer({ fromPubkey: borrowerPk, toPubkey: borrowerWsolAta, lamports: repayLamports }),
      createSyncNativeInstruction(borrowerWsolAta, loanTokenProgram),
    ];
    const postIxs = [
      createCloseAccountInstruction(borrowerWsolAta, borrowerPk, borrowerPk, [], loanTokenProgram),
    ];

    const ix = await program.methods
      .partialRepay(new BN(repayLamports.toString()))
      .accounts({
        pool: lendingPool,
        loanTokenVault,
        loan: loanPdaPk,
        borrowerLoanTokenAccount: borrowerWsolAta,
        borrower: borrowerPk,
        loanTokenProgram,
      })
      .preInstructions(preIxs).postInstructions(postIxs).instruction();

    const tx = new Transaction(); tx.add(...preIxs, ix, ...postIxs);
    return await finalizeAndReturn(tx, borrowerPk, {
      loan_id: loan.loan_id,
      loan_pda: loan.loan_pda,
      repay_lamports: repayLamports.toString(),
      repay_sol: Number(repayLamports) / 1e9,
      owed_before: owedLive.toString(),
      owed_after: (owedLive - repayLamports).toString(),
    }, "Sign with borrower_wallet and submit directly. Reduces principal owed; collateral remains locked until full repayment.");
  } catch (err) {
    console.error("[agent/build-partial-repay] failed:", err);
    return { status: 500, body: { error: "tx_build_failed", detail: err.message?.slice(0, 200) } };
  }
}
