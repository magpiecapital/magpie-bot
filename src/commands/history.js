import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";

const STATUS_EMOJI = {
  active: "🟢",
  repaid: "✅",
  liquidated: "💀",
};

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
        ? `📜 No loan history on your current wallet.\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch.`
        : "📜 No loan history yet. /borrow to get started.",
    );
  }

  const lines = ["📜 *Loan History* (last 10 on this wallet)", ""];
  for (const r of rows) {
    const sym = r.symbol ?? `${r.collateral_mint.slice(0, 4)}…`;
    const sol = (Number(r.original_loan_amount_lamports) / 1e9).toFixed(4);
    const date = new Date(r.start_timestamp).toISOString().slice(0, 10);
    lines.push(
      `${STATUS_EMOJI[r.status] ?? "•"} #${r.loan_id} — ${sol} SOL vs ${sym} ` +
        `(${r.ltv_percentage}%/${r.duration_days}d) — ${r.status} — ${date}`,
    );
  }
  if (otherWalletCount > 0) {
    lines.push("", `_+${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on another linked wallet — /wallets to switch._`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
