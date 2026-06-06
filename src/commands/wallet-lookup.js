/**
 * /walletlookup <pubkey> — public lookup of any wallet's Magpie footprint.
 *
 * Returns aggregate stats anyone could derive from on-chain + the
 * public /api/v1/loans endpoint. No private data:
 *   - Loans count (active / repaid / liquidated)
 *   - Lifetime volume
 *   - Default rate
 *   - Linked to a Magpie account (yes/no — username NOT revealed)
 *
 * Useful for reputation checks before P2P trades, due diligence on a
 * counterparty, or just curiosity. Strictly read-only.
 */
import { query } from "../db/pool.js";
import { PublicKey } from "@solana/web3.js";

function fmtSol(lamports) {
  if (lamports == null) return "0";
  return (Number(lamports) / 1e9).toFixed(4);
}

function isValidPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export async function handleWalletLookup(ctx) {
  const arg = (ctx.message?.text || "").split(/\s+/)[1];
  if (!arg) {
    return ctx.reply(
      "Usage: `/walletlookup <wallet pubkey>`\n\nReturns Magpie history for any wallet.",
      { parse_mode: "Markdown" },
    );
  }
  if (!isValidPubkey(arg)) {
    return ctx.reply("That doesn't look like a valid Solana pubkey.");
  }

  const [
    { rows: [walletRow] },
    { rows: [loans] },
  ] = await Promise.all([
    query(`SELECT id FROM wallets WHERE public_key = $1 LIMIT 1`, [arg]),
    query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE status = 'repaid')::int AS repaid,
         COUNT(*) FILTER (WHERE status = 'liquidated')::int AS liquidated,
         COALESCE(SUM(original_loan_amount_lamports::numeric), 0)::text AS volume_lamports,
         MIN(start_timestamp) AS first_loan_at,
         MAX(start_timestamp) AS last_loan_at
       FROM loans
        WHERE user_id = (SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1)`,
      [arg],
    ),
  ]);

  const finalized = loans.repaid + loans.liquidated;
  const defaultRatePct = finalized > 0 ? ((loans.liquidated / finalized) * 100).toFixed(2) : "—";

  const lines = [
    `🔎 *Wallet \`${arg.slice(0, 8)}…${arg.slice(-6)}\`*`,
    "",
    `Magpie account: ${walletRow ? "✓ linked" : "—"}`,
    "",
    "*Loan history:*",
    `  Total:       ${loans.total}`,
    `  Active:      ${loans.active}`,
    `  Repaid:      ${loans.repaid}`,
    `  Liquidated:  ${loans.liquidated}`,
    `  Default rate: ${defaultRatePct}%`,
    `  Volume:      ${fmtSol(loans.volume_lamports)} SOL`,
  ];
  if (loans.first_loan_at) {
    const days = Math.floor((Date.now() - new Date(loans.first_loan_at).getTime()) / 86_400_000);
    lines.push(`  Account age: ${days} days`);
  }

  lines.push("", `[Solscan](https://solscan.io/account/${arg})`);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}
