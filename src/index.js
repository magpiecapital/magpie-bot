import { Bot } from "grammy";
import "dotenv/config";

import { handleStart, registerStartCallbacks } from "./commands/start.js";
import { handlePrice } from "./commands/price.js";
import { handleExport, registerExportCallbacks } from "./commands/export.js";
import { handleHelp } from "./commands/help.js";
import { handleStats } from "./commands/stats.js";
import { handleSimulate } from "./commands/simulate.js";
import { handleMe } from "./commands/me.js";
import { handleSupported } from "./commands/supported.js";
import { handleNotify, registerNotifyCallbacks } from "./commands/notify.js";
import { handleCredit } from "./commands/credit.js";
import { handleRisk } from "./commands/risk.js";
import { handleImport, registerImportCallbacks } from "./commands/import-wallet.js";
import { handleWallet } from "./commands/wallet.js";
import { handleHome } from "./commands/home.js";
import { handleSubmit } from "./commands/submit.js";
import { handleFallback, registerFallbackCallbacks } from "./commands/fallback.js";
// On-chain lending commands routed to a shared "paused" handler.
// See _disabled.js for context. Re-route when the protocol returns.
import { handleDisabledLending } from "./commands/_disabled.js";
import {
  handlePause,
  handleResume,
  handleAdminStatus,
  handleEnableMint,
  handleDisableMint,
  handleBroadcast,
} from "./commands/admin.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { startDepositWatcher } from "./services/deposit-watcher.js";
import { startLoanWatcher } from "./services/loan-watcher.js";
import { startHealthWatcher } from "./services/health-watcher.js";
import { startRiskEngine } from "./services/risk-engine.js";
import { startPumpWatcher } from "./services/pump-watcher.js";
import { startTokenScreener, handleReviewTokens, registerScreenerCallbacks } from "./services/token-screener.js";
import { startTokenHealth } from "./services/token-health.js";
import { startDbHealth } from "./services/db-health.js";
import { startApiServer } from "./api/server.js";
import { startCreditOraclePublisher } from "./services/credit-oracle-publisher.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const bot = new Bot(token);

bot.use(rateLimit());

// User commands — active (off-chain)
bot.command("start", handleStart);
bot.command("home", handleHome);
bot.command("help", handleHelp);
bot.command("me", handleMe);
bot.command("wallet", handleWallet);
bot.command("import", handleImport);
bot.command("export", handleExport);
bot.command("notify", handleNotify);
bot.command("supported", handleSupported);
bot.command("price", handlePrice);
bot.command("risk", handleRisk);
bot.command("credit", handleCredit);
bot.command("submit", handleSubmit);
bot.command("simulate", handleSimulate);
bot.command("stats", handleStats);

// On-chain lending commands — paused while protocol is offline.
// Send a friendly explanation instead of failing on-chain calls.
bot.command("deposit", handleDisabledLending);
bot.command("withdraw", handleDisabledLending);
bot.command("topup", handleDisabledLending);
bot.command("borrow", handleDisabledLending);
bot.command("repay", handleDisabledLending);
bot.command("partialrepay", handleDisabledLending);
bot.command("extend", handleDisabledLending);
bot.command("reborrow", handleDisabledLending);
bot.command("lend", handleDisabledLending);
bot.command("positions", handleDisabledLending);
bot.command("history", handleDisabledLending);

// Admin commands (authorization enforced in handlers)
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("enablemint", handleEnableMint);
bot.command("disablemint", handleDisableMint);
bot.command("broadcast", handleBroadcast);
bot.command("reviewtokens", handleReviewTokens);

// Inline callback registration — only for the active (off-chain) commands.
registerExportCallbacks(bot);
registerNotifyCallbacks(bot);
registerImportCallbacks(bot);
registerScreenerCallbacks(bot);
registerStartCallbacks(bot);
registerFallbackCallbacks(bot);

// Fallback: respond to any text message that isn't a command
bot.on("message:text", handleFallback);

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("🏦 Magpie bot starting...");
bot.start({
  onStart: (info) => {
    console.log(`Running as @${info.username}`);
    // Background watchers — stagger startup to avoid RPC rate-limit flood.
    // Deposit watcher disabled: free public RPC can't handle background polling.
    // Re-enable when a dedicated RPC endpoint is available.
    startApiServer();
    // ── On-chain background loops DISABLED ────────────────────────────────────
    // The magpie-lending program was closed on 2026-05-07 and the user
    // decided not to spend SOL to redeploy. Until/unless a new on-chain
    // protocol ships, these watchers have nothing to watch — they were
    // logging errors every cycle and eating RPC quota.
    //   - startDepositWatcher (also previously disabled due to RPC limits)
    //   - startLoanWatcher
    //   - startHealthWatcher
    //   - startCreditOraclePublisher
    // To revive: uncomment after the new program is live.
    // ─────────────────────────────────────────────────────────────────────────
    setTimeout(() => startRiskEngine(bot), 15_000);
    setTimeout(() => startPumpWatcher(bot), 20_000);
    setTimeout(() => startTokenScreener(bot), 25_000);
    setTimeout(() => startTokenHealth(bot), 30_000);
    startDbHealth(bot); // Start immediately — monitors DB connectivity
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
