/**
 * Single canonical "payable owed" across the reward pools.
 *
 * Imported by distribution-auto-funder, distribution-gap-monitor, and the
 * TG /stats display so DISPLAY == MONITORED == FUNDED — no gross-vs-net drift.
 *
 * payableOwed = holderOwed + lpThirdPartyNet — the ONLY two pools that pay
 * OUT of CHCAM and decrement on payout. LP uses the THIRD-PARTY-NET figure
 * (operator-exempt seed removed from BOTH the numerator AND the denominator, as
 * of 2026-07-04) so the third-party LPs split the FULL pool and the funded
 * native exactly matches what actually leaves CHCAM and what every surface
 * shows. protocol_reserve + referrals are EXCLUDED — they never pay out of CHCAM.
 *
 * One single-snapshot SQL read so the three independently-timed callers can't
 * tear across a concurrent pool decrement.
 *
 * See feedback_lender_wallet_exempt_from_lp_loyalty +
 * feedback_distribution_wallet_must_be_auto_funded (pre-distribution protocol).
 */
import { query } from "../db/pool.js";

/**
 * @returns {Promise<{holderOwed: bigint, lpOwed: bigint, lpGross: bigint,
 *                     protocolOwed: bigint, payableOwed: bigint}>}
 *   lpOwed is the THIRD-PARTY-NET payable LP figure (what leaves CHCAM).
 *   lpGross is the raw pool accrual (operator seed included) — audit only.
 */
export async function readPayableOwed() {
  let holderOwed = 0n;
  try {
    const { rows } = await query(
      `SELECT COALESCE(accrued_lamports, 0)::text AS amt FROM magpie_holder_pool WHERE id = 1`,
    );
    holderOwed = BigInt(rows[0]?.amt || 0);
  } catch {
    holderOwed = 0n; // table absent in old deploys → treat as 0
  }

  // LP gross + third-party-NET in ONE query. gross pool × (non-exempt weight /
  // non-exempt weight) = the FULL pool to the third-party LPs (exempt seed
  // excluded from both sides), weight = shares × seconds_held.
  let lpGross = 0n;
  let lpThirdPartyNet = 0n;
  try {
    const { rows: [r] } = await query(
      `SELECT
         COALESCE((SELECT accrued_lamports FROM lp_loyalty_pool WHERE id = 1), 0)::bigint::text AS gross,
         COALESCE(
           (SELECT accrued_lamports FROM lp_loyalty_pool WHERE id = 1)::numeric
           * COALESCE(
               (SELECT SUM(shares * EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)))
                  FROM lp_positions
                 WHERE shares > 0 AND EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)) > 0
                   AND wallet_address NOT IN (SELECT wallet_address FROM lp_loyalty_exempt_wallets))
               / NULLIF(
               (SELECT SUM(shares * EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)))
                  FROM lp_positions
                 WHERE shares > 0 AND EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)) > 0
                   AND wallet_address NOT IN (SELECT wallet_address FROM lp_loyalty_exempt_wallets)), 0)
             , 1)
         , 0)::bigint::text AS net`,
    );
    lpGross = BigInt(r?.gross || 0);
    lpThirdPartyNet = BigInt(r?.net || 0);
  } catch {
    lpGross = 0n;
    lpThirdPartyNet = 0n;
  }

  let protocolOwed = 0n;
  try {
    const { rows } = await query(
      `SELECT COALESCE(accrued_lamports, 0)::text AS amt FROM protocol_reserve_pool WHERE id = 1`,
    );
    protocolOwed = BigInt(rows[0]?.amt || 0);
  } catch {
    protocolOwed = 0n;
  }

  return {
    holderOwed,
    lpOwed: lpThirdPartyNet, // the payable (third-party-NET) LP figure
    lpGross, // raw pool accrual incl. operator seed — audit/visibility only
    protocolOwed, // reported only; never funded into CHCAM
    payableOwed: holderOwed + lpThirdPartyNet,
  };
}
