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
      `• Loans issued:      ${pool.totalLoansIssued.toString()}`,
      `• Liquidations:      ${pool.totalLiquidations.toString()}`,
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
    await ctx.reply(`❌ Could not fetch stats: ${err.message}`);
  }
}
