/**
 * /calendar — chronological view of all the user's active loans
 * sorted by due date. One screen, full mental model.
 *
 * Health badge per loan: 🟢 healthy / 🟡 watch / 🟠 tight / 🔴 imminent.
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

function timeUntil(timestamp) {
  const ms = new Date(timestamp).getTime() - Date.now();
  if (ms <= 0) return "PAST DUE";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `in ${days}d ${hours % 24}h`;
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.max(1, Math.floor(ms / 60_000))}m`;
}

function healthBadge(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return "⚪";
  if (ratio >= 1.5) return "🟢";
  if (ratio >= 1.3) return "🟡";
  if (ratio >= 1.1) return "🟠";
  return "🔴";
}

export async function handleCalendar(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows: rawRows } = await query(
    `SELECT l.id, l.loan_id, l.loan_pda, l.collateral_mint, l.collateral_amount,
            l.original_loan_amount_lamports, l.due_timestamp,
            sm.symbol, sm.decimals
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );
  // Scope to active wallet — calendar of every linked wallet's loans
  // would mix in things the user can't act on from the current signer.
  const { filtered: rows, otherWalletCount } = await scopeLoansToActiveWallet(user.id, rawRows);

  if (rows.length === 0) {
    return ctx.reply(
      [
        "📅 *Loan Calendar*",
        "",
        otherWalletCount > 0
          ? `No active loans on your current wallet.\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch.`
          : "No active loans. Use /borrow to take one out.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // Compute live owed + health for each loan in parallel
  const enriched = await Promise.all(rows.map(async (r) => {
    let liveOwed = null;
    let healthRatio = null;
    try {
      liveOwed = await getLiveOwedLamports(r);
    } catch { /* fall through to DB */ }
    const owed = liveOwed ?? BigInt(r.original_loan_amount_lamports ?? "0");
    try {
      if (r.decimals != null && owed > 0n) {
        const collateralLamports = await collateralValueLamports(
          r.collateral_mint,
          r.collateral_amount,
          r.decimals,
        );
        healthRatio = Number(collateralLamports) / Number(owed);
      }
    } catch { /* skip health if price feed blips */ }
    return { ...r, liveOwed: owed, healthRatio };
  }));

  const lines = [
    "📅 *Loan Calendar*",
    `${enriched.length} active · sorted by due date`,
    "",
  ];

  for (const loan of enriched) {
    const badge = healthBadge(loan.healthRatio);
    const when = timeUntil(loan.due_timestamp);
    const healthStr = loan.healthRatio != null ? `${loan.healthRatio.toFixed(2)}x` : "?";
    lines.push(
      `${badge} *#${loan.loan_id}* — ${loan.symbol ?? "?"}`,
      `  Due ${when} · Health ${healthStr} · Owed \`${fmtSol(loan.liveOwed)} SOL\``,
      "",
    );
  }

  // Inline action buttons for the first few loans
  const kb = new InlineKeyboard();
  for (let i = 0; i < Math.min(3, enriched.length); i++) {
    const l = enriched[i];
    kb.text(`Manage #${l.loan_id}`, `calendar:loan:${l.id}`).row();
  }
  if (enriched.length > 0) {
    lines.push("_Pick a loan below to repay / topup / extend, or use /repay /topup /extend directly._");
  }
  if (otherWalletCount > 0) {
    lines.push("", `_+${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch._`);
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

export function registerCalendarCallbacks(bot) {
  bot.callbackQuery(/^calendar:loan:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const loanId = Number(ctx.match[1]);
    const kb = new InlineKeyboard()
      .text("🔧 Repay", `repay:loan:${loanId}`)
      .text("➕ Top up", `topup:loan:${loanId}`)
      .row()
      .text("⏱ Extend", `extend:loan:${loanId}`)
      .text("💰 Partial", `partialrepay:loan:${loanId}`);
    await ctx.reply(`*Loan management actions:*`, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  });
}
