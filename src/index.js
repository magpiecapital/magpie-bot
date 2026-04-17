import { Bot } from "grammy";
import "dotenv/config";

import { handleStart } from "./commands/start.js";
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
bot.command("help", handleHelp);

// Admin commands (authorization enforced in handlers)
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("enablemint", handleEnableMint);
bot.command("disablemint", handleDisableMint);
bot.command("broadcast", handleBroadcast);

// Inline callback registration
registerBorrowCallbacks(bot);
registerRepayCallbacks(bot);
registerWithdrawCallbacks(bot);
registerExportCallbacks(bot);
registerNotifyCallbacks(bot);
registerTopupCallbacks(bot);
registerPartialRepayCallbacks(bot);
registerExtendCallbacks(bot);

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("🏦 Magpie bot starting...");
bot.start({
  onStart: (info) => {
    console.log(`Running as @${info.username}`);
    // Background watchers — start after bot is online so they can DM users.
    startDepositWatcher(bot);
    startLoanWatcher(bot);
    startHealthWatcher(bot);
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
