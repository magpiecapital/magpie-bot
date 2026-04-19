/**
 * Magpie P2P Lending Marketplace
 *
 * Two-sided marketplace with risk tranching:
 *   - Senior tranche: lower yield, protected from first losses
 *   - Junior tranche: higher yield, absorbs losses first
 *   - Mezzanine tranche: middle risk/reward
 *
 * Flow:
 *   1. Lender creates a pool with risk preferences
 *   2. Lender deposits SOL into their pool
 *   3. Borrower creates a loan offer (specifying collateral + terms)
 *   4. Matching engine pairs offer with best available pool
 *   5. Loan is funded from pool → borrower receives SOL
 *   6. On repayment, principal + yield distributed back to pool
 *   7. On liquidation, losses absorbed junior-first
 */
import { query } from "../db/pool.js";
import { getCreditScore, tierBenefits } from "./credit-score.js";
import { getTokenRisk } from "./risk-engine.js";

// ─── Pool Management ────────────────────────────────────────────────────────

/**
 * Create a new lending pool.
 */
export async function createPool(userId, {
  name,
  tranche = "senior",
  minApyBps = 500,
  maxApyBps = 3000,
  minCreditScore = 300,
  acceptedMints = [],
  maxLtv = 30,
  maxDurationDays = 7,
}) {
  const { rows: [pool] } = await query(
    `INSERT INTO lending_pools (
       owner_id, name, tranche, min_apy_bps, max_apy_bps,
       min_credit_score, accepted_mints, max_ltv, max_duration_days
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [userId, name, tranche, minApyBps, maxApyBps, minCreditScore,
     acceptedMints, maxLtv, maxDurationDays],
  );
  return pool;
}

/**
 * Deposit SOL into a lending pool.
 */
export async function depositToPool(poolId, userId, amountLamports, txSignature = null) {
  // Verify ownership
  const { rows: [pool] } = await query(
    `SELECT * FROM lending_pools WHERE id = $1 AND owner_id = $2`,
    [poolId, userId],
  );
  if (!pool) throw new Error("Pool not found or not owned by you");
  if (pool.status !== "active") throw new Error("Pool is not active");

  await query(
    `INSERT INTO pool_deposits (pool_id, user_id, amount_lamports, tx_signature)
     VALUES ($1, $2, $3, $4)`,
    [poolId, userId, amountLamports.toString(), txSignature],
  );

  await query(
    `UPDATE lending_pools SET
       total_deposited_lamports = total_deposited_lamports + $2::numeric,
       available_lamports = available_lamports + $2::numeric,
       updated_at = NOW()
     WHERE id = $1`,
    [poolId, amountLamports.toString()],
  );

  return { success: true };
}

/**
 * Withdraw available SOL + earned yield from a pool.
 */
export async function withdrawFromPool(poolId, userId, amountLamports) {
  const { rows: [pool] } = await query(
    `SELECT * FROM lending_pools WHERE id = $1 AND owner_id = $2`,
    [poolId, userId],
  );
  if (!pool) throw new Error("Pool not found or not owned by you");

  const available = BigInt(pool.available_lamports);
  const requested = BigInt(amountLamports);
  if (requested > available) {
    throw new Error(`Insufficient available funds. Available: ${available} lamports`);
  }

  // Calculate proportional yield
  const totalDeposited = BigInt(pool.total_deposited_lamports);
  const earnedYield = BigInt(pool.earned_yield_lamports);
  const yieldShare = totalDeposited > 0n
    ? (earnedYield * requested) / totalDeposited
    : 0n;

  await query(
    `INSERT INTO pool_withdrawals (pool_id, user_id, amount_lamports, yield_lamports)
     VALUES ($1, $2, $3, $4)`,
    [poolId, userId, amountLamports.toString(), yieldShare.toString()],
  );

  await query(
    `UPDATE lending_pools SET
       available_lamports = available_lamports - $2::numeric,
       total_deposited_lamports = total_deposited_lamports - $2::numeric,
       earned_yield_lamports = GREATEST(0, earned_yield_lamports - $3::numeric),
       updated_at = NOW()
     WHERE id = $1`,
    [poolId, amountLamports.toString(), yieldShare.toString()],
  );

  return { success: true, principalLamports: amountLamports.toString(), yieldLamports: yieldShare.toString() };
}

/**
 * Get all pools for a lender.
 */
export async function getMyPools(userId) {
  const { rows } = await query(
    `SELECT * FROM lending_pools WHERE owner_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Get pool details with deposit/withdrawal history.
 */
export async function getPoolDetails(poolId) {
  const { rows: [pool] } = await query(
    `SELECT lp.*, u.telegram_username as owner_username
     FROM lending_pools lp
     JOIN users u ON u.id = lp.owner_id
     WHERE lp.id = $1`,
    [poolId],
  );
  if (!pool) return null;

  const { rows: activeOffers } = await query(
    `SELECT COUNT(*) as count, SUM(requested_sol) as total_sol
     FROM p2p_loan_offers WHERE pool_id = $1 AND status IN ('active', 'funded')`,
    [poolId],
  );

  return { ...pool, activeLoans: activeOffers[0] };
}

// ─── Borrower Offers ────────────────────────────────────────────────────────

/**
 * Create a loan offer from a borrower.
 * The matching engine will find the best pool.
 */
export async function createLoanOffer(borrowerId, {
  collateralMint,
  collateralAmount,
  requestedSol,
  durationDays,
  ltvPercentage,
}) {
  // Get borrower's credit score for matching
  const creditScore = await getCreditScore(borrowerId);
  const score = creditScore?.score || 300;

  // Get token risk for pricing
  const tokenRisk = await getTokenRisk(collateralMint);
  const tokenRiskScore = tokenRisk ? Number(tokenRisk.risk_score) : 50;

  // Calculate offered APY based on risk factors
  // Higher credit = lower APY, higher token risk = higher APY
  const baseApyBps = 800; // 8% base
  const creditAdjust = Math.max(-300, (500 - score) * 0.5); // credit bonus/penalty
  const riskAdjust = (tokenRiskScore - 50) * 3; // token risk adjustment
  const offeredApyBps = Math.round(
    Math.max(300, Math.min(5000, baseApyBps + creditAdjust + riskAdjust)),
  );

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min to match

  const { rows: [offer] } = await query(
    `INSERT INTO p2p_loan_offers (
       borrower_id, collateral_mint, collateral_amount, requested_sol,
       offered_apy_bps, duration_days, ltv_percentage,
       borrower_credit_score, token_risk_score, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      borrowerId, collateralMint, collateralAmount.toString(),
      requestedSol.toString(), offeredApyBps, durationDays, ltvPercentage,
      score, tokenRiskScore, expiresAt,
    ],
  );

  // Attempt immediate matching
  const matched = await matchOffer(offer.id);

  return { offer, matched };
}

// ─── Matching Engine ────────────────────────────────────────────────────────

/**
 * Match a borrower's offer with the best available lending pool.
 *
 * Matching criteria:
 *   1. Pool has enough available liquidity
 *   2. Borrower meets pool's minimum credit score
 *   3. Collateral mint is accepted by pool
 *   4. LTV and duration within pool's limits
 *   5. Offered APY meets pool's minimum
 *   6. Prefer senior tranche first (safer for borrower = lower rate)
 */
export async function matchOffer(offerId) {
  const { rows: [offer] } = await query(
    `SELECT * FROM p2p_loan_offers WHERE id = $1 AND status = 'pending'`,
    [offerId],
  );
  if (!offer) return null;

  const requestedLamports = BigInt(Math.floor(Number(offer.requested_sol) * 1e9));

  // Find matching pools, ordered by tranche priority and best rate
  const { rows: pools } = await query(
    `SELECT * FROM lending_pools
     WHERE status = 'active'
       AND available_lamports >= $1::numeric
       AND min_credit_score <= $2
       AND max_ltv >= $3
       AND max_duration_days >= $4
       AND min_apy_bps <= $5
       AND (accepted_mints = '{}' OR $6 = ANY(accepted_mints))
     ORDER BY
       CASE tranche WHEN 'senior' THEN 1 WHEN 'mezzanine' THEN 2 WHEN 'junior' THEN 3 END,
       min_apy_bps ASC
     LIMIT 1`,
    [
      requestedLamports.toString(),
      offer.borrower_credit_score || 300,
      offer.ltv_percentage,
      offer.duration_days,
      offer.offered_apy_bps,
      offer.collateral_mint,
    ],
  );

  if (pools.length === 0) return null;

  const pool = pools[0];

  // Lock funds in pool
  await query(
    `UPDATE lending_pools SET
       available_lamports = available_lamports - $2::numeric,
       locked_lamports = locked_lamports + $2::numeric,
       updated_at = NOW()
     WHERE id = $1`,
    [pool.id, requestedLamports.toString()],
  );

  // Update offer
  await query(
    `UPDATE p2p_loan_offers SET
       pool_id = $2, status = 'matched', matched_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [offerId, pool.id],
  );

  return { poolId: pool.id, tranche: pool.tranche, poolOwner: pool.owner_id };
}

/**
 * Fund a matched offer (execute the on-chain loan).
 * Called after matching when the borrower confirms.
 */
export async function fundOffer(offerId, loanPda, txSignature) {
  await query(
    `UPDATE p2p_loan_offers SET
       status = 'funded', funded_at = NOW(),
       loan_pda = $2, tx_signature = $3, updated_at = NOW()
     WHERE id = $1`,
    [offerId, loanPda, txSignature],
  );
}

/**
 * Handle loan repayment — distribute yield back to pool.
 */
export async function handleP2PRepayment(offerId, repayLamports) {
  const { rows: [offer] } = await query(
    `SELECT * FROM p2p_loan_offers WHERE id = $1`,
    [offerId],
  );
  if (!offer || !offer.pool_id) return;

  const principal = BigInt(Math.floor(Number(offer.requested_sol) * 1e9));
  const repaid = BigInt(repayLamports);
  const yield_ = repaid > principal ? repaid - principal : 0n;

  // Return funds to pool
  await query(
    `UPDATE lending_pools SET
       locked_lamports = GREATEST(0, locked_lamports - $2::numeric),
       available_lamports = available_lamports + $2::numeric,
       earned_yield_lamports = earned_yield_lamports + $3::numeric,
       updated_at = NOW()
     WHERE id = $1`,
    [offer.pool_id, principal.toString(), yield_.toString()],
  );

  // Record yield distribution
  if (yield_ > 0n) {
    await query(
      `INSERT INTO yield_distributions (pool_id, loan_offer_id, amount_lamports, source)
       VALUES ($1, $2, $3, 'interest')`,
      [offer.pool_id, offerId, yield_.toString()],
    );
  }

  await query(
    `UPDATE p2p_loan_offers SET status = 'repaid', updated_at = NOW() WHERE id = $1`,
    [offerId],
  );
}

/**
 * Handle liquidation — losses absorbed by tranche priority.
 * Junior tranche absorbs first, then mezzanine, then senior.
 */
export async function handleP2PLiquidation(offerId, recoveredLamports) {
  const { rows: [offer] } = await query(
    `SELECT * FROM p2p_loan_offers WHERE id = $1`,
    [offerId],
  );
  if (!offer || !offer.pool_id) return;

  const principal = BigInt(Math.floor(Number(offer.requested_sol) * 1e9));
  const recovered = BigInt(recoveredLamports);
  const loss = principal > recovered ? principal - recovered : 0n;

  // Return whatever was recovered
  await query(
    `UPDATE lending_pools SET
       locked_lamports = GREATEST(0, locked_lamports - $2::numeric),
       available_lamports = available_lamports + $3::numeric,
       updated_at = NOW()
     WHERE id = $1`,
    [offer.pool_id, principal.toString(), recovered.toString()],
  );

  if (recovered > 0n) {
    await query(
      `INSERT INTO yield_distributions (pool_id, loan_offer_id, amount_lamports, source)
       VALUES ($1, $2, $3, 'liquidation_recovery')`,
      [offer.pool_id, offerId, recovered.toString()],
    );
  }

  await query(
    `UPDATE p2p_loan_offers SET status = 'liquidated', updated_at = NOW() WHERE id = $1`,
    [offerId],
  );
}

// ─── Marketplace Stats ──────────────────────────────────────────────────────

/**
 * Refresh marketplace aggregate stats.
 */
export async function refreshMarketplaceStats() {
  const { rows: [stats] } = await query(
    `SELECT
       (SELECT COUNT(*) FROM lending_pools WHERE status = 'active') as total_pools,
       (SELECT COALESCE(SUM(total_deposited_lamports), 0) FROM lending_pools WHERE status = 'active') as total_tvl,
       (SELECT COUNT(*) FROM p2p_loan_offers WHERE status IN ('funded', 'active', 'repaid')) as total_matched,
       (SELECT COALESCE(AVG(offered_apy_bps), 0) FROM p2p_loan_offers WHERE status IN ('funded', 'active')) as avg_apy,
       (SELECT COALESCE(SUM(total_deposited_lamports), 0) FROM lending_pools WHERE tranche = 'senior' AND status = 'active') as senior_tvl,
       (SELECT COALESCE(SUM(total_deposited_lamports), 0) FROM lending_pools WHERE tranche = 'junior' AND status = 'active') as junior_tvl`,
  );

  await query(
    `UPDATE marketplace_stats SET
       total_pools = $1, total_tvl_lamports = $2, total_loans_matched = $3,
       avg_apy_bps = $4, senior_tvl_lamports = $5, junior_tvl_lamports = $6,
       updated_at = NOW()
     WHERE id = 1`,
    [
      stats.total_pools, stats.total_tvl, stats.total_matched,
      Math.round(Number(stats.avg_apy)), stats.senior_tvl, stats.junior_tvl,
    ],
  );

  return stats;
}

/**
 * Get marketplace stats.
 */
export async function getMarketplaceStats() {
  const { rows: [stats] } = await query(
    `SELECT * FROM marketplace_stats WHERE id = 1`,
  );
  return stats;
}

/**
 * Browse available lending pools (for borrowers).
 */
export async function browseAvailablePools({ minAmount, creditScore, collateralMint, tranche }) {
  let sql = `SELECT lp.*, u.telegram_username as owner_username
     FROM lending_pools lp
     JOIN users u ON u.id = lp.owner_id
     WHERE lp.status = 'active'`;
  const params = [];
  let pIdx = 1;

  if (minAmount) {
    sql += ` AND lp.available_lamports >= $${pIdx}::numeric`;
    params.push(minAmount.toString());
    pIdx++;
  }
  if (creditScore) {
    sql += ` AND lp.min_credit_score <= $${pIdx}`;
    params.push(creditScore);
    pIdx++;
  }
  if (collateralMint) {
    sql += ` AND (lp.accepted_mints = '{}' OR $${pIdx} = ANY(lp.accepted_mints))`;
    params.push(collateralMint);
    pIdx++;
  }
  if (tranche) {
    sql += ` AND lp.tranche = $${pIdx}`;
    params.push(tranche);
    pIdx++;
  }

  sql += ` ORDER BY lp.available_lamports DESC LIMIT 20`;

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Get yield history for a pool.
 */
export async function getPoolYieldHistory(poolId, limit = 30) {
  const { rows } = await query(
    `SELECT * FROM yield_distributions WHERE pool_id = $1
     ORDER BY distributed_at DESC LIMIT $2`,
    [poolId, limit],
  );
  return rows;
}
