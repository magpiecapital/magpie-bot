/**
 * Loan display helpers — single source of truth for how loans render
 * across /repay, /topup, /partialrepay, /extend, /positions, /calendar,
 * /health.
 *
 * Before this module each command rolled its own time-to-due formatter
 * and emoji-coded health badges, which (a) drifted between commands
 * and (b) violated the no-emoji rule. Centralised here so a single
 * tweak ripples to every loan-listing surface.
 */

/**
 * Compact time-to-due for inline-button labels.
 * Examples: "2d 3h", "14h", "47m", "OVERDUE", "DUE NOW"
 */
export function formatTimeToDue(due_timestamp) {
  const ms = new Date(due_timestamp).getTime() - Date.now();
  if (ms <= 0) return "OVERDUE";
  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${totalHours % 24}h`;
  if (totalHours > 0) return `${totalHours}h`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return "DUE NOW";
}

/**
 * Long-form time-to-due for text-report cards.
 * Examples: "due in 2d 3h", "due in 14h 7m", "due in 47m",
 *           "OVERDUE by 2h", "DUE NOW"
 */
export function formatTimeToDueLong(due_timestamp) {
  const ms = new Date(due_timestamp).getTime() - Date.now();
  if (ms <= 0) {
    const overdue = -ms;
    const overdueHours = Math.floor(overdue / 3_600_000);
    const overdueDays = Math.floor(overdueHours / 24);
    if (overdueDays > 0) return `OVERDUE by ${overdueDays}d ${overdueHours % 24}h`;
    if (overdueHours > 0) return `OVERDUE by ${overdueHours}h`;
    const overdueMinutes = Math.floor(overdue / 60_000);
    if (overdueMinutes > 0) return `OVERDUE by ${overdueMinutes}m`;
    return "DUE NOW";
  }
  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `due in ${days}d ${totalHours % 24}h`;
  if (totalHours > 0) return `due in ${totalHours}h ${totalMinutes % 60}m`;
  if (totalMinutes > 0) return `due in ${totalMinutes}m`;
  return "DUE NOW";
}

/**
 * Plain-text health label. No emojis.
 */
export function formatHealthLabel(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  if (ratio >= 1.5) return "healthy";
  if (ratio >= 1.3) return "OK";
  if (ratio >= 1.1) return "tight";
  return "AT RISK";
}

/**
 * Health-band severity: 0=healthy, 1=OK, 2=tight, 3=AT RISK, -1=unknown.
 * Useful for sorting + alerting.
 */
export function healthSeverity(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return -1;
  if (ratio >= 1.5) return 0;
  if (ratio >= 1.3) return 1;
  if (ratio >= 1.1) return 2;
  return 3;
}

function fmtSol(lamports, dp = 2) {
  return (Number(lamports) / 1e9).toFixed(dp);
}

/**
 * V4 mixed-collateral detector — returns true if any auto-sell has
 * already converted part of the SPL collateral to SOL inside the loan
 * vault. Pure V1/V2/V3 loans (and V4 loans before their first auto-sell)
 * keep auto_sells_fired = 0, so this discriminator stays accurate
 * regardless of program_id.
 *
 * The migration backfilled `current_collateral_amount = collateral_amount`
 * for every existing row, so the SPL-side display falls back cleanly to
 * the original amount when no auto-sell has fired.
 */
export function hasV4MixedCollateral(loan) {
  return Number(loan?.auto_sells_fired ?? 0) > 0;
}

/**
 * Inline-button label for action menus (repay / topup / partialrepay /
 * extend). Constraint: stays under ~42 chars so Telegram doesn't
 * truncate on mobile.
 *
 * Format: `N. SYMBOL · X.XX SOL · TIME`
 * Examples:
 *   "1. BUTTCOIN · 3.79 SOL · 2d 3h"
 *   "3. PUMP · 5.26 SOL · OVERDUE"
 *   "5. WORLDCUP · 3.44 SOL · DUE NOW"
 *
 * Position-numbered so users can disambiguate when they have multiple
 * loans against the same token. The position matches the order shown
 * in /positions and /calendar.
 *
 * @param {object} loan        the loan row (needs symbol, due_timestamp)
 * @param {bigint|number} owed live owed amount in lamports
 * @param {number} position    1-indexed position number
 */
export function formatLoanButtonLabel(loan, owed, position) {
  const symbol = loan.symbol ?? "?";
  const sol = fmtSol(owed);
  const timeStr = formatTimeToDue(loan.due_timestamp);
  const prefix = position != null ? `${position}. ` : "";
  return `${prefix}${symbol} · ${sol} SOL · ${timeStr}`;
}

/**
 * Multi-line text card for /positions and /calendar. Two-line dense
 * format that scans cleanly even for users with many active loans.
 *
 * Example:
 *   *1. BUTTCOIN* — 3.79 SOL — due in 2d 3h
 *      Collateral 1.54M BUTTCOIN · health 1.48× (OK) · 25% LTV
 *
 * @param {object} loan
 * @param {object} opts        { owedLamports, healthRatio,
 *                               collateralValueLamports, position }
 */
export function formatLoanCard(loan, opts = {}) {
  const {
    owedLamports,
    healthRatio,
    collateralValueLamports,
    position,
  } = opts;
  const symbol = loan.symbol ?? "?";
  const owed = fmtSol(owedLamports ?? loan.loan_amount_lamports, 4);
  const timeStr = formatTimeToDueLong(loan.due_timestamp);
  const idxStr = position != null ? `${position}. ` : "";

  // V4 mixed-collateral rendering: when any auto-sell has fired, the
  // collateral is split between the remaining SPL (current_collateral_amount)
  // and accumulated SOL proceeds in the vault (sol_proceeds_amount,
  // lamports). The user gets BOTH back at repay time, so the value line
  // must reflect both legs.
  let collateralAmountStr;
  let collateralValueStr;
  if (hasV4MixedCollateral(loan)) {
    const remainingSplStr = formatTokenAmount(
      loan.current_collateral_amount ?? loan.collateral_amount,
      loan.decimals ?? 9,
    );
    const vaultSolStr = fmtSol(loan.sol_proceeds_amount ?? 0, 3);
    collateralAmountStr = `${remainingSplStr} ${symbol} + ${vaultSolStr} SOL vault`;
    if (collateralValueLamports != null) {
      const totalValueLamports =
        Number(collateralValueLamports) + Number(loan.sol_proceeds_amount ?? 0);
      collateralValueStr = ` (worth ${fmtSol(totalValueLamports, 3)} SOL total)`;
    } else {
      collateralValueStr = "";
    }
  } else {
    collateralAmountStr = formatTokenAmount(
      loan.collateral_amount,
      loan.decimals ?? 9,
    );
    collateralValueStr = collateralValueLamports != null
      ? ` (worth ${fmtSol(collateralValueLamports, 3)} SOL)`
      : "";
  }

  let healthStr;
  if (healthRatio != null && Number.isFinite(healthRatio)) {
    healthStr = `health ${healthRatio.toFixed(2)}× (${formatHealthLabel(healthRatio)})`;
  } else {
    healthStr = "health —";
  }

  // For V4 mixed loans collateralAmountStr already embeds the symbol
  // ("1.2M BUTTCOIN + 0.42 SOL vault"), so skip the trailing " SYMBOL"
  // that the legacy template appended.
  const collateralLine = hasV4MixedCollateral(loan)
    ? `   Collateral ${collateralAmountStr}${collateralValueStr} · ${healthStr} · ${loan.ltv_percentage}% LTV`
    : `   Collateral ${collateralAmountStr} ${symbol}${collateralValueStr} · ${healthStr} · ${loan.ltv_percentage}% LTV`;

  return [
    `*${idxStr}${symbol}* — ${owed} SOL — ${timeStr}`,
    collateralLine,
  ].join("\n");
}

/**
 * Compact human-readable token amount (e.g. "1.54M", "12.3K", "847").
 * Decimals-aware. Keeps display tight in mobile.
 */
export function formatTokenAmount(rawAmount, decimals) {
  const human = Number(BigInt(rawAmount ?? 0)) / Math.pow(10, decimals);
  if (!Number.isFinite(human) || human === 0) return "0";
  const abs = Math.abs(human);
  if (abs >= 1_000_000_000) return `${(human / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(human / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(human / 1_000).toFixed(2)}K`;
  if (abs >= 1) return human.toFixed(2);
  if (abs >= 0.01) return human.toFixed(4);
  return human.toFixed(6);
}

/**
 * Total SOL owed across a list of loans (lamports → SOL string).
 */
export function totalOwedSol(owedLamportsArray) {
  let total = 0n;
  for (const v of owedLamportsArray) total += BigInt(v ?? 0);
  return (Number(total) / 1e9).toFixed(4);
}

/**
 * Count how many loans in the list are within `withinHours` of due.
 */
export function countDueWithin(loans, withinHours) {
  const cutoffMs = Date.now() + withinHours * 3_600_000;
  let count = 0;
  for (const l of loans) {
    const dueMs = new Date(l.due_timestamp).getTime();
    if (dueMs <= cutoffMs) count++;
  }
  return count;
}
