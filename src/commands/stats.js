import { PublicKey } from "@solana/web3.js";
import { getReadOnlyProgram, PROGRAM_ID, PROGRAM_ID_V2, PROGRAM_ID_V3, PROGRAM_ID_V4 } from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import { getBurnSummary } from "../services/magpie-burns.js";
import { isAdmin } from "../services/admin.js";
import { getDistributionFunderStatus } from "../services/distribution-auto-funder.js";

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

// OPERATOR-ONLY: the autonomous rewards-funder true picture. The point (per the
// operator) is that a transient lag must never READ as a shortfall — so this
// shows CHCAM-spendable vs owed vs gap PLUS a plain-English verdict, so the
// operator stops pre-funding phantoms. Wallet balances are operator-private, so
// this block is gated to admins and never rendered in public /stats.
function renderFunderHealth(fs) {
  if (!fs) return [];
  const fmt2 = (n) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(2));
  const verdictLine = {
    healthy:        "✓ healthy — CHCAM covers all owed",
    catching_up:    "⏳ catching up — auto-funds ≤5m (transient, do NOT hand-fund)",
    lender_limited: "⚠ lender-limited — real revenue lag; investigate, do NOT hand-fund",
    paused:         "⏸ PAUSED — DIST_FUNDER_DISABLED is set",
    unknown:        "… status unavailable (RPC)",
  }[fs.verdict] || fs.verdict;

  const out = [
    ``,
    `REWARDS FUNDER (autonomous · ops-only)`,
    row("CHCAM spendable", `${fmt2(fs.distribution_spendable_sol)} SOL`),
    row("Owed (holder+LP)", `${fmt2(fs.payable_owed_sol)} SOL`),
  ];
  // Only show the gap line when there actually is one — keeps the healthy
  // readout terse.
  if ((fs.current_gap_sol ?? 0) >= 0.005) {
    out.push(row("Gap", `${fmt2(fs.current_gap_sol)} SOL`));
    out.push(row("Lender available", `${fmt2(fs.lender_available_sol)} SOL`));
  }
  // The verdict can exceed the column width — render it on its own indented
  // line rather than squeezing it into the two-column row().
  out.push(`  ${verdictLine}`);
  return out;
}

