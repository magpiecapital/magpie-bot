import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";

const STATUS_EMOJI = {
  active: "🟢",
  repaid: "✅",
  liquidated: "💀",
};

export async function handleHistory(ctx) {
  const user = await upsertUser(ctx.from.id, ctx.from.username);

  const { rows } = await query(
    `SELECT loan_id, collateral_mint, collateral_amount,
            original_loan_amount_lamports, ltv_percentage, duration_days,
            status, start_timestamp, due_timestamp,
            (SELECT symbol FROM supported_mints WHERE mint = l.collateral_mint) AS symbol
     FROM loans l
     WHERE user_id = $1
     ORDER BY start_timestamp DESC
     LIMIT 10`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply("📜 No loan history yet. /borrow to get started.");
  }

  const lines = ["📜 *Loan History* (last 10)", ""];
  for (const r of rows) {
    const sym = r.symbol ?? `${r.collateral_mint.slice(0, 4)}…`;
    const sol = (Number(r.original_loan_amount_lamports) / 1e9).toFixed(4);
    const date = new Date(r.start_timestamp).toISOString().slice(0, 10);
    lines.push(
      `${STATUS_EMOJI[r.status] ?? "•"} #${r.loan_id} — ${sol} SOL vs ${sym} ` +
        `(${r.ltv_percentage}%/${r.duration_days}d) — ${r.status} — ${date}`,
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
