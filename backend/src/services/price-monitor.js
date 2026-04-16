/**
 * Polls every active loan and flags those that need liquidation because:
 *   (a) collateral value in SOL has dropped too close to the outstanding
 *       loan amount, or
 *   (b) the loan's due_timestamp has passed.
 *
 * All math is done in lamports to match the on-chain representation.
 */
import { getAllActiveLoans } from "../utils/anchor-client.js";
import { getPriceInSol, lamportsFromCollateral } from "../utils/price.js";
import { config } from "../config/index.js";

async function fetchDecimals(connection, mintPubkey, cache) {
  const key = mintPubkey.toBase58();
  if (cache.has(key)) return cache.get(key);
  const info = await connection.getParsedAccountInfo(mintPubkey);
  const decimals = info.value?.data?.parsed?.info?.decimals;
  if (decimals == null) throw new Error(`Could not read decimals for mint ${key}`);
  cache.set(key, decimals);
  return decimals;
}

async function checkLoan(loan, connection, decimalsCache) {
  const data = loan.account;
  const loanId = data.loanId.toString();
  const mint = data.collateralMint;

  try {
    const [priceSol, decimals] = await Promise.all([
      getPriceInSol(mint.toBase58()),
      fetchDecimals(connection, mint, decimalsCache),
    ]);

    if (priceSol == null) {
      return { loanId, needsLiquidation: false, reason: "Price unavailable" };
    }

    const currentValueLamports = lamportsFromCollateral(
      data.collateralAmount,
      priceSol,
      decimals,
    );
    const loanLamports = Number(data.originalLoanAmount.toString());
    const ratio = currentValueLamports / loanLamports;

    const needsLiquidation = ratio < config.liquidationThreshold;

    console.log(
      `  loan#${loanId} collateral=${(currentValueLamports / 1e9).toFixed(4)} SOL ` +
        `loan=${(loanLamports / 1e9).toFixed(4)} SOL ratio=${ratio.toFixed(2)}x ` +
        (needsLiquidation ? "🚨 UNDERCOLLATERALIZED" : "✅"),
    );

    return {
      loanId,
      loanAddress: loan.publicKey.toBase58(),
      borrower: data.borrower.toBase58(),
      collateralMint: mint.toBase58(),
      collateralAmount: data.collateralAmount.toString(),
      currentValueLamports,
      loanLamports,
      ratio,
      needsLiquidation,
      reason: needsLiquidation ? "Collateral value below threshold" : "Healthy",
    };
  } catch (err) {
    console.error(`  loan#${loanId} check failed: ${err.message}`);
    return { loanId, needsLiquidation: false, reason: `Error: ${err.message}` };
  }
}

function isExpired(loan) {
  const dueTs = Number(loan.account.dueTimestamp.toString());
  return Math.floor(Date.now() / 1000) > dueTs;
}

export async function monitorLoans(program, connection) {
  console.log("\n" + "=".repeat(60));
  console.log("🔍 Monitoring cycle");
  console.log("=".repeat(60));

  const loans = await getAllActiveLoans(program);
  if (loans.length === 0) {
    console.log("📭 No active loans");
    return { loansToLiquidate: [] };
  }
  console.log(`Found ${loans.length} active loan(s)`);

  const decimalsCache = new Map();
  const checks = await Promise.all(loans.map((l) => checkLoan(l, connection, decimalsCache)));

  const expired = loans.filter(isExpired);
  if (expired.length > 0) {
    console.log(`⏰ ${expired.length} expired loan(s)`);
  }

  // Deduplicate by loanAddress (a loan could fail both conditions).
  const toLiquidate = new Map();
  for (const c of checks) {
    if (c.needsLiquidation) toLiquidate.set(c.loanAddress, c);
  }
  for (const l of expired) {
    const addr = l.publicKey.toBase58();
    if (!toLiquidate.has(addr)) {
      toLiquidate.set(addr, {
        loanId: l.account.loanId.toString(),
        loanAddress: addr,
        borrower: l.account.borrower.toBase58(),
        collateralMint: l.account.collateralMint.toBase58(),
        collateralAmount: l.account.collateralAmount.toString(),
        needsLiquidation: true,
        reason: "Loan expired",
      });
    }
  }

  const result = [...toLiquidate.values()];
  console.log(`📈 Healthy: ${loans.length - result.length} | Needs liquidation: ${result.length}`);
  return { loansToLiquidate: result };
}

export function startPriceMonitoring(program, connection, liquidationService) {
  console.log(`🚀 Starting price monitor (every ${config.priceCheckInterval}s)`);

  const cycle = async () => {
    try {
      const { loansToLiquidate } = await monitorLoans(program, connection);
      for (const loan of loansToLiquidate) {
        try {
          await liquidationService.liquidateLoan(loan);
        } catch (err) {
          console.error(`Liquidation of ${loan.loanId} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error("Monitoring cycle error:", err);
    }
  };

  cycle();
  setInterval(cycle, config.priceCheckInterval * 1000);
}