export async function handleStats(ctx) {
  const lenderPubkey = process.env.LENDER_PUBKEY;
  if (!lenderPubkey) return ctx.reply("Stats not configured (LENDER_PUBKEY missing).");

  try {
    // Read all three pool snapshots in parallel. V2 is legacy RWA; V3
    // is the live RWA + memecoin dual-tier pool. Fees flow to the same
    // LENDER_PUBKEY wSOL ATA across all three programs, so the protocol
    // view of fees-earned is V1 + V2 + V3. If V2 or V3 is not configured
    // (env missing) or RPC blips on a per-pool read, we gracefully
    // continue with whatever loaded — keeps /stats working in dev /
    // staging where only a subset of pools may be deployed.
    const v1 = await fetchPoolSnapshot(PROGRAM_ID);
    let v2 = null;
    if (PROGRAM_ID_V2) {
      try { v2 = await fetchPoolSnapshot(PROGRAM_ID_V2); }
      catch (err) {
        console.warn("[stats] V2 pool read failed:", err.message);
      }
    }
    let v3 = null;
    if (PROGRAM_ID_V3) {
      try { v3 = await fetchPoolSnapshot(PROGRAM_ID_V3); }
      catch (err) {
        console.warn("[stats] V3 pool read failed:", err.message);
      }
    }
    let v4 = null;
    if (PROGRAM_ID_V4) {
      try { v4 = await fetchPoolSnapshot(PROGRAM_ID_V4); }
      catch (err) {
        console.warn("[stats] V4 pool read failed:", err.message);
      }
    }

    const totalDeposits = v1.totalDeposits + (v2?.totalDeposits ?? 0n) + (v3?.totalDeposits ?? 0n) + (v4?.totalDeposits ?? 0n);
    const totalFeesEarned = v1.totalFeesEarned + (v2?.totalFeesEarned ?? 0n) + (v3?.totalFeesEarned ?? 0n) + (v4?.totalFeesEarned ?? 0n);
    const totalLoansIssued = v1.totalLoansIssued + (v2?.totalLoansIssued ?? 0n) + (v3?.totalLoansIssued ?? 0n) + (v4?.totalLoansIssued ?? 0n);
    const totalLiquidations = v1.totalLiquidations + (v2?.totalLiquidations ?? 0n) + (v3?.totalLiquidations ?? 0n) + (v4?.totalLiquidations ?? 0n);
    const totalVaultUi = (v1.vaultUiSol ?? 0) + (v2?.vaultUiSol ?? 0) + (v3?.vaultUiSol ?? 0) + (v4?.vaultUiSol ?? 0);

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
    let priorLpSnapshots = [];
    try {
      const { rows: [hp] } = await query(
        `SELECT COALESCE(accrued_lamports, 0)::text AS accr FROM magpie_holder_pool WHERE id = 1`,
      );
      if (hp?.accr) holderAccrued = BigInt(hp.accr);
    } catch { /* table absent in old deploys */ }
    try {
      // SOL LPs = THIRD-PARTY net (operator's exempt lender wallet taken out of
      // BOTH numerator AND denominator, 2026-07-04) — the third-party LPs split
      // the FULL pool: gross pool × (non-exempt weight / non-exempt weight).
      // Mirrors the distributor + magpie.capital/stats so every surface shows
      // the same number. See feedback_lender_wallet_exempt_from_lp_loyalty.
      const { rows: [lp] } = await query(
        `SELECT COALESCE(
           (SELECT accrued_lamports FROM lp_loyalty_pool WHERE id = 1)::numeric
           * COALESCE(
               (SELECT SUM(shares * EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)))
                  FROM lp_positions
                 WHERE shares > 0 AND EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)) > 0
                   AND wallet_address NOT IN (SELECT wallet_address FROM lp_loyalty_exempt_wallets))
               / NULLIF(
               (SELECT SUM(shares * EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)))
                  FROM lp_positions
                 WHERE shares > 0 AND EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at)) > 0
                   AND wallet_address NOT IN (SELECT wallet_address FROM lp_loyalty_exempt_wallets)), 0)
             , 1)
         , 0)::bigint::text AS accr`,
      );
      if (lp?.accr) lpAccrued = BigInt(lp.accr);
    } catch { /* */ }
    try {
      // Protocol reserve = PER-CYCLE (accrued since the last $MAGPIE snapshot),
      // resets to 0 each distribution — Snapshot-rewards numbers must not
      // accumulate. Mirrors magpie.capital/stats. See
      // feedback_stats_snapshot_rewards_reset_per_cycle.
      const { rows: [pr] } = await query(
        `SELECT COALESCE((
           SELECT SUM(reward_lamports) FROM protocol_reserve_events
            WHERE created_at > COALESCE(
              (SELECT MAX(created_at) FROM magpie_holder_distributions), '1970-01-01'::timestamptz)
         ), 0)::text AS accr`,
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
    // LP loyalty prior snapshots — uniform with the holders block above.
    // Operator-mandated 2026-06-19 PM: every distribution surface must
    // reflect a fired distribution within seconds of it landing.
    try {
      const { rows } = await query(
        `SELECT id,
                snapshot_at,
                pool_lamports::text AS pool,
                eligible_count
           FROM lp_loyalty_distributions
          ORDER BY snapshot_at DESC
          LIMIT 5`,
      );
      priorLpSnapshots = rows;
    } catch { /* table absent on fresh deploys */ }
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
    let defaultsAwaitingDistributionCount = 0;
    let magpieBurnedCount = 0, magpieBurnPendingCount = 0;
    // Mirror site /api/v1/stats — UNION recovery_credits so out-of-band
    // protocol contributions (operator-funded exploit recovery, etc.)
    // count alongside profitable defaults from liquidation_economics.
    // Both flow through the same 80/10/10 split via the distribution
    // watcher. Protocol uniformity rule: site /stats and TG /stats must
    // present identical numbers for identical metrics.
    // [[feedback_protocol_uniformity_non_negotiable]]
    try {
      const { rows: [agg] } = await query(
        `WITH all_profit_events AS (
           SELECT net_profit_lamports, distribution_status, sale_detected_at
             FROM liquidation_economics
           UNION ALL
           SELECT amount_lamports AS net_profit_lamports,
                  distribution_status,
                  created_at AS sale_detected_at
             FROM recovery_credits
             WHERE distribution_status IN ('awaiting_distribution', 'distributing', 'distributed')
         )
         SELECT
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
           COUNT(*) FILTER (WHERE distribution_status = 'awaiting_distribution')::int AS awaiting_dist_count,
           COUNT(*) FILTER (WHERE distribution_status = 'magpie_burn_pending')::int AS magpie_pending,
           COUNT(*) FILTER (WHERE distribution_status = 'magpie_burned')::int AS magpie_burned
         FROM all_profit_events`,
      ).catch(async () => {
        // Fallback when recovery_credits table doesn't exist yet
        // (migration 078 not applied) — read liquidation_economics
        // alone so TG /stats still works.
        return await query(
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
             COUNT(*) FILTER (WHERE distribution_status = 'awaiting_distribution')::int AS awaiting_dist_count,
             COUNT(*) FILTER (WHERE distribution_status = 'magpie_burn_pending')::int AS magpie_pending,
             COUNT(*) FILTER (WHERE distribution_status = 'magpie_burned')::int AS magpie_burned
           FROM liquidation_economics`,
        );
      });
      if (agg) {
        defaultProfitLifetime = BigInt(agg.profit_lifetime || "0");
        defaultProfitLast24h = BigInt(agg.profit_24h || "0");
        defaultedLoansWithProfit = Number(agg.profitable_count || 0);
        defaultsAwaitingSale = Number(agg.pending_sale_count || 0);
        defaultsAwaitingDistribution = BigInt(agg.awaiting_dist || "0");
        defaultsAwaitingDistributionCount = Number(agg.awaiting_dist_count || 0);
        magpieBurnedCount = Number(agg.magpie_burned || 0);
        magpieBurnPendingCount = Number(agg.magpie_pending || 0);
      }
    } catch { /* migration 059 not applied yet — degrade silently */ }

    // ── Auto-sell (limit-close) fee rollup ────────────────────────
    // The 1% protocol fee on every successful auto-sell fire accrues
    // through limit-close-fee-accrual-watcher.js (same 70/10/10/10
    // split as borrow origination). This rollup makes that revenue
    // line visible in /stats — previously it was correctly distributed
    // to holder + LP + reserve + referrer pools but invisible as a
    // line item. Degrades silently if the table is missing.
    let lcFeesLifetime = 0n, lcFeesLast24h = 0n;
    let lcFiresLifetime = 0, lcFiresLast24h = 0;
    try {
      const { rows: [agg] } = await query(
        `SELECT
           COALESCE(SUM(protocol_fee_lamports::numeric)
             FILTER (WHERE status = 'fired'), 0)::text AS lifetime,
           COALESCE(SUM(protocol_fee_lamports::numeric)
             FILTER (WHERE status = 'fired' AND fired_at > NOW() - INTERVAL '24 hours'), 0)::text AS last24h,
           COUNT(*) FILTER (WHERE status = 'fired')::int AS fires_lifetime,
           COUNT(*) FILTER (WHERE status = 'fired' AND fired_at > NOW() - INTERVAL '24 hours')::int AS fires_24h
         FROM limit_close_orders`,
      );
      if (agg) {
        lcFeesLifetime = BigInt(agg.lifetime || "0");
        lcFeesLast24h = BigInt(agg.last24h || "0");
        lcFiresLifetime = Number(agg.fires_lifetime || 0);
        lcFiresLast24h = Number(agg.fires_24h || 0);
      }
    } catch { /* limit_close_orders table absent — degrade silently */ }

    // $MAGPIE BURNED — read from the magpie_burns ledger so the figure
    // sums every burn path (default-driven, manual operator burns, future
    // buybacks). Single source of truth shared with the site /api/v1/stats
    // endpoint, Pip, and the dashboard tile. Degrades silently on missing
    // migration 061.
    let burnSummary = null;
    try {
      burnSummary = await getBurnSummary();
    } catch { /* migration 061 not applied yet — degrade silently */ }

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
    const lpSnapshotHistoryRows = priorLpSnapshots
      .slice()
      .reverse()
      .map((s, idx) => {
        const date = new Date(s.snapshot_at).toISOString().slice(0, 10);
        const amount = fmtSol(s.pool);
        return row(`#${idx + 1} ${date}`, `${amount} SOL → ${s.eligible_count} LPs`);
      });

    // OPERATOR-ONLY: autonomous rewards-funder health. Best-effort — a funder
    // read failure must never break /stats. Public callers never see this.
    let funderLines = [];
    if (isAdmin(ctx.from?.id)) {
      try {
        funderLines = renderFunderHealth(await getDistributionFunderStatus());
      } catch (e) {
        console.warn("[stats] funder-health read failed:", e.message);
      }
    }

    const codeLines = [
      RULE,
      `LOAN BOOK`,
      row("Currently out", `${activeOutSol} SOL`),
      row("Active loans", String(r.active)),
      row("Issued lifetime", totalLoansIssued.toString()),
      row("Repaid", String(r.repaid)),
      // "Liquidated" uses the DB count (loans.status='liquidated'),
      // not the on-chain pool counter. The on-chain pool counter
      // (totalLiquidations) is a lifetime accumulator that includes
      // pre-DB-tracking program events, devnet test invocations, and
      // historical liquidations whose loans rows were never created.
      // Operator reported TG=44 vs site=11 — 11 is the truthful number
      // (real user loans that got liquidated). DB count matches the
      // site's transparency endpoint exactly. 2026-06-17 04:25 UTC.
      row("Liquidated", String(r.liquidated)),
      ``,
      `POOL${(v2 || v3 || v4) ? ` (${["V1", v2 ? "V2" : null, v3 ? "V3" : null, v4 ? "V4" : null].filter(Boolean).join("+")})` : ""}`,
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
      // OPERATOR-ONLY funder-health (empty array for everyone else).
      ...funderLines,
      ``,
      // Prior-snapshots section only renders once at least one snapshot
      // has happened. Until then, hide the section entirely — operator
      // prefers terse output over an empty placeholder.
      ...(priorSnapshots.length > 0
        ? [
            `REWARDS — PRIOR SNAPSHOTS ($MAGPIE holders)`,
            ...snapshotHistoryRows,
          ]
        : []),
      ...(priorLpSnapshots.length > 0
        ? [
            ``,
            `REWARDS — PRIOR SNAPSHOTS (SOL LPs)`,
            ...lpSnapshotHistoryRows,
          ]
        : []),
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
            ...(defaultsAwaitingDistribution > 0n || defaultsAwaitingDistributionCount > 0
              ? [row("Pending distribute", `${defaultsAwaitingDistributionCount} (${fmtSol(defaultsAwaitingDistribution.toString())} SOL)`)] : []),
            ...(magpieBurnPendingCount > 0 || magpieBurnedCount > 0
              ? [row("$MAGPIE defaults",
                  magpieBurnPendingCount === 0
                    ? `${magpieBurnedCount} — all burned 1:1 ✓`
                    : `${magpieBurnedCount} burned / ${magpieBurnPendingCount} awaiting burn`)] : []),
          ]
        : []),
      // ── AUTO-SELL FEES (limit-close fires) ─────────────────────
      // Surfaces the 1% protocol fee revenue stream from successful
      // auto-sells. This is real revenue that flows into the same
      // 70/10/10/10 split as borrow origination — making it visible
      // here closes the transparency gap the operator flagged.
      // Renders only once a single fire has landed.
      ...(lcFiresLifetime > 0
        ? [
            ``,
            `AUTO-SELLS (1% fee → rewards)`,
            row("Lifetime fires", String(lcFiresLifetime)),
            row("Last 24h fires", String(lcFiresLast24h)),
            row("Lifetime fees", `${fmtSol(lcFeesLifetime.toString())} SOL`),
            row("Last 24h fees", `${fmtSol(lcFeesLast24h.toString())} SOL`),
          ]
        : []),
      // $MAGPIE BURNED — supply contraction headline. Renders whenever
      // the ledger has any entry (always true once the migration's
      // baseline-burn seed lands).
      ...(burnSummary && BigInt(burnSummary.total_raw) > 0n
        ? [
            ``,
            `$MAGPIE BURNED (supply contraction)`,
            row("Total burned", `${burnSummary.total_tokens} $MAGPIE`),
            row("Burn events", String(burnSummary.burn_count)),
            ...(BigInt(burnSummary.by_source.liquidation_default) > 0n
              ? [row("  via defaults", `${burnSummary.by_source_tokens.liquidation_default}`)] : []),
            ...(BigInt(burnSummary.by_source.manual) > 0n
              ? [row("  manual", `${burnSummary.by_source_tokens.manual}`)] : []),
            ...(BigInt(burnSummary.by_source.buyback) > 0n
              ? [row("  buybacks", `${burnSummary.by_source_tokens.buyback}`)] : []),
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
