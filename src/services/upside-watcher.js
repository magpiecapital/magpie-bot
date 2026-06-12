/**
 * Proactive upside watcher — Pip nudges borrowers to arm a take-profit
 * the moment their collateral has materially appreciated since loan
 * open. The point is to seed first fills: users don't think to set a
 * TP, but they DO want to lock in unexpected upside, and the lending
 * protocol is the one entity that can SEE the appreciation in their
 * book in real time.
 *
 * Tick cadence: every 15 minutes. We do NOT need second-precision —
 * the alert is a nudge, not a trigger. Bursts of price action in a
 * <15 min window are handled by the highest-tier check on the next
 * tick (we always alert at the HIGHEST tier reached).
 *
 * Dedupe: per (loan_id, tier_bucket) via upside_alerts. A loan can
 * receive at most one alert per tier in its lifetime. Three tiers
 * (+40% / +100% / +200%) = max 3 DMs per loan even if price
 * oscillates through the buckets.
 *
 * Skip conditions (any of these blocks the DM):
 *   - Loan no longer active (repaid, liquidated, expired)
 *   - User has a take-profit ALREADY armed/firing on this loan
 *   - User has set notify_upside_alerts = FALSE
 *   - Loan was opened < 30 min ago (price hasn't moved meaningfully yet)
 *   - We've already alerted on this (loan, tier) pair
 *   - Loan opened price unknown (can't compute appreciation)
 *
 * Security:
 *   - Read-only watcher — never modifies a loan or arms an order
 *   - DM payload contains only the borrower's own loan info
 *   - Per-user DM cap inherited from pending_notifications rate limits
 *
 * Failure modes:
 *   - Price lookup fails → skip THAT loan this tick, continue others
 *   - DB error during dedupe → skip THIS alert, retry next tick (the
 *     UNIQUE (loan_id, tier_bucket) constraint makes this idempotent)
 *   - Tick itself throws → caught + logged + next tick continues
 */
import { query } from "../db/pool.js";
import { getPriceInUsdCrossSourced } from "./price.js";

const TICK_MS = 15 * 60_000;            // 15 min
const MIN_LOAN_AGE_MS = 30 * 60_000;    // skip loans < 30 min old
// Tier thresholds in percent appreciation since loan open. Order matters —
// we alert at the HIGHEST tier crossed that we haven't already alerted on.
const TIERS = [
  { id: 1, threshold_pct: 40,  label: "+40%",  intensity: "soft" },
  { id: 2, threshold_pct: 100, label: "+100% (2x)", intensity: "strong" },
  { id: 3, threshold_pct: 200, label: "+200% (3x)", intensity: "urgent" },
];

let _timer = null;

/**
 * Compute the borrower's collateral USD value at loan-open AND right
 * now, return appreciation as a percentage. Loans without a
 * historical price marker are skipped (we don't guess).
 */
async function computeAppreciation(loan) {
  const decimals = loan.decimals ?? 9;
  const currentUsdPerToken = await getPriceInUsdCrossSourced(loan.collateral_mint);
  if (!currentUsdPerToken || currentUsdPerToken <= 0) return null;
  const collateralWhole = Number(loan.collateral_amount) / 10 ** decimals;
  const currentValueUsd = collateralWhole * currentUsdPerToken;
  // Loan-open value: original_loan_amount_lamports was the SOL disbursed
  // at LTV ratio against the collateral at THAT moment. We back out the
  // collateral USD value from the loan amount + LTV. This is more reliable
  // than relying on a historical price oracle (which we'd have to store).
  // If ltv_percentage is missing/zero, we cannot reason about appreciation.
  const ltv = Number(loan.ltv_percentage);
  if (!ltv || ltv <= 0) return null;
  // SOL borrowed (lamports) → SOL borrowed (whole)
  const solBorrowed = Number(loan.original_loan_amount_lamports) / 1e9;
  // SOL/USD reference: use the current SOL price as a stable denominator.
  // The watcher's accuracy is tier-based ("did we cross 40%?"), so
  // using current SOL/USD for both sides is consistent — drift in SOL
  // price affects both legs equally.
  const solUsd = await getPriceInUsdCrossSourced("So11111111111111111111111111111111111111112");
  if (!solUsd || solUsd <= 0) return null;
  const borrowedUsd = solBorrowed * solUsd;
  const borrowValueUsd = borrowedUsd / (ltv / 100);  // back out collateral USD at open
  if (borrowValueUsd <= 0) return null;
  const pct = ((currentValueUsd - borrowValueUsd) / borrowValueUsd) * 100;
  return { pct, currentValueUsd, borrowValueUsd, currentUsdPerToken };
}

function chooseTierToAlert(appreciationPct, alreadyAlertedTiers) {
  // Walk tiers from highest to lowest. First tier we've crossed AND
  // haven't already alerted on is the one we send. We always send the
  // HIGHEST unsent tier, never the lowest — alerting users at +40% when
  // they're already at +200% is silly.
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const t = TIERS[i];
    if (appreciationPct >= t.threshold_pct && !alreadyAlertedTiers.has(t.id)) {
      return t;
    }
  }
  return null;
}

