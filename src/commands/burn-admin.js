/**
 * Operator admin commands for the $MAGPIE burn ledger.
 *
 *   /burn-confirm <loan_id> <burn_tx_sig> [amount_raw]
 *       Operator-only. Records that the seized $MAGPIE from a
 *       defaulted loan has been burned on-chain. Updates the
 *       corresponding liquidation_economics row from
 *       'magpie_burn_pending' to 'magpie_burned' AND inserts a
 *       magpie_burns ledger row so the public total reflects it.
 *
 *       amount_raw defaults to the row's collateral_seized_raw —
 *       only pass it explicitly if the burn was for a different
 *       amount (e.g. partial burn).
 *
 *   /burn-record <amount_tokens> <burn_tx_sig> [notes...]
 *       Operator-only. Records an out-of-band burn (not tied to a
 *       liquidation). Used for manual burns the operator conducts
 *       directly. amount is in WHOLE tokens (so "2000000" not
 *       "2000000000000"); the command converts to raw.
 *
 *   /burn-stats
 *       Operator-only quick view. Public surfaces (/stats, site)
 *       show the same data via getBurnSummary().
 *
 * Auth: same OPERATOR_TG_IDS gate the rest of admin uses.
 */
import { query } from "../db/pool.js";
import { getBurnSummary, recordBurn, rawToHumanString, MAGPIE_DECIMALS } from "../services/magpie-burns.js";

