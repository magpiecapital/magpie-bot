import { PublicKey } from "@solana/web3.js";
import { getReadOnlyProgram, PROGRAM_ID } from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

/**
 * /stats — unified protocol-stats readout (works in DM and groups).
 *
 * The HEADLINE is the lifetime total SOL borrowed, pulled from the
 * on-chain `pool.totalBorrowed` counter — that's the cumulative number
 * the protocol has ever lent out, the "229.2 SOL" story. It's the
 * single most important number for the community to see.
 *
 * Below the headline, a monospace block lays out the rest of the
 * numbers in a clean two-column tabular format that reads identically
 * on every TG client (iOS / Android / desktop).
 */

const COL_WIDTH = 36;
function row(label, value) {
  const l = String(label);
  const v = String(value);
  const gap = Math.max(2, COL_WIDTH - l.length - v.length);
  return `  ${l}${" ".repeat(gap)}${v}`;
}
const RULE = "─".repeat(COL_WIDTH + 2);
function fmtSol(lamports) {
  const n = Number(lamports) / 1e9;
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

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
         COUNT(*) FILTER (WHERE status = 'active')::int     AS active,
         COUNT(*) FILTER (WHERE status = 'repaid')::int     AS repaid,
         COUNT(*) FILTER (WHERE status = 'liquidated')::int AS liquidated,
         COALESCE(SUM(original_loan_amount_lamports) FILTER (WHERE status = 'active'), 0)::text AS active_lamports
       FROM loans`,
    );
    const r = counts[0];

    // Headline number — authoritative on-chain cumulative
    const lifetimeBorrowedSol = fmtSol(pool.totalBorrowed.toNumber());
    const totalDepositsSol = fmtSol(pool.totalDeposits.toNumber());
    const totalFeesSol = fmtSol(pool.totalFeesEarned.toNumber());
    const activeOutSol = fmtSol(r.active_lamports);

    const codeLines = [
      RULE,
      row("TOTAL BORROWED (LIFETIME)", `${lifetimeBorrowedSol} SOL`),
      RULE,
      ``,
      `LOAN BOOK — RIGHT NOW`,
      row("Currently out on loan", `${activeOutSol} SOL`),
      row("Active loans", String(r.active)),
      row("Lifetime loans issued", pool.totalLoansIssued.toString()),
      row("Lifetime repaid", String(r.repaid)),
      row("Lifetime liquidated", pool.totalLiquidations.toString()),
      ``,
      `POOL`,
      row("LP deposited (on-chain)", `${totalDepositsSol} SOL`),
      row("Lifetime fees earned", `${totalFeesSol} SOL`),
      vault ? row("Vault balance", `${Number(vault.value.uiAmount).toFixed(4)} wSOL`) : row("Vault balance", "—"),
      RULE,
    ];

    const lines = [
      "📊 *Magpie — live protocol stats*",
      "```",
      ...codeLines,
      "```",
      `_All numbers on-chain. Verify any line at_ [solscan.io](https://solscan.io) _or_ [magpie.capital/stats](https://www.magpie.capital/stats)_._`,
      ``,
      `_Program:_ \`${PROGRAM_ID.toBase58()}\``,
    ];

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("stats failed:", err);
    await ctx.reply(
      [
        "⚠️ *Stats briefly unavailable*",
        "",
        "Couldn't fetch live protocol stats right now. Usually clears within a minute.",
        "",
        "Try /stats again, or check magpie.capital/stats directly.",
      ].join("\n"),
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  }
}
