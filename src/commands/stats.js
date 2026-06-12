import { PublicKey } from "@solana/web3.js";
import { getReadOnlyProgram, PROGRAM_ID, PROGRAM_ID_V2 } from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

// Helper: fetch a single pool's on-chain snapshot for the /stats roll-up.
// Pool layouts are identical between V1 and V2 across the fields we read
// here (totalDeposits, totalBorrowed, totalFeesEarned, totalLoansIssued,
// totalLiquidations); V2 just drops fee_wallet — we don't touch it. The
// IDL-aware getReadOnlyProgram now hands back the matching layout per
// programId so the deserialize is correct for both.
async function fetchPoolSnapshot(programId) {
  const program = getReadOnlyProgram(programId);
  const lenderPubkey = new PublicKey(process.env.LENDER_PUBKEY);
  const [poolPda] = lendingPoolPda(lenderPubkey, programId);
  const pool = await program.account.lendingPool.fetch(poolPda);
  const [vaultPda] = loanTokenVaultPda(poolPda, programId);
  const vault = await connection.getTokenAccountBalance(vaultPda).catch(() => null);
  return {
    poolPda,
    vaultPda,
    totalDeposits: BigInt(pool.totalDeposits.toString()),
    totalBorrowed: BigInt(pool.totalBorrowed.toString()),
    totalFeesEarned: BigInt(pool.totalFeesEarned.toString()),
    totalLoansIssued: BigInt(pool.totalLoansIssued.toString()),
    totalLiquidations: BigInt(pool.totalLiquidations.toString()),
    vaultUiSol: vault ? Number(vault.value.uiAmount) : null,
  };
}

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
    // Read BOTH pool snapshots in parallel. V2 is the RWA-capable pool
    // (tokenized stocks etc.); fees flow to the same LENDER_PUBKEY wSOL
    // ATA via the authority-signed borrow path, so the protocol view of
    // fees-earned is V1 + V2. If V2 is not configured (env missing), we
    // gracefully skip — keeps /stats working in dev / staging where only
    // V1 is set up.
    const [v1] = await Promise.all([
      fetchPoolSnapshot(PROGRAM_ID),
    ]);
    let v2 = null;
    if (PROGRAM_ID_V2) {
      try { v2 = await fetchPoolSnapshot(PROGRAM_ID_V2); }
      catch (err) {
        // Don't fail the whole /stats if V2 is uninitialized or RPC blips
        // on it — just report what we have. Logged so we notice persistent
        // V2 read failures.
        console.warn("[stats] V2 pool read failed (continuing with V1 only):", err.message);
      }
    }

    const totalDeposits = v1.totalDeposits + (v2?.totalDeposits ?? 0n);
    const totalFeesEarned = v1.totalFeesEarned + (v2?.totalFeesEarned ?? 0n);
    const totalLoansIssued = v1.totalLoansIssued + (v2?.totalLoansIssued ?? 0n);
    const totalLiquidations = v1.totalLiquidations + (v2?.totalLiquidations ?? 0n);
    const totalVaultUi = (v1.vaultUiSol ?? 0) + (v2?.vaultUiSol ?? 0);

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

    // HEADLINE: lifetime cumulative SOL ever borrowed — DB SUM across
    // all loan rows (pool-agnostic; both V1 and V2 borrows land in
    // `loans` via the same recordLoan path). On-chain `totalBorrowed`
    // is OUTSTANDING balance not lifetime, so DB SUM is authoritative.
    const lifetimeBorrowedSol = fmtSol(r.lifetime_lamports);
    const totalDepositsSol = fmtSol(totalDeposits);
    const totalFeesSol = fmtSol(totalFeesEarned);
    const activeOutSol = fmtSol(r.active_lamports);

    const vaultSol = (v1.vaultUiSol != null || v2?.vaultUiSol != null)
      ? totalVaultUi.toFixed(2)
      : null;

    const codeLines = [
      RULE,
      `LOAN BOOK`,
      row("Currently out", `${activeOutSol} SOL`),
      row("Active loans", String(r.active)),
      row("Issued lifetime", totalLoansIssued.toString()),
      row("Repaid", String(r.repaid)),
      row("Liquidated", totalLiquidations.toString()),
      ``,
      `POOL${v2 ? " (V1+V2)" : ""}`,
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
