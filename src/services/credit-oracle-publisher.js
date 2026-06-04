/**
 * Credit Oracle Publisher
 *
 * Syncs off-chain credit scores to the on-chain Credit Oracle program.
 * After each score recomputation, publishes the updated score to the
 * user's on-chain CreditScoreAccount PDA.
 *
 * This makes credit scores readable by any Solana program via CPI.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import "dotenv/config";

import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlPath = path.join(__dirname, "..", "solana", "idl", "magpie-credit-oracle.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

const CREDIT_ORACLE_PROGRAM_ID = new PublicKey(
  process.env.CREDIT_ORACLE_PROGRAM_ID || idl.address,
);

// Publish interval — batch-update scores every 5 minutes
const PUBLISH_INTERVAL = parseInt(process.env.CREDIT_PUBLISH_INTERVAL || "300", 10) * 1000;

/**
 * Load the authority keypair (same lender keypair used for the lending program).
 */
function loadAuthority() {
  if (process.env.LENDER_KEYPAIR_PATH) {
    const raw = JSON.parse(readFileSync(process.env.LENDER_KEYPAIR_PATH, "utf8"));
    return Keypair.fromSecretKey(new Uint8Array(raw));
  }
  throw new Error("LENDER_KEYPAIR_PATH not set");
}

/**
 * Derive the PDA for a wallet's credit score account.
 */
export function creditScorePda(wallet) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("credit-score"), wallet.toBuffer()],
    CREDIT_ORACLE_PROGRAM_ID,
  );
}

/**
 * Get the Anchor program instance for the credit oracle.
 */
function getCreditOracleProgram(signer) {
  const provider = new AnchorProvider(connection, new Wallet(signer), {
    commitment: "confirmed",
  });
  return new Program(idl, provider);
}

/**
 * Publish a credit score on-chain for a specific user.
 *
 * A user can hold up to 10 wallets (custodial + imports). The credit
 * score itself is computed at the USER level (one score per Telegram
 * account, aggregated across every wallet's loan history). To make
 * that aggregated reputation usable from any of the user's wallets
 * — for P2P matching, future fee discounts, or any on-chain program
 * that reads credit by signer pubkey — we publish the SAME score to
 * EACH of the user's wallet PDAs.
 *
 * Returns an array of { wallet, signature, status } — one entry per
 * wallet attempted. Status is 'ok' for new publishes, 'unchanged' if
 * we skipped a no-op write, 'no-program' if the oracle isn't deployed
 * yet, or 'error' with a message.
 */
export async function publishScoreOnChain(userId) {
  const authority = loadAuthority();
  const program = getCreditOracleProgram(authority);

  // ALL wallets for this user — not just the active one. Every wallet
  // gets the aggregated user-level score, so the user's reputation is
  // visible from whichever wallet they're signing with.
  const { rows: walletRows } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  if (walletRows.length === 0) return [];

  const { rows: [score] } = await query(
    `SELECT * FROM credit_scores WHERE user_id = $1`,
    [userId],
  );
  if (!score) return [];

  const factors = {
    repaymentHistory: Math.round(Number(score.f_repayment_history)),
    loanVolume: Math.round(Number(score.f_loan_volume)),
    accountAge: Math.round(Number(score.f_account_age)),
    collateralDiversity: Math.round(Number(score.f_collateral_diversity)),
    liquidationRatio: Math.round(Number(score.f_liquidation_ratio)),
    protocolEngagement: Math.round(Number(score.f_protocol_engagement)),
    loansScored: score.loans_scored,
  };

  const results = [];
  for (const { public_key } of walletRows) {
    const walletPk = new PublicKey(public_key);
    const [scorePda] = creditScorePda(walletPk);

    try {
      const accountInfo = await connection.getAccountInfo(scorePda);

      if (!accountInfo) {
        const sig = await program.methods
          .initializeScore(walletPk)
          .accounts({
            scoreAccount: scorePda,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" });
        console.log(`[credit-oracle] Initialized score for ${public_key}: ${sig}`);
      }

      const sig = await program.methods
        .updateScore(score.score, factors)
        .accounts({
          scoreAccount: scorePda,
          authority: authority.publicKey,
        })
        .rpc({ commitment: "confirmed" });

      console.log(`[credit-oracle] Published score ${score.score} for ${public_key}: ${sig}`);
      results.push({ wallet: public_key, signature: sig, status: "ok" });

      // Light pacing between wallets to avoid RPC rate-limit spikes for
      // power users with many wallets.
      if (walletRows.length > 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (err) {
      if (err.message?.includes("AccountNotFound") || err.message?.includes("Program")) {
        console.log(`[credit-oracle] Program not deployed yet, skipping ${public_key}`);
        results.push({ wallet: public_key, status: "no-program" });
        // No point retrying for other wallets in this batch — same program.
        break;
      }
      console.error(`[credit-oracle] Error publishing for user ${userId} wallet ${public_key}:`, err.message);
      results.push({ wallet: public_key, status: "error", message: err.message });
    }
  }
  return results;
}

/**
 * Batch publish all scores that changed since last publish.
 */
async function batchPublish() {
  try {
    // Find scores updated since last publish cycle
    const { rows: scores } = await query(
      `SELECT cs.user_id FROM credit_scores cs
       JOIN wallets w ON w.user_id = cs.user_id
       WHERE cs.updated_at > NOW() - INTERVAL '10 minutes'
       ORDER BY cs.updated_at DESC
       LIMIT 20`,
    );

    if (scores.length === 0) return;

    console.log(`[credit-oracle] Publishing ${scores.length} updated scores on-chain`);

    for (const { user_id } of scores) {
      await publishScoreOnChain(user_id);
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error("[credit-oracle] batch publish error:", err.message);
  }
}

/**
 * Start the credit oracle publisher background loop.
 */
export function startCreditOraclePublisher() {
  console.log(`[credit-oracle] Starting publisher (interval: ${PUBLISH_INTERVAL / 1000}s)`);

  // First run after 30s
  setTimeout(batchPublish, 30_000);
  setInterval(batchPublish, PUBLISH_INTERVAL);
}
