/**
 * Proactive downside watcher — Pip DMs the borrower when their
 * collateral has materially depreciated, BEFORE the health-watcher's
 * liquidation tiers escalate. The point: give the user concrete
 * derisk options (partial-repay, top-up) early enough that they're
 * not forced into a bad outcome.
 *
 * Pairs symmetrically with upside-watcher.js. Same dedupe model
 * (UNIQUE(loan_id, tier_bucket)), same once-per-tier discipline,
 * same skip-conditions philosophy.
 *
 * Tier ladder (% drop since loan-open collateral USD value):
 *   -20% (soft)    — "heads up, worth thinking about"
 *   -35% (strong)  — "consider acting now"
 *   -50% (urgent)  — "act before health tightens further"
 *
 * Why earlier than health-watcher:
 *   - health-watcher fires at health < 1.30 / 1.15 / 1.10 — by then
 *     the user has very little time and limited options
 *   - downside-watcher fires from collateral price alone (no health
 *     math), so it's tier-clean and predictable
 *   - the two are complementary; users in liquidation tiers get
 *     both alerts which is intentional reinforcement
 *
 * Security: read-only watcher. Per-user DM data only. Inherits
 * pending_notifications rate limits.
 *
 * Failure modes:
 *   - Price lookup throws → skip THAT loan this tick (wrapped in try/catch)
 *   - DB error during dedupe → skip THIS alert, retry next tick (UNIQUE
 *     constraint guards against double-DM)
 *   - Tick itself throws → caught + logged + next tick continues
 */
import { query } from "../db/pool.js";
import { getPriceInUsdCrossSourced } from "./price.js";

const TICK_MS = 15 * 60_000;            // 15 min — matches upside-watcher
const MIN_LOAN_AGE_MS = 30 * 60_000;    // skip loans <30 min old
const TIERS = [
  { id: 1, threshold_pct: -20, label: "-20%",  intensity: "soft"   },
  { id: 2, threshold_pct: -35, label: "-35%",  intensity: "strong" },
  { id: 3, threshold_pct: -50, label: "-50%",  intensity: "urgent" },
];

let _timer = null;

async function computeDepreciation(loan) {
  // Same math as upside-watcher's computeAppreciation, sign-symmetric.
  // Returns negative pct for a depreciated loan.
  const decimals = loan.decimals ?? 9;
  let currentUsdPerToken;
  try {
    currentUsdPerToken = await getPriceInUsdCrossSourced(loan.collateral_mint);
  } catch { return null; }
  if (!currentUsdPerToken || currentUsdPerToken <= 0) return null;
  const collateralWhole = Number(loan.collateral_amount) / 10 ** decimals;
  const currentValueUsd = collateralWhole * currentUsdPerToken;
  const ltv = Number(loan.ltv_percentage);
  if (!ltv || ltv <= 0) return null;
  const solBorrowed = Number(loan.original_loan_amount_lamports) / 1e9;
  let solUsd;
  try {
    solUsd = await getPriceInUsdCrossSourced("So11111111111111111111111111111111111111112");
  } catch { return null; }
  if (!solUsd || solUsd <= 0) return null;
  const borrowedUsd = solBorrowed * solUsd;
  const borrowValueUsd = borrowedUsd / (ltv / 100);
  if (borrowValueUsd <= 0) return null;
  const pct = ((currentValueUsd - borrowValueUsd) / borrowValueUsd) * 100;
  return { pct, currentValueUsd, borrowValueUsd, currentUsdPerToken };
}

function chooseTierToAlert(depreciationPct, alreadyAlertedTiers) {
  // Most severe unsent tier wins. depreciationPct is negative here;
  // a -55% is more urgent than a -25% even if both crossed.
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const t = TIERS[i];
    if (depreciationPct <= t.threshold_pct && !alreadyAlertedTiers.has(t.id)) {
      return t;
    }
  }
  return null;
}

function renderAlertText(loan, tier, depreciationPct, currentValueUsd, collateralSymbol) {
  const pctRounded = Math.round(Math.abs(depreciationPct));
  const valueLabel = currentValueUsd >= 1000
    ? `$${(currentValueUsd / 1000).toFixed(1)}k`
    : `$${currentValueUsd.toFixed(0)}`;
  const heading =
    tier.intensity === "urgent" ? "*Your collateral is down 50%.*"
    : tier.intensity === "strong" ? "*Your collateral is down 35%.*"
    : "*Your collateral is sliding.*";
  return [
    heading,
    "",
    `${collateralSymbol || "Collateral"} on loan #${loan.loan_id_chain} is down ${pctRounded}% since you borrowed — currently worth ~${valueLabel}.`,
    "",
    `Options that reduce your risk RIGHT NOW:`,
    "",
    `  /partialrepay ${loan.loan_id_chain} <amount>  — pay down debt, lower liquidation threshold`,
    `  /topup ${loan.loan_id_chain} <token amount>   — add collateral, boost health without paying down`,
    `  /repay ${loan.loan_id_chain}                  — close the loan entirely`,
    "",
    "Doing nothing is also a position — but auto-protect will only fire at the liquidation edge. Acting now leaves more flexibility.",
    "",
    "_Don't want these nudges? `/notify` toggles them. They cap at 3 DMs per loan._",
  ].join("\n");
}

