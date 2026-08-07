/**
 * Derivation of the two V4.1 conversion caps (Sec3 Q-04).
 *
 * Deliberately in its own module with NO imports. The instruction builders need
 * @solana/web3.js; this arithmetic does not, and keeping it separate means the
 * guard script can verify it without installing anything — a check that can't
 * be skipped because a lockfile broke is worth more than a tidier file tree.
 *
 *   max_slice_bps — the most a SINGLE fire may take
 *   total_bps     — the most ALL fires may take under one arming
 *
 * A laddered exit fires several legs under one arming, so per-fire is the
 * LARGEST leg and total is the SUM. Collapsing them would cap a ladder at its
 * largest leg: a 70/20/10 take-profit ladder needs a 70% per-fire cap but 100%
 * of total authorization, so leg 2 would be refused on-chain.
 */

const BPS_MAX = 10_000;

/**
 * @param {Array<{slicePct:number}>} legs one entry per ladder leg; a single
 *        take-profit or stop-loss is just a one-leg ladder.
 * @returns {{maxSliceBps:number, totalBps:number}}
 */
export function deriveArmingCaps(legs) {
  if (!Array.isArray(legs) || legs.length === 0) {
    throw new Error("arming: at least one leg is required");
  }

  const bps = legs.map((l, i) => {
    const pct = Number(l?.slicePct);
    if (!Number.isFinite(pct) || pct <= 0) {
      throw new Error(`arming: leg ${i + 1} has a non-positive slice`);
    }
    // Percent → bps. Round rather than truncate so a leg can't quietly shrink.
    return Math.round(pct * 100);
  });

  const totalBps = bps.reduce((a, b) => a + b, 0);
  const maxSliceBps = Math.max(...bps);

  if (totalBps > BPS_MAX) {
    throw new Error(
      `arming: legs sum to ${totalBps / 100}% — cannot exceed 100% of the original collateral`,
    );
  }
  // Invariant the program also enforces; assert here so a bad spec fails in the
  // bot with a readable message instead of as an opaque on-chain error.
  if (maxSliceBps > totalBps) {
    throw new Error("arming: per-fire cap cannot exceed the total authorization");
  }

  return { maxSliceBps, totalBps };
}
