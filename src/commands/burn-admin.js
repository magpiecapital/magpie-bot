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
import { withFailover } from "../solana/connection.js";
import { MAGPIE_MINT } from "./magpie.js";

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
 * Fetch a burn tx on-chain and extract the EXACT $MAGPIE amount burned.
 * Parses top-level AND inner instructions for spl-token burn/burnChecked
 * ixs on the $MAGPIE mint and SUMS them (usually exactly one). This makes
 * the recorded burn structurally equal to the on-chain reality, so the
 * public "$MAGPIE burned" total can NEVER diverge from what actually left
 * supply (operator's uniformity rule: burns == defaults, never more).
 *
 * Throws (never silently returns 0) on tx-not-found / failed-tx / no burn
 * ix / no $MAGPIE burn — so we never record a phantom or wrong-mint burn.
 */
async function parseMagpieBurnFromTx(sig) {
  const tx = await withFailover((conn) =>
    conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }),
  );
  if (!tx) {
    throw new Error(`tx ${sig.slice(0, 12)}… not found on-chain (unconfirmed, or wrong cluster)`);
  }
  if (tx.meta?.err) {
    throw new Error(`tx ${sig.slice(0, 12)}… FAILED on-chain (${JSON.stringify(tx.meta.err)}) — refusing to record a failed burn`);
  }
  const top = tx.transaction?.message?.instructions || [];
  const inner = (tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || []);
  const magpieBurns = [];
  for (const ix of [...top, ...inner]) {
    const p = ix?.parsed;
    if (!p || typeof p !== "object") continue;
    if (p.type !== "burn" && p.type !== "burnChecked") continue;
    const info = p.info || {};
    if (info.mint !== MAGPIE_MINT) continue;
    const amt = info.amount ?? info.tokenAmount?.amount;
    if (amt == null) continue;
    magpieBurns.push({
      amountRaw: BigInt(amt),
      authority: info.authority || info.multisigAuthority || null,
      account: info.account || null,
    });
  }
  if (magpieBurns.length === 0) {
    throw new Error(`no $MAGPIE burn instruction found in ${sig.slice(0, 12)}… (mint must be ${MAGPIE_MINT.slice(0, 8)}…)`);
  }
  const total = magpieBurns.reduce((s, b) => s + b.amountRaw, 0n);
  return { amountRaw: total, ixCount: magpieBurns.length, authority: magpieBurns[0].authority, account: magpieBurns[0].account };
}

/**
 * /burn-confirm [loan_id] <burn_tx_sig> [amount_raw]
 *
 * Records that the seized $MAGPIE from a defaulted loan was burned on
 * chain. The AMOUNT is auto-derived by parsing the tx (ledger == reality),
 * and loan_id is auto-matched to the single pending row when omitted.
 * $MAGPIE defaults are burned 1:1 — NO profit is computed or credited
 * (profit-to-rewards is a NON-$MAGPIE, sold-collateral concept only).
 */
