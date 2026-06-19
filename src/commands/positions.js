import { query } from "../db/pool.js";
import { upsertUser } from "../services/users.js";
import { collateralValueLamports } from "../services/price.js";
import { getLiveOwedLamports } from "../services/loans.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";
import {
  formatLoanCard,
  totalOwedSol,
  countDueWithin,
  formatTimeToDue,
  formatHealthLabel,
  hasV4MixedCollateral,
} from "../services/loan-display.js";

async function enrichWithHealth(loan, owedLamports) {
  try {
    const { rows } = await query(
      `SELECT decimals FROM supported_mints WHERE mint = $1`,
      [loan.collateral_mint],
    );
    if (!rows[0]) return null;
    // V4 mixed loans: SPL side is the REMAINING balance (current_collateral_amount),
    // not the original. After auto_sells fire, the original collateral_amount
    // overstates the actual SPL still in vault by the converted slices.
    const splAmountForValue = hasV4MixedCollateral(loan)
      ? (loan.current_collateral_amount ?? loan.collateral_amount)
      : loan.collateral_amount;
    const splLamports = await collateralValueLamports(
      loan.collateral_mint,
      splAmountForValue,
      rows[0].decimals,
    );
    // Add vault SOL to the collateral value — those proceeds are
    // already SOL, so they're worth lamports 1:1 toward repayment. For
    // V1/V2/V3 sol_proceeds_amount is always 0 (the column was added
    // by migration 066 with that default).
    const vaultSolLamports = Number(loan.sol_proceeds_amount ?? 0);
    const currentLamports = Number(splLamports) + vaultSolLamports;
    const owed = Number(owedLamports ?? loan.original_loan_amount_lamports);
    const ratio = owed > 0 ? currentLamports / owed : 0;
    return { currentLamports, ratio, decimals: rows[0].decimals };
  } catch {
    return null;
  }
}

/**
 * Inline formatter for a take-profit trigger label. Compact — used
 * in the /loans card under each loan. Matches the formatting used by
 * /takeprofit's success message.
 */
function formatTriggerInline(kind, valueMicroStr) {
  const n = Number(valueMicroStr);
  if (kind === "mc_usd") {
    const usd = n / 1e6;
    if (usd >= 1e9) return `MC $${(usd / 1e9).toFixed(2)}B`;
    if (usd >= 1e6) return `MC $${(usd / 1e6).toFixed(2)}M`;
    if (usd >= 1e3) return `MC $${(usd / 1e3).toFixed(2)}K`;
    return `MC $${usd.toFixed(2)}`;
  }
  if (kind === "price_usd") {
    const usd = n / 1e6;
    return `$${usd < 0.01 ? usd.toFixed(8) : usd < 1 ? usd.toFixed(6) : usd.toFixed(4)}/token`;
  }
  return `${(n / 1e9).toFixed(9)} SOL/token`;
}

