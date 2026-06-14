/**
 * Referral fee-share rewards.
 *
 * Economics: 5% of every loan fee (REFERRAL_REWARD_BPS=500) accrues to the
 * referrer who brought in the borrower. Sourced from the protocol's 20%
 * fee slice — LPs are unaffected. Tracked off-chain in `referral_earnings`;
 * paid out in SOL via /claim from the lender wallet.
 *
 * Anti-abuse:
 *   - Self-referral is blocked at attribution time (services/referrals.js).
 *   - Loans below MIN_LOAN_LAMPORTS don't accrue (filters dust farming).
 *   - Claims below MIN_CLAIM_LAMPORTS are rejected (avoids dust payouts).
 *   - UNIQUE(loan_db_id, event_type) on the table makes accrual idempotent
 *     even if a recordLoan retry slips through.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import { getRewardsDistributorKeypair } from "./distributor-keypair.js";
import { getRuntimeConfigBps } from "./runtime-config.js";

// Fallback used when governance_config.referral_reward_bps can't be
// read (DB outage or unset key). MGP-001 ratified the live value to
// 1000 (10%); the runtime reader takes precedence.
export const REFERRAL_REWARD_BPS_FALLBACK = 1_000; // 10%
export const REFERRAL_REWARD_BPS = REFERRAL_REWARD_BPS_FALLBACK;

/**
 * Read the LIVE referral reward bps from governance_config. Mirrors
 * getHolderRewardBps / getLpLoyaltyRewardBps. Any governance vote that
 * changes referral_reward_bps takes effect within runtime-config TTL.
 */
export async function getReferralRewardBps() {
  return getRuntimeConfigBps("referral_reward_bps", REFERRAL_REWARD_BPS_FALLBACK);
}
export const MIN_LOAN_LAMPORTS = 10_000_000n; // 0.01 SOL minimum to accrue
export const MIN_CLAIM_LAMPORTS = 5_000_000n; // 0.005 SOL minimum to claim
export const MIN_LENDER_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL safety floor on lender

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Record a referral reward for a fee-bearing loan event, IF the borrower
 * was referred. Idempotent via UNIQUE(loan_db_id, event_type).
 *
 * Called from recordLoan() and executeExtendLoan() — anywhere a fee is
 * charged on a loan. Safe to call when the borrower has no referrer
 * (silently no-ops).
 */
export async function accrueFromLoan({ refereeUserId, loanDbId, feeLamports, eventType }) {
  const fee = BigInt(feeLamports);
  // Compute net loan amount from the fee: feeBps assumed ≤ 300, so reverse-mapping
  // isn't necessary — we have the fee directly. But filter dust loans:
  // we approximate "loan size" as fee * 100 (since min fee is 1.5%); a 0.01 SOL
  // loan generates ≥0.00015 SOL fee. So reward floor is ~7,500 lamports.
  // We'll instead enforce a fee floor directly: skip fees under 50_000 lamports
  // (= reward of 2,500 lamports), which corresponds to loans ≲ 0.0033 SOL.
  if (fee < 50_000n) return null;

  // Look up referrer; bail out if borrower wasn't referred.
  const { rows } = await query(
    `SELECT referred_by FROM users WHERE id = $1`,
    [refereeUserId],
  );
  const referrerId = rows[0]?.referred_by;
  if (!referrerId) return null;

  const liveBps = await getReferralRewardBps();
  const reward = (fee * BigInt(liveBps)) / 10_000n;
  if (reward <= 0n) return null;

  try {
    const r = await query(
      `INSERT INTO referral_earnings
         (referrer_user_id, referee_user_id, loan_db_id, event_type,
          fee_lamports, reward_lamports, reward_bps, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'accrued')
       ON CONFLICT (loan_db_id, event_type) DO NOTHING
       RETURNING id`,
      [referrerId, refereeUserId, loanDbId, eventType, fee.toString(), reward.toString(), liveBps],
    );
    return r.rows[0]?.id ?? null;
  } catch (err) {
    // Don't let a referral DB error torpedo the loan recording flow.
    console.error("[referrals] accrual failed:", err.message);
    return null;
  }
}

