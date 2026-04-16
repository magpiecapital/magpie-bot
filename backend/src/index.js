/**
 * BagBank liquidation backend entrypoint.
 *
 * Polls the lending program for active loans and liquidates any that are
 * undercollateralized (by SOL-denominated value) or past due.
 */
import { createAnchorProgram } from "./utils/anchor-client.js";
import { LiquidationService } from "./services/liquidation.js";
import { startPriceMonitoring } from "./services/price-monitor.js";

console.log("");
console.log("=".repeat(60));
console.log("🏦 BagBank — Liquidation Backend");
console.log("=".repeat(60));

async function main() {
  const { program, connection, lenderKeypair } = createAnchorProgram();

  const balance = await connection.getBalance(lenderKeypair.publicKey);
  console.log(`💰 Lender SOL balance: ${(balance / 1e9).toFixed(4)} SOL`);

  const svc = new LiquidationService(program, connection, lenderKeypair);
  const stats = await svc.getStats();
  if (stats) {
    console.log(`📊 Loans issued: ${stats.totalLoansIssued} | Liquidations: ${stats.totalLiquidations}`);
  }

  startPriceMonitoring(program, connection, svc);
  console.log("✅ Running. Ctrl+C to stop.\n");
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n🛑 ${sig} received, shutting down...`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