export async function handlePositions(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  // Layer 5 defense — OR-clause picks up loans whose borrower_wallet
  // is one of THIS user's wallets, even if loans.user_id has drifted.
  // [[feedback_never_misattribute_loans]]
  const { rows: rawRows } = await query(
    `SELECT l.*, sm.symbol, sm.decimals
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.status = 'active'
       AND (l.user_id = $1
            OR l.borrower_wallet IN (SELECT public_key FROM wallets WHERE user_id = $1))
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );

  if (rawRows.length === 0) {
    return ctx.reply("No active loans.\n\nUse /borrow to take one out.");
  }

  // Wallet-scope: only show loans owned by the user's currently-active
  // wallet. Per the multi-wallet design principle, every wallet's loans
  // here would confuse the signer (they run /repay and get
  // CONSTRAINT_HAS_ONE because the active wallet didn't open it).
  const { filtered: rows, otherWalletCount } = await scopeLoansToActiveWallet(user.id, rawRows);

  if (rows.length === 0) {
    return ctx.reply(
      otherWalletCount > 0
        ? `No active loans on your current wallet.\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch.`
        : "No active loans.\n\nUse /borrow to take one out.",
    );
  }

  // Fetch live on-chain amount first, then use it for health calc.
  const liveAmounts = await Promise.all(rows.map(getLiveOwedLamports));
  const healthResults = await Promise.all(
    rows.map((loan, i) => enrichWithHealth(loan, liveAmounts[i])),
  );

  // Fetch any take-profit / limit-close orders for this user's loans
  // in ONE query so we can annotate the cards. Multiple statuses are
  // surfaced so the user can see WHERE in the lifecycle each order is
  // (armed / in-flight TWAP / awaiting their decision):
  //   - 'armed'                — waiting for trigger
  //   - 'twap_in_progress'     — engine actively selling chunks
  //   - 'awaiting_user'        — Layer 3 intervention DM in flight
  // Other terminal states (fired / failed / cancelled / expired) are
  // intentionally excluded — those are post-mortem, not active state.
  const loanDbIds = rows.map((r) => r.id);
  const orderByLoan = new Map();
  let awaitingUserCount = 0;
  if (loanDbIds.length > 0) {
    try {
      const { rows: orderRows } = await query(
        `SELECT id, loan_id, status, trigger_kind,
                trigger_value_micro::text AS trigger_value_micro,
                slippage_bps, sell_destination, intervention_state,
                intervention_suggested_slippage_bps, intervention_requested_at,
                twap_chunks_total, twap_chunks_completed
           FROM limit_close_orders
          WHERE loan_id = ANY($1::bigint[])
            AND status IN ('armed','twap_in_progress','awaiting_user')`,
        [loanDbIds],
      );
      for (const o of orderRows) {
        orderByLoan.set(o.loan_id, o);
        if (o.status === "awaiting_user" && o.intervention_state === "requested") {
          awaitingUserCount++;
        }
      }
    } catch (err) {
      console.warn("[positions] take-profit lookup failed (continuing):", err.message);
    }
  }

  const totalSol = totalOwedSol(liveAmounts);
  const dueSoonCount = countDueWithin(rows, 24);

  const summary = [
    `${rows.length} active`,
    `${totalSol} SOL owed`,
  ];
  if (dueSoonCount > 0) summary.push(`${dueSoonCount} due within 24h`);
  if (awaitingUserCount > 0) {
    summary.push(`*${awaitingUserCount} take-profit awaiting your decision*`);
  }

  const lines = [
    "*Your Active Loans*",
    `_${summary.join(" · ")} · sorted by due date_`,
    "",
  ];

  for (let i = 0; i < rows.length; i++) {
    const loan = { ...rows[i], decimals: healthResults[i]?.decimals ?? rows[i].decimals };
    const card = formatLoanCard(loan, {
      owedLamports: liveAmounts[i],
      healthRatio: healthResults[i]?.ratio,
      collateralValueLamports: healthResults[i]?.currentLamports,
      position: i + 1,
    });
    lines.push(card);

    // Take-profit annotation — render per-status so the user can see
    // EXACTLY where each order is in its lifecycle. The awaiting_user
    // branch is the most important one to surface here: those orders
    // sent the user a DM but the user may have dismissed/missed it;
    // /loans reminds them they have a decision pending.
    const existing = orderByLoan.get(loan.id);
    // V4-exclusive: only suggest /takeprofit when this loan is actually
    // arm-eligible. V1/V3 loans under V4_EXIT_EXCLUSIVE_ENFORCE would
    // refuse the arm with exits_require_v4_loan, so don't bait the user.
    const v4ProgramId = process.env.PROGRAM_ID_V4 || null;
    const v4Enforced = process.env.V4_EXIT_EXCLUSIVE_ENFORCE === "true";
    const canArmExits =
      (!!v4ProgramId && loan.program_id === v4ProgramId) || !v4Enforced;
    if (!existing) {
      if (canArmExits) {
        lines.push(`   _no take-profit set_ · \`/takeprofit ${loan.loan_id} at 2x\``);
      }
    } else if (existing.status === "armed") {
      const trig = formatTriggerInline(existing.trigger_kind, existing.trigger_value_micro);
      const slip = (existing.slippage_bps / 100).toFixed(2);
      lines.push(`   take-profit armed: ${trig} (slip ${slip}%) · /canceltp ${existing.id}`);
    } else if (existing.status === "twap_in_progress") {
      const done = existing.twap_chunks_completed ?? 0;
      const total = existing.twap_chunks_total ?? 0;
      lines.push(`   take-profit *filling now*: chunk ${done}/${total} via TWAP · /canceltp ${existing.id}`);
    } else if (existing.status === "awaiting_user") {
      const suggested = existing.intervention_suggested_slippage_bps;
      const pct = suggested ? (suggested / 100).toFixed(1) : "?";
      lines.push(`   take-profit *awaiting your call*: tap the DM (\`Allow ${pct}%\` / Wait / Cancel)`);
    }
    lines.push("");
  }

  lines.push(
    "_Health < 1.1× risks liquidation._",
    "",
    "Actions: /repay · /partialrepay · /topup · /extend · /takeprofit · /health",
  );
  if (otherWalletCount > 0) {
    lines.push(
      "",
      `_+${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch._`,
    );
  }

  // Pip-as-coach: surface ONE actionable suggestion if we see a clear
  // opportunity in the user's book. Read-only — Pip only suggests, never
  // takes action.
  const coachLine = pipCoachSuggestion(rows, healthResults, liveAmounts);
  if (coachLine) {
    lines.push("", `*Pip:* ${coachLine}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

/**
 * Returns ONE coaching suggestion based on the user's active loan book,
 * or null if nothing actionable. Ordered by urgency — most urgent wins.
 *
 * Priority order:
 *   1. Past-due loans (most urgent — liquidation imminent)
 *   2. Health <1.15 (one move from liquidation)
 *   3. Due within 24h (clock pressure)
 *   4. Health <1.30 (mild buffer suggestion)
 *   5. Healthy book → reinforce
 */
function pipCoachSuggestion(loans, healthResults, liveAmounts) {
  if (!loans || loans.length === 0) return null;
  let minHealth = Infinity;
  let minHealthLoan = null;
  let minHealthIdx = -1;
  let earliestDueMs = Infinity;
  let earliestDueLoan = null;
  let earliestDueIdx = -1;
  let pastDueLoan = null;
  let pastDueIdx = -1;
  for (let i = 0; i < loans.length; i++) {
    const loan = loans[i];
    const dueMs = new Date(loan.due_timestamp).getTime();
    const msLeft = dueMs - Date.now();
    if (msLeft <= 0 && !pastDueLoan) {
      pastDueLoan = loan;
      pastDueIdx = i;
    }
    if (msLeft > 0 && dueMs < earliestDueMs) {
      earliestDueMs = dueMs;
      earliestDueLoan = loan;
      earliestDueIdx = i;
    }
    const h = healthResults[i];
    if (h && Number.isFinite(h.ratio) && h.ratio < minHealth) {
      minHealth = h.ratio;
      minHealthLoan = loan;
      minHealthIdx = i;
    }
  }
  // Loans are referred to by position number (matches the cards above)
  // rather than the long loan_id u64 — much easier to follow.
  // 1. Past due — liquidation imminent
  if (pastDueLoan) {
    return `Loan ${pastDueIdx + 1} (${pastDueLoan.symbol ?? "?"}) is *past due*. /repay now or it'll be liquidated.`;
  }
  // 2. Health critical
  if (minHealthLoan && minHealth < 1.15) {
    return `Loan ${minHealthIdx + 1} (${minHealthLoan.symbol ?? "?"}) health is *${minHealth.toFixed(2)}×* — one bad candle from liquidation. Consider /topup to add collateral.`;
  }
  // 3. Due within 24h
  if (earliestDueLoan) {
    const hoursLeft = (earliestDueMs - Date.now()) / 3_600_000;
    if (hoursLeft < 24) {
      return `Loan ${earliestDueIdx + 1} (${earliestDueLoan.symbol ?? "?"}) ${formatTimeToDue(earliestDueLoan.due_timestamp)} until due. /repay early (zero penalty) or /extend if you need more time.`;
    }
  }
  // 4. Mild health concern
  if (minHealthLoan && minHealth < 1.30) {
    return `Loan ${minHealthIdx + 1} (${minHealthLoan.symbol ?? "?"}) health is ${minHealth.toFixed(2)}× (${formatHealthLabel(minHealth)}) — comfy but not flush. /topup adds buffer with no fee.`;
  }
  // 5. Reinforce
  if (loans.length >= 2 && minHealth >= 1.50) {
    return `All ${loans.length} positions healthy. Keep an eye on token volatility — /health any time for a snapshot.`;
  }
  return null;
}
