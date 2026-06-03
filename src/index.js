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
import { handleMagpie } from "./commands/magpie.js";
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
import { handleRefer, registerReferCallbacks } from "./commands/refer.js";
import { handleHolders, registerHoldersCallbacks } from "./commands/holders.js";
import { handleSupport, registerSupportCallbacks } from "./commands/support.js";
import { handleMyTickets, registerMyTicketsCallbacks } from "./commands/my-tickets.js";
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
  handleFundPool,
  handleReconcile,
  handleReply,
  handleTickets,
  handleClose,
  handleAiStats,
  handleHealth,
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
import { startHeliusUsageWatcher } from "./services/helius-usage-watcher.js";
import { startHolderDistributor } from "./services/magpie-holder-rewards.js";
import { startLpLoyaltyDistributor } from "./services/lp-loyalty.js";
import { startLoanReconciler } from "./services/loan-reconciler.js";
import { startLenderBalanceWatcher } from "./services/lender-balance-watcher.js";
import { startAiConversationDigest } from "./services/ai-conversation-digest.js";
import { startTicketAgingWatcher } from "./services/ticket-aging-watcher.js";
import { startInfraHealth } from "./services/infra-health.js";

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
bot.command("magpie", handleMagpie);
bot.command("token", handleMagpie); // alias — users might guess this
bot.command("support", handleSupport);
bot.command("help_request", handleSupport); // alias — common term users guess
bot.command("ticket", handleSupport); // alias
bot.command("mytickets", handleMyTickets);
bot.command("tickets_mine", handleMyTickets); // alias
bot.command("refer", handleRefer);
bot.command("referral", handleRefer); // alias
bot.command("invite", handleRefer); // alias — common term users guess
bot.command("holders", handleHolders);
bot.command("holder", handleHolders); // alias

// Admin commands (authorization enforced in handlers)
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("enablemint", handleEnableMint);
bot.command("disablemint", handleDisableMint);
bot.command("broadcast", handleBroadcast);
bot.command("reviewtokens", handleReviewTokens);
bot.command("fundpool", handleFundPool);
bot.command("reconcile", handleReconcile);
bot.command("reply", handleReply);
bot.command("tickets", handleTickets);
bot.command("close", handleClose);
bot.command("aistats", handleAiStats);
bot.command("health", handleHealth);

// Inline callback registration.
//
// CRITICAL ORDER: import and support are registered FIRST because
// their message:text middleware needs priority over /borrow and
// /withdraw — both of which also intercept text messages. Without
// this, a user who abandoned a prior /withdraw or /borrow session
// and then runs /import or /support has their next message hijacked
// by leftover state.
registerImportCallbacks(bot);
registerSupportCallbacks(bot);
registerMyTicketsCallbacks(bot);
registerBorrowCallbacks(bot);
registerRepayCallbacks(bot);
registerWithdrawCallbacks(bot);
registerExportCallbacks(bot);
registerNotifyCallbacks(bot);
registerTopupCallbacks(bot);
registerPartialRepayCallbacks(bot);
registerExtendCallbacks(bot);
registerLendCallbacks(bot);
registerReferCallbacks(bot);
registerHoldersCallbacks(bot);
registerReborrowCallbacks(bot);
registerScreenerCallbacks(bot);
registerStartCallbacks(bot);
registerFallbackCallbacks(bot);

// Fallback: respond to any text message that isn't a command
bot.on("message:text", handleFallback);

bot.catch((err) => {
  console.error("Bot error:", err);
});

// Register the primary nav commands so they appear in Telegram's menu
// button (the icon next to the chat input). This is the Telegram-native
// way to make navigation "always available" — sits above the chat bar,
// always visible, no awkward reply-keyboard slot.
async function registerBotCommands() {
  try {
    await bot.api.setMyCommands([
      { command: "home", description: "🏠 Home / main menu" },
      { command: "wallet", description: "💼 Your wallet + SOL balance" },
      { command: "borrow", description: "💰 Take a loan" },
      { command: "positions", description: "📊 Active loans" },
      { command: "repay", description: "✅ Repay a loan" },
      { command: "deposit", description: "📥 Show deposit address" },
      { command: "withdraw", description: "📤 Withdraw SOL" },
      { command: "supported", description: "🪙 Approved collateral tokens" },
      { command: "credit", description: "⭐ Your credit score + points" },
      { command: "history", description: "📜 Loan history" },
      { command: "refer", description: "🎁 Earn 5% of friends' loan fees" },
      { command: "holders", description: "💎 $MAGPIE holder rewards" },
      { command: "submit", description: "➕ Submit a new token" },
      { command: "magpie", description: "✨ $MAGPIE token info" },
      { command: "support", description: "🛟 Self-serve help / message the team" },
      { command: "mytickets", description: "🎫 Your support tickets + status" },
      { command: "help", description: "ℹ️ Full command list" },
    ]);
    await bot.api.setChatMenuButton({
      menu_button: { type: "commands" },
    });
  } catch (err) {
    console.warn("[bot] setMyCommands failed:", err.message);
  }
}

console.log("🏦 Magpie bot starting...");
bot.start({
  onStart: (info) => {
    console.log(`Running as @${info.username}`);
    registerBotCommands();
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
    // Apply idempotent schema patches before anything that touches DB writes.
    import("./db/pool.js").then((m) => m.applyStartupPatches()).catch((err) => {
      console.warn("[bot] applyStartupPatches failed (continuing):", err.message);
    });
    startDbHealth(bot); // Start immediately — monitors DB connectivity
    setTimeout(() => startHeliusUsageWatcher(bot), 60_000); // Helius credit alerts
    // Push fresh prices to on-chain price feeds. DB-driven: the attestor
    // queries supported_mints (enabled=TRUE) every tick, so newly approved
    // tokens get attested without a restart. Drift-gated to keep cost low.
    // 45s interval so refresh fires before the 60s force-attest gap.
    // Keeps on-chain feed timestamp comfortably under 120s contract limit.
    setTimeout(() => startPriceAttestor(45_000), 35_000);
    // $MAGPIE holder reward distributions (weekly snapshot + pro-rata payout).
    // Idempotent — only runs when the pool has accrued AND 7+ days have
    // passed since the last distribution.
    setTimeout(() => startHolderDistributor(), 90_000);
    // LP Loyalty distributor — rewards long-term LPs from 2% of fees
    setTimeout(() => startLpLoyaltyDistributor(), 120_000);
    // Loan reconciler — proactively syncs DB state with on-chain truth
    // every 5 min. Catches partial-repay/extend/liquidation drift.
    setTimeout(() => startLoanReconciler(), 45_000);
    // Overnight safety: DMs admin if lender wallet drops below safe thresholds
    setTimeout(() => startLenderBalanceWatcher(bot), 60_000);
    // Daily AI conversation digest — disabled per admin preference.
    // To re-enable, uncomment the next line. Admin can pull stats on
    // their own schedule via /aistats instead.
    // setTimeout(() => startAiConversationDigest(bot), 75_000);
    // Ticket aging — DMs admin about open tickets that cross 2h/8h/24h
    setTimeout(() => startTicketAgingWatcher(bot), 90_000);
    // Infra health — probes Anthropic, Helius, public RPC, DB every 5 min
    // Alerts admin only on SUSTAINED degradation (15+ min) to avoid noise
    setTimeout(() => startInfraHealth(bot), 100_000);
    // Credit oracle publisher disabled: requires funded authority wallet.
    // setTimeout(() => startCreditOraclePublisher(), 20_000);
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
