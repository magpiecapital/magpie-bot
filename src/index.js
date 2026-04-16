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
import {
  handlePause,
  handleResume,
  handleAdminStatus,
  handleEnableMint,
  handleDisableMint,
} from "./commands/admin.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { startDepositWatcher } from "./services/deposit-watcher.js";
import { startLoanWatcher } from "./services/loan-watcher.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const bot = new Bot(token);

bot.use(rateLimit());

bot.command("start", handleStart);
bot.command("deposit", handleDeposit);
bot.command("positions", handlePositions);
bot.command("history", handleHistory);
bot.command("borrow", handleBorrow);
bot.command("repay", handleRepay);
bot.command("price", handlePrice);
bot.command("withdraw", handleWithdraw);
bot.command("export", handleExport);
bot.command("stats", handleStats);
bot.command("help", handleHelp);

// Admin commands (authorization enforced in handlers).
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("enablemint", handleEnableMint);
bot.command("disablemint", handleDisableMint);

registerBorrowCallbacks(bot);
registerRepayCallbacks(bot);
registerWithdrawCallbacks(bot);
registerExportCallbacks(bot);

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("🏦 BagBank bot starting...");
bot.start({
  onStart: (info) => {
    console.log(`Running as @${info.username}`);
    // Kick off background watchers after the bot is live.
    startDepositWatcher(bot);
    startLoanWatcher(bot);
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
