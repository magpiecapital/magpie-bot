import { PublicKey } from "@solana/web3.js";
import { getReadOnlyProgram, PROGRAM_ID } from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

export async function handleStats(ctx) {
  const lenderPubkey = process.env.LENDER_PUBKEY;
  if (!lenderPubkey) return ctx.reply("Stats not configured (LENDER_PUBKEY missing).");

  try {
    const program = getReadOnlyProgram();
    const [poolPda] = lendingPoolPda(new PublicKey(lenderPubkey));
    const pool = await program.account.lendingPool.fetch(poolPda);

    const [vaultPda] = loanTokenVaultPda(poolPda);
    const vault = await connection.getTokenAccountBalance(vaultPda).catch(() => null);

    const { rows: counts } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active,
         COUNT(*) FILTER (WHERE status = 'repaid') AS repaid,
         COUNT(*) FILTER (WHERE status = 'liquidated') AS liquidated,
         COALESCE(SUM(original_loan_amount_lamports) FILTER (WHERE status = 'active'), 0) AS active_lamports
       FROM loans`,
    );
    const row = counts[0];

    const lines = [
      "📊 *Magpie Stats*",
      "",
      `Program: \`${PROGRAM_ID.toBase58()}\``,
      "",
      "*On-chain:*",
      `• Total deposits:    ${(pool.totalDeposits.toNumber() / 1e9).toFixed(4)} SOL`,
      `• Total borrowed:    ${(pool.totalBorrowed.toNumber() / 1e9).toFixed(4)} SOL`,
      `• Total shares:      ${pool.totalShares.toString()}`,
      `• Loans issued:      ${pool.totalLoansIssued.toString()}`,
      `• Liquidations:      ${pool.totalLiquidations.toString()}`,
      `• Fees earned:       ${(pool.totalFeesEarned.toNumber() / 1e9).toFixed(4)} SOL`,
      vault ? `• Vault balance:     ${vault.value.uiAmount} wSOL` : "• Vault balance:     unknown",
      "",
      "*Active book:*",
      `• Active loans:      ${row.active}`,
      `• Repaid loans:      ${row.repaid}`,
      `• Liquidated loans:  ${row.liquidated}`,
      `• Outstanding debt:  ${(Number(row.active_lamports) / 1e9).toFixed(4)} SOL`,
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("stats failed:", err);
    await ctx.reply(
      [
        "⚠️ *Stats briefly unavailable*",
        "",
        "Couldn't fetch live protocol stats right now. Usually clears within a minute.",
        "",
        "Try /stats again, or check magpie.capital/dashboard directly.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }
}
