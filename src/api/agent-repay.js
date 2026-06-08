/**
 * POST /api/v1/agent/build-repay
 *
 * Agent-native repay flow. Lets an AI agent (or any non-TG, non-site
 * caller) build an unsigned repay tx that the agent signs with its
 * own wallet and submits directly to the chain.
 *
 * Unlike the borrow flow, repay does NOT require the lender authority
 * to co-sign — the on-chain program's `repay_loan` ix only needs the
 * borrower's signature. So after this endpoint returns the unsigned
 * tx, the agent just signs and submits via standard Solana RPC. No
 * cosign-borrow round-trip needed.
 *
 * Body:
 *   {
 *     borrower_wallet:  string (Solana pubkey, base58)
 *     loan_pda:         string (the loan account PDA — get from build-borrow
 *                                or from /api/v1/wallet/:wallet/loans)
 *   }
 *
 * Auth: X-Internal-Token (same shared secret as build-borrow).
 *
 * Security gates:
 *   - INTERNAL_API_TOKEN required
 *   - Verifies on-chain that borrower_wallet IS the loan's actual borrower
 *     (the on-chain account is authoritative — no spoofing)
 *   - Refuses if loan.status != 'active' (already repaid/liquidated)
 *   - Refuses if loan.suspended = TRUE (exploit-flagged, don't help
 *     attacker reclaim collateral)
 *   - Reads LIVE on-chain repay_amount (handles post-partial-repay state)
 *
 * Returns: { ok, partial_signed_tx_b64, summary, next_step }
 */
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
import {
  chooseProgramIdForLoan,
  getProgramForSigner,
} from "../solana/program.js";
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
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function getMintTokenProgram(mintStr) {
  const info = await connection.getAccountInfo(new PublicKey(mintStr));
  if (!info) throw new Error(`Mint ${mintStr} not found on-chain`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function handleAgentBuildRepay(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }
  if (process.env.AGENT_API_DISABLED === "true") {
    return { status: 503, body: { error: "Agent API temporarily disabled" } };
  }
  if (!INTERNAL_API_TOKEN) {
    console.error("[agent/build-repay] INTERNAL_API_TOKEN not configured");
    return { status: 500, body: { error: "Agent API not configured (server-side)" } };
  }
  const auth = req.headers["x-internal-token"] || req.headers["authorization"] || "";
  const presented = String(auth).replace(/^Bearer\s+/i, "");
  if (presented !== INTERNAL_API_TOKEN) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }
  const { borrower_wallet, loan_pda } = body ?? {};
  if (!borrower_wallet || !loan_pda) {
    return {
      status: 400,
      body: { error: "missing_params", required: ["borrower_wallet", "loan_pda"] },
    };
  }
  let borrowerPk, loanPdaPk;
  try {
    borrowerPk = new PublicKey(borrower_wallet);
    loanPdaPk = new PublicKey(loan_pda);
  } catch {
    return { status: 400, body: { error: "invalid_pubkey" } };
  }

  // DB lookup — find this loan + verify status/suspended
  const { rows: loanRows } = await query(
    `SELECT id, loan_id, loan_pda, collateral_mint, status, suspended, program_id, borrower_wallet
       FROM loans
      WHERE loan_pda = $1
      LIMIT 1`,
    [loan_pda],
  );
  if (!loanRows.length) {
    return { status: 404, body: { error: "loan_not_found", detail: "no DB record for this loan_pda" } };
  }
  const loan = loanRows[0];
  if (loan.status !== "active") {
    return {
      status: 409,
      body: { error: "loan_not_active", current_status: loan.status, detail: "Loan must be active to repay (already repaid/liquidated/closed)" },
    };
  }
  if (loan.suspended) {
    return {
      status: 403,
      body: { error: "loan_suspended", detail: "This loan has been flagged by the exploit-detector and is not eligible for self-service repay. Contact support." },
    };
  }
  // If we have a stored borrower_wallet, enforce that the caller matches.
  // For older loans (pre-borrower_wallet column), fall through to the
  // on-chain check.
  if (loan.borrower_wallet && loan.borrower_wallet !== borrower_wallet) {
    return {
      status: 403,
      body: { error: "not_loan_borrower", detail: "borrower_wallet does not match this loan's borrower" },
    };
  }

  // ── Build the tx (does NOT sign; agent signs with their wallet) ──
  let txB64, repayLamportsStr;
  try {
    const programId = chooseProgramIdForLoan(loan);
    const dummySigner = Keypair.generate();
    const program = getProgramForSigner(dummySigner, programId);

    // Verify on-chain borrower matches the request — this is the
    // authoritative check (DB borrower_wallet is a convenience column).
    const onChainLoan = await program.account.loan.fetch(loanPdaPk);
    if (!onChainLoan.borrower.equals(borrowerPk)) {
      return {
        status: 403,
        body: { error: "not_loan_borrower_onchain", detail: "borrower_wallet does not match the on-chain loan.borrower" },
      };
    }

    // Use LIVE on-chain repay_amount (handles partial repay state)
    const repayLamports = BigInt(onChainLoan.repayAmount.toString());
    repayLamportsStr = repayLamports.toString();

    const collateralMintPk = new PublicKey(loan.collateral_mint);
    const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
    const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);
    const [collateralVault] = collateralVaultPda(loanPdaPk, programId);

    const collateralTokenProgram = await getMintTokenProgram(loan.collateral_mint);
    const loanTokenProgram = TOKEN_PROGRAM_ID;

    const borrowerCollateralAta = getAssociatedTokenAddressSync(
      collateralMintPk, borrowerPk, false, collateralTokenProgram,
    );
    const borrowerWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, borrowerPk, false, loanTokenProgram,
    );

    // Same pre/post ix pattern as executeRepay: create ATAs idempotently,
    // wrap SOL→wSOL with exact repay amount, sync, then close ATA after.
    const preIxs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        borrowerPk, borrowerCollateralAta, borrowerPk, collateralMintPk, collateralTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        borrowerPk, borrowerWsolAta, borrowerPk, NATIVE_MINT, loanTokenProgram,
      ),
      SystemProgram.transfer({
        fromPubkey: borrowerPk,
        toPubkey: borrowerWsolAta,
        lamports: repayLamports,
      }),
      createSyncNativeInstruction(borrowerWsolAta, loanTokenProgram),
    ];
    const postIxs = [
      createCloseAccountInstruction(
        borrowerWsolAta, borrowerPk, borrowerPk, [], loanTokenProgram,
      ),
    ];

    const ix = await program.methods
      .repayLoan()
      .accounts({
        pool: lendingPool,
        loanTokenVault,
        loan: loanPdaPk,
        collateralMint: collateralMintPk,
        collateralVault,
        borrowerCollateralAccount: borrowerCollateralAta,
        borrowerLoanTokenAccount: borrowerWsolAta,
        borrower: borrowerPk,
        tokenProgram: collateralTokenProgram,
        loanTokenProgram,
      })
      .preInstructions(preIxs)
      .postInstructions(postIxs)
      .instruction();

    const tx = new Transaction();
    tx.add(...preIxs, ix, ...postIxs);
    tx.feePayer = borrowerPk;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    txB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch (err) {
    console.error("[agent/build-repay] tx build failed:", err);
    return { status: 500, body: { error: "tx_build_failed", detail: err.message?.slice(0, 200) } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      partial_signed_tx_b64: txB64,
      summary: {
        loan_id: loan.loan_id,
        loan_pda,
        repay_lamports: repayLamportsStr,
        repay_sol: Number(repayLamportsStr) / 1e9,
      },
      next_step:
        "Sign partial_signed_tx_b64 with borrower_wallet's private key, then submit directly via Solana RPC (sendTransaction). Repay does NOT require lender authority; the agent's signature alone is sufficient. After confirmation, the collateral is returned to the borrower's wallet.",
    },
  };
}