export async function handleBurnConfirm(ctx) {
  if (!isOperator(ctx)) return rejectNonOperator(ctx);
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  const usage =
    "Usage: `/burn-confirm [loan_id] <burn_tx_sig> [amount_raw]`\n\n" +
    "• burn_tx_sig — on-chain signature; the burn amount is auto-derived\n" +
    "• loan_id (optional) — omit to auto-match the single pending $MAGPIE burn\n" +
    "• amount_raw (optional) — override only for partial burns\n\n" +
    "See what's awaiting a burn with `/burn-pending`.";
  if (parts.length < 1) return ctx.reply(usage, { parse_mode: "Markdown" });

  // Token disambiguation: a signature is long base58; a loan_id is a short
  // integer; a raw amount is a long all-digit integer (≥10 digits).
  let loanIdStr = null, burnTxSig = null, amountOverrideStr = null;
  for (const tok of parts) {
    if (!burnTxSig && /^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(tok)) { burnTxSig = tok; continue; }
    if (/^\d+$/.test(tok)) {
      if (tok.length >= 10) { if (!amountOverrideStr) amountOverrideStr = tok; }
      else if (!loanIdStr) { loanIdStr = tok; }
    }
  }
  if (!burnTxSig) {
    return ctx.reply("Couldn't find a burn tx signature in your message.\n\n" + usage, { parse_mode: "Markdown" });
  }

  // Parse the on-chain burn (authoritative amount + mint verification).
  let onchain;
  try {
    onchain = await parseMagpieBurnFromTx(burnTxSig);
  } catch (err) {
    return ctx.reply(`❌ On-chain check failed: ${err.message}`);
  }

  // On-chain-derived amount is authoritative (uniformity). An explicit
  // override is honored but flagged on disagreement, and can NEVER exceed
  // what was actually burned.
  let amountRaw = onchain.amountRaw;
  let overrideNote = "";
  if (amountOverrideStr) {
    const ov = BigInt(amountOverrideStr);
    if (ov !== onchain.amountRaw) {
      overrideNote = `\n⚠️ override ${rawToHumanString(ov)} ≠ on-chain ${rawToHumanString(onchain.amountRaw)}`;
    }
    amountRaw = ov <= onchain.amountRaw ? ov : onchain.amountRaw;
  }
  if (amountRaw <= 0n) return ctx.reply("Derived burn amount is 0 — refusing.");

  // Locate the row: explicit loan_id wins; else auto-match the single
  // pending $MAGPIE burn.
  let le;
  if (loanIdStr) {
    const { rows } = await query(
      `SELECT id, loan_id, distribution_status, collateral_mint FROM liquidation_economics WHERE loan_id = $1`,
      [Number(loanIdStr)],
    );
    le = rows[0];
    if (!le) return ctx.reply(`No liquidation_economics row for loan ${loanIdStr}.`);
  } else {
    const { rows } = await query(
      `SELECT id, loan_id, distribution_status, collateral_mint
         FROM liquidation_economics
        WHERE distribution_status = 'magpie_burn_pending'
        ORDER BY created_at ASC`,
    );
    if (rows.length === 0) {
      return ctx.reply("No pending $MAGPIE burns to confirm. If this burn's loan isn't enrolled yet, pass its loan_id explicitly.");
    }
    if (rows.length > 1) {
      const list = rows.map((r) => `• loan ${r.loan_id}`).join("\n");
      return ctx.reply(`Multiple pending $MAGPIE burns — specify which:\n${list}\n\nRun \`/burn-confirm <loan_id> ${burnTxSig}\`.`, { parse_mode: "Markdown" });
    }
    le = rows[0];
  }

  if (le.distribution_status === "magpie_burned") {
    return ctx.reply(`Loan ${le.loan_id} is already marked magpie_burned. No-op.`);
  }
  if (le.distribution_status !== "magpie_burn_pending") {
    return ctx.reply(`Loan ${le.loan_id} is in status '${le.distribution_status}', expected 'magpie_burn_pending'. Refusing.`);
  }
  if (le.collateral_mint && le.collateral_mint !== MAGPIE_MINT) {
    return ctx.reply(`Loan ${le.loan_id} collateral is not $MAGPIE (${le.collateral_mint.slice(0, 8)}…). Refusing.`);
  }

  // Record in ledger (idempotent on burn_tx_sig). NO profit — $MAGPIE
  // defaults are burned 1:1; the burn (deflation) IS the holder benefit.
  let burnId;
  try {
    burnId = await recordBurn({
      amountRaw: amountRaw.toString(),
      source: "liquidation_default",
      relatedLoanId: le.loan_id,
      burnTxSig,
      notes: `Default of loan ${le.loan_id} — operator burn (on-chain verified)`,
    });
  } catch (err) {
    return ctx.reply(`Ledger insert failed: ${err.message}`);
  }
  // Flip status. Leave net_profit_lamports NULL so a burned row never
  // enters the DEFAULTED-LOAN PROFIT (real-SOL-to-rewards) figure.
  await query(
    `UPDATE liquidation_economics
        SET distribution_status = 'magpie_burned',
            magpie_burn_amount_raw = $1::numeric,
            magpie_burn_tx_sig = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [amountRaw.toString(), burnTxSig, le.id],
  );

  // Uniformity readout — operator wants $MAGPIE defaults == burns (0 pending).
  const { rows: [counts] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE distribution_status = 'magpie_burned')::int AS burned,
       COUNT(*) FILTER (WHERE distribution_status = 'magpie_burn_pending')::int AS pending
     FROM liquidation_economics
     WHERE collateral_mint = $1`,
    [MAGPIE_MINT],
  );
  const summary = await getBurnSummary();
  const aligned = Number(counts?.pending || 0) === 0;
  await ctx.reply(
    `🔥 Burn confirmed for loan ${le.loan_id}.\n` +
    `  Amount: ${rawToHumanString(amountRaw)} \$MAGPIE (on-chain verified${onchain.ixCount > 1 ? `, ${onchain.ixCount} burn ixs summed` : ""})\n` +
    `  Tx: ${burnTxSig}\n` +
    `  Ledger row: ${burnId ?? "(already recorded)"}${overrideNote}\n\n` +
    `\$MAGPIE defaults: ${counts?.burned ?? 0} burned / ${counts?.pending ?? 0} pending — ` +
    `${aligned ? "✅ defaults == burns (aligned)" : "⚠️ still pending — run /burn-pending"}\n` +
    `Total \$MAGPIE burned (all sources): ${summary.total_tokens}`,
  );
}

/**
 * /burn-pending — list $MAGPIE defaults awaiting a burn, so the operator
 * knows exactly what to burn to keep defaults == burns. Read-only.
 */
export async function handleBurnPending(ctx) {
  if (!isOperator(ctx)) return rejectNonOperator(ctx);
  const { rows } = await query(
    `SELECT loan_id, borrower_wallet,
            lender_share_raw::text AS lender_share,
            collateral_seized_raw::text AS seized
       FROM liquidation_economics
      WHERE distribution_status = 'magpie_burn_pending'
      ORDER BY created_at ASC`,
  );
  const summary = await getBurnSummary();
  if (!rows.length) {
    return ctx.reply(
      `✅ No pending $MAGPIE burns — every $MAGPIE default has been burned (defaults == burns).\n` +
      `Total $MAGPIE burned: ${summary.total_tokens}`,
    );
  }
  const lines = [
    `🔥 *Pending $MAGPIE burns* (${rows.length})`,
    ``,
    `Burn on-chain, then \`/burn-confirm <burn_tx_sig>\` (loan auto-matched when only one pending):`,
    ``,
  ];
  for (const r of rows) {
    const amt = rawToHumanString(BigInt(r.lender_share || r.seized || "0"));
    lines.push(`• Loan #${r.loan_id} — ${amt} $MAGPIE  (${(r.borrower_wallet || "").slice(0, 6)}…)`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
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
