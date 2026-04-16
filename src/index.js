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

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const bot = new Bot(token);

bot.command("start", handleStart);
bot.command("deposit", handleDeposit);
bot.command("positions", handlePositions);
bot.command("borrow", handleBorrow);
bot.command("repay", handleRepay);
bot.command("price", handlePrice);
bot.command("withdraw", handleWithdraw);
bot.command("export", handleExport);
bot.command("help", handleHelp);

registerBorrowCallbacks(bot);
registerRepayCallbacks(bot);
registerWithdrawCallbacks(bot);
registerExportCallbacks(bot);

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("🏦 BagBank bot starting...");
bot.start({
  onStart: (info) => console.log(`Running as @${info.username}`),
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
