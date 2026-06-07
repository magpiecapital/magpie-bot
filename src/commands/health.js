/**
 * /health [loanId] — quick health snapshot for a single loan.
 *
 * No args: shows the lowest-health loan (most urgent first).
 * With loanId: shows that specific loan.
 *
 * Includes: health ratio, liquidation price, collateral value, owed,
 * and a clear "what to do" hint based on the health band.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { collateralValueLamports } from "../services/price.js";
import { getLiveOwedLamports } from "../services/loans.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function healthBadge(ratio) {
  if (ratio >= 1.5) return { emoji: "🟢", label: "Healthy", color: "green" };
  if (ratio >= 1.3) return { emoji: "🟡", label: "Watch", color: "yellow" };
  if (ratio >= 1.1) return { emoji: "🟠", label: "Tight", color: "orange" };
  return { emoji: "🔴", label: "Imminent liquidation", color: "red" };
}

function advice(ratio) {
  if (ratio >= 1.5) return "You're in solid shape. No action needed.";
  if (ratio >= 1.3) return "Comfortable buffer but worth watching. Consider /topup if the token's volatile.";
  if (ratio >= 1.1) return "Tight. Recommend /topup (add collateral) OR /partialrepay (pay down).";
  return "*Act now.* /repay, /partialrepay, or /topup immediately. Auto-Protect (if enabled) is also trying to help.";
}

async function snapshotLoan(loan) {
  let liveOwed;
  try {
    liveOwed = await getLiveOwedLamports(loan);
  } catch {
    liveOwed = BigInt(loan.original_loan_amount_lamports ?? "0");
  }
  let collateralLamports = null;
  try {
    if (loan.decimals != null) {
      collateralLamports = await collateralValueLamports(
        loan.collateral_mint,
        loan.collateral_amount,
        loan.decimals,
      );
    }
  } catch {}
  const owedN = Number(liveOwed);
  const collN = collateralLamports != null ? Number(collateralLamports) : null;
  const ratio = collN != null && owedN > 0 ? collN / owedN : null;
  // Liquidation price: per-token SOL price at which ratio = 1.1x
  // ratio = (price × tokens) / owed → price = (1.1 × owed) / tokens
  const tokens = Number(loan.collateral_amount) / Math.pow(10, loan.decimals ?? 0);
  const liqPriceSol = collN != null && tokens > 0
    ? (1.1 * owedN) / 1e9 / tokens
    : null;
  return { liveOwed, collateralLamports, ratio, liqPriceSol, tokens };
}

export async function handleHealth(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const arg = (ctx.message?.text || "").split(/\s+/)[1];

  let loan;
  if (arg) {
    // Specific loan by loan_id
    const { rows } = await query(
      `SELECT l.*, sm.symbol, sm.decimals
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.loan_id = $1 AND l.user_id = $2 AND l.status = 'active'
       LIMIT 1`,
      [arg, user.id],
    );
    loan = rows[0];
    if (!loan) {
      return ctx.reply(
        `Couldn't find active loan \`#${arg}\`. Run /positions to see your loans.`,
        { parse_mode: "Markdown" },
      );
    }
  } else {
    // Lowest-health loan first — scoped to the active wallet so a
    // multi-wallet user doesn't get freaked out by a "low health"
    // loan they can't actually act on from their current wallet.
    const { rows: rawRows } = await query(
      `SELECT l.*, sm.symbol, sm.decimals
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.user_id = $1 AND l.status = 'active'
       ORDER BY l.due_timestamp ASC`,
      [user.id],
    );
    const { filtered: rows, otherWalletCount } = await scopeLoansToActiveWallet(user.id, rawRows);
    if (rows.length === 0) {
      return ctx.reply(
        otherWalletCount > 0
          ? `No active loans on your current wallet.\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch.`
          : "No active loans. Use /borrow to take one out.",
      );
    }
    // Compute health of all in parallel, pick lowest
    const withRatios = await Promise.all(rows.map(async (r) => ({
      row: r,
      snap: await snapshotLoan(r),
    })));
    withRatios.sort((a, b) => (a.snap.ratio ?? Infinity) - (b.snap.ratio ?? Infinity));
    loan = withRatios[0].row;
    // Reuse the snapshot we already computed
    return renderHealth(ctx, loan, withRatios[0].snap, rows.length > 1, otherWalletCount);
  }

  const snap = await snapshotLoan(loan);
  return renderHealth(ctx, loan, snap, false);
}

async function renderHealth(ctx, loan, snap, multiple, otherWalletCount = 0) {
  const ratio = snap.ratio;
  const badge = ratio != null ? healthBadge(ratio) : { emoji: "⚪", label: "Unknown" };

  const lines = [
    `${badge.emoji} *Loan #${loan.loan_id} — ${badge.label}*`,
    "",
    `Collateral: \`${snap.tokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${loan.symbol ?? "?"}\``,
    snap.collateralLamports != null ? `  Value: \`${fmtSol(snap.collateralLamports)} SOL\`` : "  Value: _price feed unavailable_",
    `Owed:       \`${fmtSol(snap.liveOwed)} SOL\``,
    ratio != null ? `Health:     *${ratio.toFixed(2)}x*` : "Health:     _unknown_",
    snap.liqPriceSol != null ? `Liq. price: \`${snap.liqPriceSol.toFixed(9)} SOL/${loan.symbol ?? "token"}\`` : "",
    "",
    ratio != null ? advice(ratio) : "Couldn't compute health right now — try /health again in 15s.",
  ].filter(Boolean);

  if (multiple) {
    lines.push("", "_Showing your lowest-health loan. Use `/health <loan_id>` for a specific one, or /calendar for all._");
  }
  if (otherWalletCount > 0) {
    lines.push("", `_+${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch._`);
  }

  const kb = new InlineKeyboard()
    .text("🔧 Repay", `repay:loan:${loan.id}`)
    .text("➕ Top up", `topup:loan:${loan.id}`)
    .row()
    .text("⏱ Extend", `extend:loan:${loan.id}`)
    .text("💰 Partial", `partialrepay:loan:${loan.id}`);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}
