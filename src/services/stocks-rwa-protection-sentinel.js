/**
 * Stocks/RWA protection sentinel.
 *
 * Enforces a category-level invariant: every enabled mint where
 * category IN ('stock','rwa') MUST be `protected = TRUE` AND
 * `attestation_tier = 'hot'`. No exceptions.
 *
 * Why: tokenized stocks (xStocks) and RWAs have low Jupiter liquidity
 * relative to memecoins. The V4 on-chain TWAP needs 8 samples in a
 * 5-min window. The cosign-borrow JIT attestation path cannot reliably
 * burst 8 fresh samples within the borrow envelope window for a cold
 * xStock — TSLAx StalePriceAttestation incident 2026-06-19 PM proved
 * this. Memecoins are fine cold because their Jupiter routes are deep
 * and TWAP fills in seconds; xStocks/RWAs are not.
 *
 * Operator-mandated 2026-06-19 PM ("This error message should NEVER
 * happen again"). See [[feedback_stocks_rwa_always_hot_protected]].
 *
 * Runs:
 *   - On boot, before the price-attestor's first tick.
 *   - Every 5 min thereafter, in case anyone manually demotes via DB
 *     or new stocks get added with the wrong defaults.
 *
 * Any auto-promotion triggers a CRIT-DM to the operator so they see
 * the drift the moment it happens.
 */
import { query } from "../db/pool.js";
import { markCycle } from "../lib/heartbeat.js";

const PERIODIC_INTERVAL_MS = 5 * 60 * 1000;

export async function enforceStocksRwaProtection(reason = "boot") {
  let promotedCount = 0;
  let promotedDetail = [];
  try {
    const { rows } = await query(
      `UPDATE supported_mints
          SET protected = TRUE,
              attestation_tier = 'hot'
        WHERE enabled = TRUE
          AND category IN ('stock', 'rwa', 'etf', 'metal')
          AND (protected = FALSE OR attestation_tier <> 'hot')
        RETURNING symbol, category, mint`,
    );
    promotedCount = rows.length;
    promotedDetail = rows;

    if (promotedCount > 0) {
      // Audit each promotion
      for (const r of rows) {
        try {
          await query(
            `INSERT INTO supported_mints_tier_changes
               (mint, from_tier, to_tier, changed_by, reason)
             VALUES ($1, $2, 'hot', 'stocks-rwa-sentinel', $3)
             ON CONFLICT DO NOTHING`,
            [r.mint, "auto-detected", `${reason}: stocks/RWA must be hot+protected`],
          );
        } catch {
          // Audit failure is non-fatal — the protection write already landed.
        }
      }

      const detail = rows
        .map((r) => `${r.symbol} (${r.category})`)
        .join(", ");
      console.warn(
        `[stocks-rwa-sentinel] ${reason} auto-promoted ${promotedCount} mint(s): ${detail}`,
      );

      // CRIT-DM the operator so drift is visible immediately
      try {
        const { notifyAdmin } = await import("./admin-notify.js");
        await notifyAdmin(
          `CRIT [stocks-rwa-sentinel] ${reason} auto-promoted ${promotedCount} stock/RWA mint(s) to hot+protected: ${detail}. ` +
            `These categories MUST stay hot+protected — JIT attestation cannot fill the TWAP window for low-liquidity xStocks.`,
        );
      } catch {
        // Notification failure is non-fatal.
      }
    }
  } catch (err) {
    console.warn(
      `[stocks-rwa-sentinel] ${reason} threw: ${err.message?.slice(0, 200)}`,
    );
  }
  return { promotedCount, promotedDetail };
}

export function startStocksRwaProtectionSentinel() {
  console.log(
    "[stocks-rwa-sentinel] starting — boot enforcement now, then every 5 min",
  );
  // markCycle on each successful enforcement → provable "doing its job" on
  // /api/v1/health heartbeats (audit 2026-06-28 P2). Reported only, does not
  // gate overall health status. enforceStocksRwaProtection never throws.
  enforceStocksRwaProtection("boot").then(() => markCycle("stocks-rwa-sentinel"));
  setInterval(
    () => enforceStocksRwaProtection("periodic").then(() => markCycle("stocks-rwa-sentinel")),
    PERIODIC_INTERVAL_MS,
  );
}
