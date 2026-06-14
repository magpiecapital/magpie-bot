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

    // ── Snapshot reward tracker (MGP-001 four-channel split) ───────
    // Operator-requested 2026-06-13: users want to see how much in
    // fees the protocol has accrued toward each upcoming reward
    // snapshot, plus a history of prior snapshot distributions.
    //
    // INTENTIONALLY OMITTED: next_distribution_at timing — operator
    // rule (memory: governance_snapshot_internal) keeps the random
    // 5-10 day window internal so mercenary holders can't time
    // buy-just-before / dump-just-after the snapshot.
    //
    // Queries are best-effort: a fresh deploy that hasn't applied
    // migration 049 (protocol_reserve_pool) or has empty pool tables
    // shouldn't crash /stats. Each block catches and degrades to —.
    let holderAccrued = 0n, lpAccrued = 0n, reserveAccrued = 0n, refAccrued = 0n;
    let priorSnapshots = [];
    try {
      const { rows: [hp] } = await query(
        `SELECT COALESCE(accrued_lamports, 0)::text AS accr FROM magpie_holder_pool WHERE id = 1`,
      );
      if (hp?.accr) holderAccrued = BigInt(hp.accr);
    } catch { /* table absent in old deploys */ }
    try {
      const { rows: [lp] } = await query(
        `SELECT COALESCE(accrued_lamports, 0)::text AS accr FROM lp_loyalty_pool WHERE id = 1`,
      );
      if (lp?.accr) lpAccrued = BigInt(lp.accr);
    } catch { /* */ }
    try {
      const { rows: [pr] } = await query(
        `SELECT COALESCE(accrued_lamports, 0)::text AS accr FROM protocol_reserve_pool WHERE id = 1`,
      );
      if (pr?.accr) reserveAccrued = BigInt(pr.accr);
    } catch { /* migration 049 not yet applied */ }
    try {
      const { rows: [r] } = await query(
        `SELECT COALESCE(SUM(reward_lamports::numeric) FILTER (WHERE status = 'accrued'), 0)::text AS accr
           FROM referral_earnings`,
      );
      if (r?.accr) refAccrued = BigInt(r.accr);
    } catch { /* */ }
    try {
      const { rows } = await query(
        `SELECT id,
                snapshot_at,
                pool_lamports::text AS pool,
                holder_count,
                eligible_count
           FROM magpie_holder_distributions
          ORDER BY snapshot_at DESC
          LIMIT 5`,
      );
      priorSnapshots = rows;
    } catch { /* table absent */ }
    const totalAccrued = holderAccrued + lpAccrued + reserveAccrued + refAccrued;
    const r = counts[0];

    // ── Defaulted-loan profit (2026-06-14 policy, Phase 1B) ──────
    // When a non-$MAGPIE collateralized loan defaults, the protocol
    // sells the seized collateral; the NET profit (proceeds minus
    // principal lent) is distributed 70/10/10/10 to holders / LP
    // loyalty / referrer (rolls to holders if none) / protocol reserve.
    // When $MAGPIE is the collateral, the seized $MAGPIE is burned
    // instead — operator-manual burn path, recorded but not summed
    // into the profit total.
    //
    // Best-effort reads; missing migration 059 (fresh deploy) degrades
    // to zeros without crashing /stats.
    let defaultProfitLifetime = 0n, defaultProfitLast24h = 0n;
    let defaultedLoansWithProfit = 0;
    let defaultsAwaitingSale = 0;
    let defaultsAwaitingDistribution = 0n;
    let magpieBurnedCount = 0, magpieBurnPendingCount = 0;
    try {
      const { rows: [agg] } = await query(
        `SELECT
           COALESCE(SUM(net_profit_lamports) FILTER (
             WHERE net_profit_lamports > 0 AND distribution_status != 'loss'
           ), 0)::text AS profit_lifetime,
           COALESCE(SUM(net_profit_lamports) FILTER (
             WHERE net_profit_lamports > 0
               AND distribution_status != 'loss'
               AND sale_detected_at > NOW() - INTERVAL '24 hours'
           ), 0)::text AS profit_24h,
           COUNT(*) FILTER (
             WHERE net_profit_lamports > 0 AND distribution_status != 'loss'
           )::int AS profitable_count,
           COUNT(*) FILTER (WHERE distribution_status = 'pending_sale')::int AS pending_sale_count,
           COALESCE(SUM(net_profit_lamports) FILTER (
             WHERE distribution_status = 'awaiting_distribution'
           ), 0)::text AS awaiting_dist,
           COUNT(*) FILTER (WHERE distribution_status = 'magpie_burn_pending')::int AS magpie_pending,
           COUNT(*) FILTER (WHERE distribution_status = 'magpie_burned')::int AS magpie_burned
         FROM liquidation_economics`,
      );
      if (agg) {
        defaultProfitLifetime = BigInt(agg.profit_lifetime || "0");
        defaultProfitLast24h = BigInt(agg.profit_24h || "0");
        defaultedLoansWithProfit = Number(agg.profitable_count || 0);
        defaultsAwaitingSale = Number(agg.pending_sale_count || 0);
        defaultsAwaitingDistribution = BigInt(agg.awaiting_dist || "0");
        magpieBurnedCount = Number(agg.magpie_burned || 0);
        magpieBurnPendingCount = Number(agg.magpie_pending || 0);
      }
    } catch { /* migration 059 not applied yet — degrade silently */ }

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

    // Render the prior-snapshot history rows. Each row is one past
    // distribution; empty array → "first snapshot pending" placeholder.
    const snapshotHistoryRows = priorSnapshots.length === 0
      ? [row("(no snapshots yet)", "")]
      : priorSnapshots
          .slice()
          .reverse() // chronological inside the section even though SQL DESC
          .map((s, idx) => {
            const date = new Date(s.snapshot_at).toISOString().slice(0, 10);
            const amount = fmtSol(s.pool);
            return row(`#${idx + 1} ${date}`, `${amount} SOL → ${s.eligible_count} holders`);
          });

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
      ``,
      `REWARDS — ACCRUING TOWARD NEXT SNAPSHOT`,
      row("$MAGPIE holders (70%)", `${fmtSol(holderAccrued.toString())} SOL`),
      row("SOL LPs (10%)",        `${fmtSol(lpAccrued.toString())} SOL`),
      row("Referrers (10%)",       `${fmtSol(refAccrued.toString())} SOL`),
      row("Protocol reserve (10%)",`${fmtSol(reserveAccrued.toString())} SOL`),
      row("Total accruing",        `${fmtSol(totalAccrued.toString())} SOL`),
      ``,
      `REWARDS — PRIOR SNAPSHOTS ($MAGPIE holders)`,
      ...snapshotHistoryRows,
      // Defaulted-loan profit section. Only renders when ANY meaningful
      // signal is present, to avoid noisy empty rows on fresh deploys.
      ...((defaultProfitLifetime > 0n || defaultedLoansWithProfit > 0 ||
           defaultsAwaitingSale > 0 || magpieBurnedCount > 0 || magpieBurnPendingCount > 0)
        ? [
            ``,
            `DEFAULTED-LOAN PROFIT (auto to rewards pool)`,
            row("Lifetime profit", `${fmtSol(defaultProfitLifetime.toString())} SOL`),
            row("Last 24h",        `${fmtSol(defaultProfitLast24h.toString())} SOL`),
            row("Profitable defaults", String(defaultedLoansWithProfit)),
            ...(defaultsAwaitingSale > 0
              ? [row("Awaiting sale", String(defaultsAwaitingSale))] : []),
            ...(defaultsAwaitingDistribution > 0n
              ? [row("Pending distribute", `${fmtSol(defaultsAwaitingDistribution.toString())} SOL`)] : []),
            ...(magpieBurnPendingCount > 0 || magpieBurnedCount > 0
              ? [row("$MAGPIE burns", `${magpieBurnedCount} done / ${magpieBurnPendingCount} pending`)] : []),
          ]
        : []),
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