const OPERATOR_IDS = (process.env.OPERATOR_TG_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOperator(ctx) {
  if (OPERATOR_IDS.length === 0) return false;
  return OPERATOR_IDS.includes(String(ctx.from?.id ?? ""));
}

function rejectNonOperator(ctx) {
  return ctx.reply("Command is operator-only.");
}

const MAGPIE_RAW_DIVISOR = 10n ** BigInt(MAGPIE_DECIMALS);

/**
 * /burn-confirm <loan_id> <burn_tx_sig> [amount_raw]
 */
export async function handleBurnConfirm(ctx) {
  if (!isOperator(ctx)) return rejectNonOperator(ctx);
  const raw = (ctx.message?.text ?? "").trim();
  const parts = raw.split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply(
      "Usage: /burn-confirm <loan_id> <burn_tx_sig> [amount_raw]\n\n" +
      "loan_id: DB id of the loan whose seized $MAGPIE was burned\n" +
      "burn_tx_sig: on-chain signature of the burn tx\n" +
      "amount_raw (optional): override the recorded collateral amount",
    );
  }
  const [loanIdStr, burnTxSig, amountOverrideStr] = parts;
  const loanId = Number(loanIdStr);
  if (!Number.isInteger(loanId) || loanId <= 0) {
    return ctx.reply("loan_id must be a positive integer.");
  }
  // Locate the magpie_burn_pending row
  const { rows: [le] } = await query(
    `SELECT id, distribution_status, collateral_seized_raw::text AS seized, collateral_mint
       FROM liquidation_economics
      WHERE loan_id = $1`,
    [loanId],
  );
  if (!le) {
    return ctx.reply(`No liquidation_economics row for loan ${loanId}.`);
  }
  if (le.distribution_status === "magpie_burned") {
    return ctx.reply(`Loan ${loanId} is already marked magpie_burned. No-op.`);
  }
  if (le.distribution_status !== "magpie_burn_pending") {
    return ctx.reply(
      `Loan ${loanId} is in status '${le.distribution_status}', expected 'magpie_burn_pending'. Refusing.`,
    );
  }
  const amountRaw = amountOverrideStr ? BigInt(amountOverrideStr) : BigInt(le.seized);
  if (amountRaw <= 0n) {
    return ctx.reply("amount_raw must be positive.");
  }
  // Record in ledger (idempotent on burn_tx_sig)
  let burnId;
  try {
    burnId = await recordBurn({
      amountRaw: amountRaw.toString(),
      source: "liquidation_default",
      relatedLoanId: loanId,
      burnTxSig,
      notes: `Default of loan ${loanId} — operator burn`,
    });
  } catch (err) {
    return ctx.reply(`Ledger insert failed: ${err.message}`);
  }
  // Flip liquidation_economics status (do this even if ledger was already-recorded
  // — covers the case where ledger landed but the row flip was missed).
  await query(
    `UPDATE liquidation_economics
        SET distribution_status = 'magpie_burned',
            magpie_burn_amount_raw = $1::numeric,
            magpie_burn_tx_sig = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [amountRaw.toString(), burnTxSig, le.id],
  );
  const tokens = rawToHumanString(amountRaw);
  const summary = await getBurnSummary();
  await ctx.reply(
    `Burn confirmed for loan ${loanId}.\n` +
    `  Amount: ${tokens} \$MAGPIE\n` +
    `  Tx: ${burnTxSig}\n` +
    `  Ledger row: ${burnId ?? "(already recorded)"}\n\n` +
    `Total \$MAGPIE burned so far: ${summary.total_tokens}`,
  );
}

/**
 * /burn-record <amount_tokens> <burn_tx_sig> [notes...]
 *
 * For out-of-band burns not tied to a loan (e.g. dev-wallet burns,
 * buyback burns). Amount is in WHOLE tokens for ergonomic typing.
 */
export async function handleBurnRecord(ctx) {
  if (!isOperator(ctx)) return rejectNonOperator(ctx);
  const raw = (ctx.message?.text ?? "").trim();
  const parts = raw.split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply(
      "Usage: /burn-record <amount_tokens> <burn_tx_sig> [notes...]\n\n" +
      "amount_tokens: whole-token count (e.g. 100000 for 100k $MAGPIE)\n" +
      "burn_tx_sig: on-chain signature of the burn tx\n" +
      "notes: free-form (optional)",
    );
  }
  const [amountTokensStr, burnTxSig, ...noteWords] = parts;
  const amountTokens = Number(amountTokensStr.replace(/[,_]/g, ""));
  if (!Number.isFinite(amountTokens) || amountTokens <= 0) {
    return ctx.reply("amount_tokens must be a positive number.");
  }
  // BigInt safe: multiply by 10^6 in integer arithmetic via string concat
  const amountRaw = BigInt(Math.round(amountTokens)) * MAGPIE_RAW_DIVISOR
    + BigInt(Math.round((amountTokens - Math.floor(amountTokens)) * Number(MAGPIE_RAW_DIVISOR)));
  const notes = noteWords.join(" ") || `Manual burn — operator`;
  let burnId;
  try {
    burnId = await recordBurn({
      amountRaw: amountRaw.toString(),
      source: "manual",
      relatedLoanId: null,
      burnTxSig,
      notes,
    });
  } catch (err) {
    return ctx.reply(`Ledger insert failed: ${err.message}`);
  }
  const summary = await getBurnSummary();
  await ctx.reply(
    `Manual burn recorded.\n` +
    `  Amount: ${rawToHumanString(amountRaw)} \$MAGPIE\n` +
    `  Tx: ${burnTxSig}\n` +
    `  Notes: ${notes}\n` +
    `  Ledger row: ${burnId ?? "(already recorded)"}\n\n` +
    `Total \$MAGPIE burned so far: ${summary.total_tokens}`,
  );
}

/**
 * /burn-stats — operator-internal quick view. Public surfaces use the
 * same getBurnSummary() so the numbers are identical.
 */
export async function handleBurnStats(ctx) {
  if (!isOperator(ctx)) return rejectNonOperator(ctx);
  const s = await getBurnSummary();
  const lines = [
    "═══ \$MAGPIE Burn Ledger ═══",
    `Total burned   : ${s.total_tokens} \$MAGPIE`,
    `Burn events    : ${s.burn_count}`,
    "",
    "By source (tokens):",
    `  manual              : ${s.by_source_tokens.manual}`,
    `  liquidation_default : ${s.by_source_tokens.liquidation_default}`,
    `  buyback             : ${s.by_source_tokens.buyback}`,
  ];
  if (s.most_recent) {
    lines.push(
      "",
      "Most recent:",
      `  source    : ${s.most_recent.source}`,
      `  amount    : ${s.most_recent.amount_tokens} \$MAGPIE`,
      `  burned_at : ${s.most_recent.burned_at?.toISOString?.() ?? s.most_recent.burned_at}`,
    );
    if (s.most_recent.burn_tx_sig) lines.push(`  tx        : ${s.most_recent.burn_tx_sig}`);
  }
  await ctx.reply(lines.join("\n"));
}