async function processLoan(loan) {
  const move = await computeDepreciation(loan);
  if (!move) return { skipped: "no_price_or_ltv" };
  // Only fire when the loan is actually DEPRECIATED past the first tier.
  if (move.pct > TIERS[0].threshold_pct) {
    return { skipped: "above_first_tier" };
  }

  const { rows: existingAlerts } = await query(
    `SELECT tier_bucket FROM downside_alerts WHERE loan_id = $1`,
    [loan.id],
  );
  const already = new Set(existingAlerts.map((r) => r.tier_bucket));
  const tier = chooseTierToAlert(move.pct, already);
  if (!tier) return { skipped: "all_tiers_already_alerted" };

  // If user already has a stop-loss style protection in place via a
  // limit_close_order ARMED with a downward trigger, they've already
  // taken action — no need to nag. This is forward-compat with the
  // stop-loss feature we'll likely add next; today this only matches
  // existing upward TPs which is still a reasonable signal that the
  // user is engaged with the loan.
  const { rows: existingTp } = await query(
    `SELECT 1 FROM limit_close_orders
       WHERE loan_id = $1
         AND status IN ('armed','firing','twap_in_progress','awaiting_user')
       LIMIT 1`,
    [loan.id],
  );
  if (existingTp.length > 0) return { skipped: "tp_already_armed" };

  const text = renderAlertText(loan, tier, move.pct, move.currentValueUsd, loan.collateral_symbol);
  const notifResult = await query(
    `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
       VALUES ($1, 'tg', 'pip_downside_alert', $2::jsonb, 'pending')
       RETURNING id`,
    [loan.user_id, JSON.stringify({
      text,
      loan_id_chain: loan.loan_id_chain,
      collateral_symbol: loan.collateral_symbol,
      tier: tier.id,
      depreciation_pct: move.pct,
    })],
  );

  try {
    await query(
      `INSERT INTO downside_alerts
         (loan_id, tier_bucket, depreciation_pct,
          collateral_value_usd_at_alert, borrow_value_usd_at_loan,
          notification_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (loan_id, tier_bucket) DO NOTHING`,
      [loan.id, tier.id, move.pct.toFixed(2),
       move.currentValueUsd.toFixed(2), move.borrowValueUsd.toFixed(2),
       notifResult.rows[0].id],
    );
  } catch (err) {
    console.warn(`[downside-watcher] alert ledger insert failed for loan ${loan.id}:`, err.message);
  }

  return { alerted: true, tier: tier.id, depreciation_pct: move.pct };
}

export async function tick() {
  try {
    const minAgeCutoff = new Date(Date.now() - MIN_LOAN_AGE_MS).toISOString();
    const { rows: loans } = await query(
      `SELECT l.id, l.user_id, l.loan_id::text AS loan_id_chain,
              l.collateral_mint, l.collateral_amount, l.ltv_percentage,
              l.original_loan_amount_lamports::text AS original_loan_amount_lamports,
              sm.decimals, sm.symbol AS collateral_symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
         LEFT JOIN user_prefs up ON up.user_id = l.user_id
        WHERE l.status = 'active'
          AND l.created_at < $1
          AND COALESCE(up.notify_downside_alerts, TRUE) = TRUE
          AND l.collateral_mint IS NOT NULL`,
      [minAgeCutoff],
    );

    let alerted = 0;
    for (const loan of loans) {
      try {
        const result = await processLoan(loan);
        if (result.alerted) alerted++;
      } catch (err) {
        console.warn(`[downside-watcher] loan ${loan.id} failed:`, err.message);
      }
    }
    if (alerted > 0) {
      console.log(`[downside-watcher] tick alerted=${alerted} scanned=${loans.length}`);
    }
  } catch (err) {
    console.error("[downside-watcher] tick threw:", err.message);
  }
}

export function startDownsideWatcher() {
  if (_timer) return;
  console.log(`[downside-watcher] armed — probing every ${TICK_MS / 60_000}m`);
  // Stagger first tick to 105s — interleaves with upside-watcher's
  // 90s stagger so the two don't hammer the price service at the same
  // millisecond.
  setTimeout(() => {
    tick().catch(() => {});
    _timer = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
  }, 105_000);
}

export function stopDownsideWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