/**
 * Summary view for /refer command:
 *   - referral code
 *   - number of users referred + how many of them have borrowed
 *   - lifetime earned (accrued + paid)
 *   - already-paid
 *   - claimable now
 */
export async function getReferralSummary(userId) {
  const [codeRow, referredCount, borrowedCount, totals] = await Promise.all([
    query(`SELECT code FROM referral_codes WHERE user_id = $1`, [userId]),
    query(`SELECT COUNT(*)::int AS n FROM users WHERE referred_by = $1`, [userId]),
    query(
      `SELECT COUNT(DISTINCT referee_user_id)::int AS n
         FROM referral_earnings WHERE referrer_user_id = $1`,
      [userId],
    ),
    query(
      `SELECT
         COALESCE(SUM(reward_lamports)::numeric, 0)::text AS lifetime,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS paid,
         COALESCE(SUM(CASE WHEN status = 'accrued' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS claimable
       FROM referral_earnings WHERE referrer_user_id = $1`,
      [userId],
    ),
  ]);

  return {
    code: codeRow.rows[0]?.code ?? null,
    referred_count: referredCount.rows[0]?.n ?? 0,
    borrowed_count: borrowedCount.rows[0]?.n ?? 0,
    lifetime_lamports: BigInt(totals.rows[0]?.lifetime ?? "0"),
    paid_lamports: BigInt(totals.rows[0]?.paid ?? "0"),
    claimable_lamports: BigInt(totals.rows[0]?.claimable ?? "0"),
  };
}

/**
 * Same as getReferralSummary, but looked up by wallet pubkey. Used by the
 * site dashboard to display referral stats next to a connected wallet.
 *
 * Returns null if the wallet isn't tied to any bot user.
 */
export async function getReferralSummaryByWallet(walletAddress) {
  if (!walletAddress) return null;
  const r = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [walletAddress],
  );
  if (r.rows.length === 0) return null;
  return getReferralSummary(r.rows[0].user_id);
}

/**
 * Atomically claim accrued referral earnings. Locks the rows, sends SOL
 * from lender wallet → recipient, marks rows paid with the tx signature.
 *
 * On any failure (transient RPC, lender low, etc.), the locked rows are
 * rolled back — so the user can retry without losing earnings.
 */
export async function claimReferralEarnings({ userId, recipientPublicKey }) {
  if (!recipientPublicKey) throw new Error("No recipient wallet");

  // Snapshot the claimable rows. Lock them so a concurrent claim
  // can't double-spend.
  const client = await (await import("../db/pool.js")).pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, reward_lamports
         FROM referral_earnings
        WHERE referrer_user_id = $1 AND status = 'accrued'
        FOR UPDATE SKIP LOCKED`,
      [userId],
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "nothing_to_claim" };
    }

    const total = rows.reduce((acc, r) => acc + BigInt(r.reward_lamports), 0n);
    if (total < MIN_CLAIM_LAMPORTS) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "below_minimum",
        accrued_lamports: total,
        minimum_lamports: MIN_CLAIM_LAMPORTS,
      };
    }

    // Verify the rewards distributor wallet can cover payout + small
    // safety reserve. Reads REWARDS_DISTRIBUTOR_PRIVATE_KEY if set,
    // falls back to LENDER_PRIVATE_KEY for backward-compat during
    // rollout.
    const distributor = getRewardsDistributorKeypair();
    const distributorBalance = BigInt(await connection.getBalance(distributor.publicKey));
    if (distributorBalance < total + MIN_LENDER_RESERVE_LAMPORTS) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "treasury_low",
        treasury_lamports: distributorBalance,
        required_lamports: total,
      };
    }

    // Send the payout. Plain SystemProgram.transfer — recipient receives
    // native SOL straight to their wallet.
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: distributor.publicKey,
        toPubkey: new PublicKey(recipientPublicKey),
        lamports: total,
      }),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [distributor], {
      commitment: "confirmed",
    });

    // Mark all locked rows paid with this signature.
    await client.query(
      `UPDATE referral_earnings
          SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2
        WHERE id = ANY($1::bigint[])`,
      [rows.map((r) => r.id), signature],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      signature,
      paid_lamports: total,
      row_count: rows.length,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
