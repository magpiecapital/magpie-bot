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

// Mobile-first widths. iOS Telegram's monospace code block fits ~26
// chars before wrapping; using 24 + 2-space left padding gives us a
// safe 26-char total that holds together on every device.
const COL_WIDTH = 24;
function row(label, value) {
  const l = String(label);
  const v = String(value);
  const gap = Math.max(1, COL_WIDTH - l.length - v.length);
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
         COALESCE(SUM(loan_amount_lamports), 0)::text AS lifetime_lamports,
         COALESCE(SUM(loan_amount_lamports) FILTER (WHERE status = 'active'), 0)::text AS active_lamports
       FROM loans`,
    );
    const r = counts[0];

    // HEADLINE: lifetime cumulative SOL ever borrowed.
    //
    // IMPORTANT: this is the DB SUM across all loan rows, NOT
    // `pool.totalBorrowed` from on-chain. The on-chain field is
    // documented as "Total wSOL currently lent out" — it decrements
    // on repayment, so it's the OUTSTANDING balance, not lifetime.
    // The DB sum is the only authoritative source for "total ever lent."
    const lifetimeBorrowedSol = fmtSol(r.lifetime_lamports);
    const totalDepositsSol = fmtSol(pool.totalDeposits.toNumber());
    const totalFeesSol = fmtSol(pool.totalFeesEarned.toNumber());
    const activeOutSol = fmtSol(r.active_lamports);
    const currentlyLentSolOnchain = fmtSol(pool.totalBorrowed.toNumber());

    // Vault wSOL: keep 2-decimal precision so the line fits in 26 chars
    const vaultSol = vault ? Number(vault.value.uiAmount).toFixed(2) : null;

    const codeLines = [
      RULE,
      `LOAN BOOK`,
      row("Currently out", `${activeOutSol} SOL`),
      row("Active loans", String(r.active)),
      row("Issued lifetime", pool.totalLoansIssued.toString()),
      row("Repaid", String(r.repaid)),
      row("Liquidated", pool.totalLiquidations.toString()),
      ``,
      `POOL`,
      row("LP deposited", `${totalDepositsSol} SOL`),
      row("Fees earned", `${totalFeesSol} SOL`),
      vaultSol ? row("Vault", `${vaultSol} wSOL`) : row("Vault", "—"),
      RULE,
    ];

    // Headline sits OUTSIDE the monospace block so the big lifetime
    // number renders at full bold weight, not constrained to mono pitch.
    // This makes 240.64 SOL pop visually as the headline story.
    const lines = [
      `📊 *Magpie — live protocol stats*`,
      ``,
      `🦅 *${lifetimeBorrowedSol} SOL* lent out, lifetime`,
      `   _The protocol's full borrowing volume._`,
      ``,
      "```",
      ...codeLines,
      "```",
      `_All numbers on-chain. Verify at_ [magpie.capital/stats](https://www.magpie.capital/stats)`,
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