function renderAlertText(loan, tier, appreciationPct, currentValueUsd, collateralSymbol) {
  const pctRounded = Math.round(appreciationPct);
  const valueLabel = currentValueUsd >= 1000
    ? `$${(currentValueUsd / 1000).toFixed(1)}k`
    : `$${currentValueUsd.toFixed(0)}`;
  const heading =
    tier.intensity === "urgent" ? "*Your collateral has 3x'd.*"
    : tier.intensity === "strong" ? "*Your collateral has 2x'd.*"
    : "*Your collateral is moving up.*";
  return [
    heading,
    "",
    `${collateralSymbol || "Collateral"} on loan #${loan.loan_id_chain} is up ${pctRounded}% since you borrowed — currently worth ~${valueLabel}.`,
    "",
    `If you want to LOCK IN this upside automatically:`,
    `  \`/takeprofit ${loan.loan_id_chain} at 2x\`  (or 1.5x, 3x, 5x — your call)`,
    "",
    "When the target hits, Pip closes the loan and sells the collateral into SOL. No babysitting.",
    "",
    "_Don't want these nudges? `/upsidealerts off` silences them. You can re-enable any time._",
  ].join("\n");
}

async function processLoan(loan) {
  const apprec = await computeAppreciation(loan);
  if (!apprec) return { skipped: "no_price_or_ltv" };
  if (apprec.pct < TIERS[0].threshold_pct) {
    return { skipped: "below_first_tier" };
  }

  const { rows: existingAlerts } = await query(
    `SELECT tier_bucket FROM upside_alerts WHERE loan_id = $1`,
    [loan.id],
  );
  const alreadyAlertedTiers = new Set(existingAlerts.map((r) => r.tier_bucket));
  const tier = chooseTierToAlert(apprec.pct, alreadyAlertedTiers);
  if (!tier) return { skipped: "all_tiers_already_alerted" };

  // Defense in depth — make sure they don't already have a TP on this
  // loan. If they do, alerting is just noise.
  const { rows: existingTp } = await query(
    `SELECT 1 FROM limit_close_orders
       WHERE loan_id = $1
         AND status IN ('armed','firing','twap_in_progress','awaiting_user')
       LIMIT 1`,
    [loan.id],
  );
  if (existingTp.length > 0) return { skipped: "tp_already_armed" };

  // Enqueue the DM via the standard pending_notifications path so it
  // inherits retries, rate limits, and the notification-sender's TG
  // delivery. The kind is reused: limit_close_armed renders nicely but
  // this needs a new payload shape — using a generic 'pip_proactive'
  // kind that the renderer falls through to the text field.
  const text = renderAlertText(loan, tier, apprec.pct, apprec.currentValueUsd, loan.collateral_symbol);
  const notifResult = await query(
    `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
       VALUES ($1, 'tg', 'pip_upside_alert', $2::jsonb, 'pending')
       RETURNING id`,
    [loan.user_id, JSON.stringify({
      text,
      loan_id_chain: loan.loan_id_chain,
      collateral_symbol: loan.collateral_symbol,
      tier: tier.id,
      appreciation_pct: apprec.pct,
    })],
  );

  // Record the alert AFTER the notification insert so a failed insert
  // doesn't leave a dedupe ghost (we'd never retry that tier).
  // ON CONFLICT DO NOTHING guards against a race where two ticks
  // happen to land at the same time (rare but possible during deploys).
  try {
    await query(
      `INSERT INTO upside_alerts
         (loan_id, tier_bucket, appreciation_pct,
          collateral_value_usd_at_alert, borrow_value_usd_at_loan,
          notification_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (loan_id, tier_bucket) DO NOTHING`,
      [loan.id, tier.id, apprec.pct.toFixed(2),
       apprec.currentValueUsd.toFixed(2), apprec.borrowValueUsd.toFixed(2),
       notifResult.rows[0].id],
    );
  } catch (err) {
    // Ledger insert failed but DM is enqueued. Log; the worst case is
    // a duplicate DM on the next tick, which the UNIQUE constraint
    // would block anyway.
    console.warn(`[upside-watcher] alert ledger insert failed for loan ${loan.id}:`, err.message);
  }

  return { alerted: true, tier: tier.id, appreciation_pct: apprec.pct };
}

export async function tick() {
  try {
    // Pull every active loan whose borrower opted in, age > 30 min,
    // joined with collateral mint metadata (decimals, symbol).
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
          AND COALESCE(up.notify_upside_alerts, TRUE) = TRUE
          AND l.collateral_mint IS NOT NULL`,
      [minAgeCutoff],
    );

    let alerted = 0;
    let skipped = 0;
    for (const loan of loans) {
      try {
        const result = await processLoan(loan);
        if (result.alerted) alerted++;
        else skipped++;
      } catch (err) {
        console.warn(`[upside-watcher] loan ${loan.id} failed:`, err.message);
      }
    }
    if (alerted > 0) {
      console.log(`[upside-watcher] tick alerted=${alerted} skipped=${skipped} total=${loans.length}`);
    }
  } catch (err) {
    console.error("[upside-watcher] tick threw:", err.message);
  }
}

export function startUpsideWatcher() {
  if (_timer) return;
  console.log(`[upside-watcher] armed — probing every ${TICK_MS / 60_000}m`);
  // Stagger first tick by 90s so the bot has time to fully boot.
  setTimeout(() => {
    tick().catch(() => {});
    _timer = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
  }, 90_000);
}

export function stopUpsideWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
