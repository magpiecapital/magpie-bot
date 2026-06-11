import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";

function statusLabel(status, dueTimestamp) {
  if (status === "repaid") return "repaid";
  if (status === "liquidated") return "liquidated";
  if (status === "active") {
    if (!dueTimestamp) return "active";
    const ms = new Date(dueTimestamp).getTime() - Date.now();
    if (ms <= 0) return "active — OVERDUE";
    const hours = Math.floor(ms / 3_600_000);
    const days = Math.floor(hours / 24);
    if (days > 0) return `active — due in ${days}d ${hours % 24}h`;
    if (hours > 0) return `active — due in ${hours}h`;
    const minutes = Math.floor(ms / 60_000);
    return `active — due in ${minutes}m`;
  }
  return status;
}

function timeAgo(timestamp) {
  const ms = Date.now() - new Date(timestamp).getTime();
  if (ms <= 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 7) {
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
  }
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleHistory(ctx) {
  const user = await upsertUser(ctx.from.id, ctx.from.username);

  // Pull a larger window than we display, then filter to the user's
  // current wallet. Without scoping, multi-wallet users see loans from
  // every linked wallet here — same trust-breaking pattern as Pip /
  // /positions / /health / /calendar. Bump LIMIT to 40 so we still
  // have at least the requested 10 after filtering.
  const { rows: rawRows } = await query(
    `SELECT loan_id, loan_pda, program_id, collateral_mint, collateral_amount,
            original_loan_amount_lamports, ltv_percentage, duration_days,
            status, start_timestamp, due_timestamp,
            (SELECT symbol FROM supported_mints WHERE mint = l.collateral_mint) AS symbol
     FROM loans l
     WHERE user_id = $1
     ORDER BY start_timestamp DESC
     LIMIT 40`,
    [user.id],
  );

  const { filtered, otherWalletCount } = await scopeLoansToActiveWallet(user.id, rawRows);
  const rows = filtered.slice(0, 10);

  if (rows.length === 0) {
    return ctx.reply(
      otherWalletCount > 0
        ? `No loan history on your current wallet.\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch.`
        : "No loan history yet. /borrow to get started.",
    );
  }

  // Lifetime stats across the user's entire account (all linked wallets)
  // so the header gives credit / track-record at a glance — repaid count
  // matters for credit-score context.
  const { rows: [lifetime] } = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='repaid')::int AS repaid,
       COUNT(*) FILTER (WHERE status='liquidated')::int AS liquidated,
       COUNT(*) FILTER (WHERE status='active')::int AS active
     FROM loans WHERE user_id = $1`,
    [user.id],
  );

  const lifetimeParts = [
    `lifetime: ${lifetime.total} loan${lifetime.total === 1 ? "" : "s"}`,
  ];
  if (lifetime.repaid > 0) lifetimeParts.push(`${lifetime.repaid} repaid`);
  if (lifetime.active > 0) lifetimeParts.push(`${lifetime.active} active`);
  if (lifetime.liquidated > 0) lifetimeParts.push(`${lifetime.liquidated} liquidated`);

  const lines = [
    `*Loan History* — last 10 on this wallet`,
    `_${lifetimeParts.join(" · ")}_`,
    "",
  ];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sym = r.symbol ?? `${r.collateral_mint.slice(0, 4)}…`;
    const sol = fmtSol(r.original_loan_amount_lamports);
    const opened = timeAgo(r.start_timestamp);
    const status = statusLabel(r.status, r.due_timestamp);
    lines.push(
      `${i + 1}. *${sym}* — ${sol} SOL · ${r.ltv_percentage}% LTV · ${r.duration_days}d term`,
      `   Opened ${opened} · ${status}`,
      "",
    );
  }

  if (otherWalletCount > 0) {
    lines.push(`_+${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch._`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
