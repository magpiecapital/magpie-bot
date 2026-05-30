/**
 * CLI: pool-stats — formatted snapshot of the lending pool's economic state.
 *
 * Usage:
 *   railway run --service=magpie-bot node scripts/pool-stats.js
 *   node scripts/pool-stats.js     # local (uses .env)
 */
import "dotenv/config";

function fmtSol(lamports, decimals = 6) {
  return (Number(lamports) / 1e9).toFixed(decimals) + " SOL";
}
function pad(s, n) { return String(s).padEnd(n); }

async function main() {
  const { PublicKey } = await import("@solana/web3.js");
  const { getReadOnlyProgram } = await import("../src/solana/program.js");
  const { lendingPoolPda } = await import("../src/solana/pdas.js");
  const { query } = await import("../src/db/pool.js");

  const lender = new PublicKey(process.env.LENDER_PUBKEY);
  const [poolPda] = lendingPoolPda(lender);
  const program = getReadOnlyProgram();
  const p = await program.account.lendingPool.fetch(poolPda);

  const protocolBps = Number(p.protocolFeeBps);
  const feesLamports = Number(p.totalFeesEarned);
  const protocolShare = (feesLamports * protocolBps) / 10_000;
  const lpShare = feesLamports - protocolShare;

  console.log();
  console.log("════════════════════════════════════════════════════════════");
  console.log("  MAGPIE POOL — economic snapshot");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Pool PDA          ${poolPda.toBase58()}`);
  console.log(`  Authority         ${p.authority.toBase58()}`);
  console.log(`  Loan token        ${p.loanTokenMint.toBase58().slice(0, 8)}… (wSOL)`);
  console.log(`  Protocol cut      ${(protocolBps / 100).toFixed(2)}% of every fee`);
  console.log(`  Keeper reward     ${(Number(p.keeperRewardBps) / 100).toFixed(2)}% of seized collateral`);
  console.log(`  Paused            ${p.paused}`);
  console.log();
  console.log("  ────────── balances ──────────");
  console.log(`  Total deposits    ${fmtSol(p.totalDeposits)}`);
  console.log(`  Outstanding       ${fmtSol(p.totalBorrowed)}`);
  console.log(`  Utilization       ${
    Number(p.totalDeposits) > 0
      ? ((Number(p.totalBorrowed) / Number(p.totalDeposits)) * 100).toFixed(1) + "%"
      : "n/a"
  }`);
  console.log();
  console.log("  ────────── fees earned (gross) ──────────");
  console.log(`  Lifetime          ${fmtSol(feesLamports)}`);
  console.log(`    → Protocol      ${fmtSol(protocolShare)}  (your wallet)`);
  console.log(`    → LP share      ${fmtSol(lpShare)}  (stays in pool)`);
  console.log();
  console.log("  ────────── volume ──────────");
  console.log(`  Total loans       ${p.totalLoansIssued.toString()}`);
  console.log(`  Liquidations      ${p.totalLiquidations.toString()}`);

  // DB aggregates
  const { rows: byStatus } = await query(
    `SELECT status, COUNT(*)::int n, COALESCE(SUM(original_loan_amount_lamports::numeric), 0)::text total
       FROM loans GROUP BY status`,
  );
  console.log();
  console.log("  ────────── DB loan breakdown ──────────");
  for (const row of byStatus) {
    console.log(`  ${pad(row.status, 12)} ${pad(row.n + " loans", 12)} ${fmtSol(row.total)}`);
  }

  const { rows: feesByPeriod } = await query(
    `SELECT
       SUM(CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                ELSE original_loan_amount_lamports::numeric * 150 / 10000 END)::text AS lifetime,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '24 hours' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS day,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '7 days' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS week
       FROM loans`,
  );
  if (feesByPeriod[0]) {
    console.log();
    console.log("  ────────── fee origination by period ──────────");
    console.log(`  Last 24h          ${fmtSol(feesByPeriod[0].day || "0")}`);
    console.log(`  Last 7d           ${fmtSol(feesByPeriod[0].week || "0")}`);
    console.log(`  Lifetime (DB)     ${fmtSol(feesByPeriod[0].lifetime || "0")}`);
  }

  const { rows: topMints } = await query(
    `SELECT sm.symbol, COUNT(*)::int loans,
            COALESCE(SUM(l.original_loan_amount_lamports::numeric), 0)::text vol
       FROM loans l LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       GROUP BY sm.symbol ORDER BY loans DESC LIMIT 5`,
  );
  if (topMints.length) {
    console.log();
    console.log("  ────────── top collateral tokens ──────────");
    for (const t of topMints) {
      console.log(`  ${pad(t.symbol || "?", 10)} ${pad(t.loans + " loans", 12)} ${fmtSol(t.vol)}`);
    }
  }

  const { rows: [u] } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users,
       (SELECT COUNT(DISTINCT user_id)::int FROM loans) AS borrowers`,
  );
  console.log();
  console.log("  ────────── users ──────────");
  console.log(`  Total users       ${u.users}`);
  console.log(`  Unique borrowers  ${u.borrowers}`);
  console.log();
  console.log("════════════════════════════════════════════════════════════");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
