import { Bot } from "grammy";
import "dotenv/config";

import { handleStart, registerStartCallbacks } from "./commands/start.js";
import { handleDeposit } from "./commands/deposit.js";
import { handlePositions } from "./commands/positions.js";
import { handleBorrow, registerBorrowCallbacks } from "./commands/borrow.js";
import { handleRepay, registerRepayCallbacks } from "./commands/repay.js";
import { handlePrice } from "./commands/price.js";
import { handleWithdraw, registerWithdrawCallbacks } from "./commands/withdraw.js";
import { handleExport, registerExportCallbacks } from "./commands/export.js";
import { handleHelp } from "./commands/help.js";
import { handleStats } from "./commands/stats.js";
import { handleHistory } from "./commands/history.js";
import { handleSimulate } from "./commands/simulate.js";
import { handleMe } from "./commands/me.js";
import { handleSupported } from "./commands/supported.js";
import { handleNotify, registerNotifyCallbacks } from "./commands/notify.js";
import { handleTopup, registerTopupCallbacks } from "./commands/topup.js";
import { handlePartialRepay, registerPartialRepayCallbacks } from "./commands/partial-repay.js";
import { handleExtend, registerExtendCallbacks } from "./commands/extend.js";
import { handleCredit } from "./commands/credit.js";
import { handleRisk } from "./commands/risk.js";
import { handleLend, registerLendCallbacks } from "./commands/lend.js";
import { handleImport, registerImportCallbacks } from "./commands/import-wallet.js";
import { handleWallet } from "./commands/wallet.js";
import { handleHome } from "./commands/home.js";
import { handleSubmit } from "./commands/submit.js";
import { handleReborrow, registerReborrowCallbacks } from "./commands/reborrow.js";
import { handleFallback, registerFallbackCallbacks } from "./commands/fallback.js";
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
import { startPriceAttestor } from "./services/price-attestor.js";
import { BTN_HOME, BTN_WALLET, BTN_BORROW, BTN_POSITIONS } from "./lib/main-keyboard.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const bot = new Bot(token);

bot.use(rateLimit());

// User commands
bot.command("start", handleStart);
bot.command("deposit", handleDeposit);
bot.command("positions", handlePositions);
bot.command("history", handleHistory);
bot.command("borrow", handleBorrow);
bot.command("repay", handleRepay);
bot.command("price", handlePrice);
bot.command("simulate", handleSimulate);
bot.command("supported", handleSupported);
bot.command("withdraw", handleWithdraw);
bot.command("export", handleExport);
bot.command("stats", handleStats);
bot.command("me", handleMe);
bot.command("notify", handleNotify);
bot.command("topup", handleTopup);
bot.command("partialrepay", handlePartialRepay);
bot.command("extend", handleExtend);
bot.command("credit", handleCredit);
bot.command("risk", handleRisk);
bot.command("lend", handleLend);
bot.command("import", handleImport);
bot.command("wallet", handleWallet);
bot.command("reborrow", handleReborrow);
bot.command("home", handleHome);
bot.command("submit", handleSubmit);
bot.command("help", handleHelp);

// Admin commands (authorization enforced in handlers)
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("enablemint", handleEnableMint);
bot.command("disablemint", handleDisableMint);
bot.command("broadcast", handleBroadcast);
bot.command("reviewtokens", handleReviewTokens);

// Inline callback registration
registerBorrowCallbacks(bot);
registerRepayCallbacks(bot);
registerWithdrawCallbacks(bot);
registerExportCallbacks(bot);
registerNotifyCallbacks(bot);
registerTopupCallbacks(bot);
registerPartialRepayCallbacks(bot);
registerExtendCallbacks(bot);
registerLendCallbacks(bot);
registerImportCallbacks(bot);
registerReborrowCallbacks(bot);
registerScreenerCallbacks(bot);
registerStartCallbacks(bot);
registerFallbackCallbacks(bot);

// Persistent reply-keyboard buttons. Route exact button labels to their
// handlers BEFORE the natural-language fallback so taps go straight to
// the right command instead of getting funneled through keyword matching.
bot.hears(BTN_HOME, handleHome);
bot.hears(BTN_WALLET, handleWallet);
bot.hears(BTN_BORROW, handleBorrow);
bot.hears(BTN_POSITIONS, handlePositions);

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
    // startDepositWatcher(bot);
    setTimeout(() => startLoanWatcher(bot), 5_000);
    setTimeout(() => startHealthWatcher(bot), 10_000);
    setTimeout(() => startRiskEngine(bot), 15_000);
    setTimeout(() => startPumpWatcher(bot), 20_000);
    setTimeout(() => startTokenScreener(bot), 25_000);
    setTimeout(() => startTokenHealth(bot), 30_000);
    startDbHealth(bot); // Start immediately — monitors DB connectivity
    // Push fresh prices to on-chain price feeds. DB-driven: the attestor
    // queries supported_mints (enabled=TRUE) every tick, so newly approved
    // tokens get attested without a restart. Drift-gated to keep cost low.
    // 45s interval so refresh fires before the 60s force-attest gap.
    // Keeps on-chain feed timestamp comfortably under 120s contract limit.
    setTimeout(() => startPriceAttestor(45_000), 35_000);
    // Credit oracle publisher disabled: requires funded authority wallet.
    // setTimeout(() => startCreditOraclePublisher(), 20_000);
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
