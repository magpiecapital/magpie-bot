import { Bot } from "grammy";
import "dotenv/config";

import { handleStart, registerStartCallbacks } from "./commands/start.js";
import { handleDeposit } from "./commands/deposit.js";
import { handlePositions } from "./commands/positions.js";
import { handleBorrow, registerBorrowCallbacks } from "./commands/borrow.js";
import { handleRepay, registerRepayCallbacks } from "./commands/repay.js";
import { handlePrice } from "./commands/price.js";
import { handleWithdraw, registerWithdrawCallbacks } from "./commands/withdraw.js";
import { handleLink } from "./commands/link.js";
import { handleSite } from "./commands/site.js";
import { handlePrivacy } from "./commands/privacy.js";
import { handleSecurity } from "./commands/security.js";
import { handleExportData } from "./commands/export-data.js";
import { handleTxLookup } from "./commands/tx-lookup.js";
import { handleSignedHistory } from "./commands/signed-history.js";
import { handleTestAlert } from "./commands/test-alert.js";
import { handleWalletLookup } from "./commands/wallet-lookup.js";
import { handleVersion } from "./commands/version.js";
import { handleNote, handleNotes, handleNoteDel } from "./commands/notes.js";
import { handleClearStale } from "./commands/clear-stale.js";
import { handleWhatsNew } from "./commands/whats-new.js";
import { handleLock, registerLockCallbacks } from "./commands/lock.js";
import { handleSiteOps } from "./commands/siteops.js";
import {
  handleBanUser,
  handleBanTg,
  handleBanWallet,
  handleUnbanUser,
  handleUnbanWallet,
  handleBanList,
  handleBanSweep,
} from "./commands/bans.js";
import { handleAdminLock, handleAdminUnlock } from "./commands/admin-lock.js";
import { handleSiteDisable, handleSiteEnable, handleSiteState } from "./commands/site-toggle.js";
import {
  handleAnnounce,
  handleAnnounceWarn,
  handleAnnounceCrit,
  handleAnnounceClear,
} from "./commands/announcement.js";
import { handleExport, registerExportCallbacks } from "./commands/export.js";
import { handleHelp } from "./commands/help.js";
import { handleCommunity } from "./commands/community.js";
import { handleMagpie } from "./commands/magpie.js";
import { handleStats } from "./commands/stats.js";
import { handleHistory } from "./commands/history.js";
import { handleSimulate } from "./commands/simulate.js";
import { handleMe, registerMeCallbacks } from "./commands/me.js";
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
import { handleAutoProtect, registerAutoProtectCallbacks } from "./commands/autoprotect.js";
import { handleCalendar, registerCalendarCallbacks } from "./commands/calendar.js";
import { handleHealth } from "./commands/health.js";
import { handleShare } from "./commands/share.js";
import { handleWallets, registerWalletsCallbacks } from "./commands/wallets.js";
import { handleUnlock, registerUnlockCallbacks } from "./commands/unlock.js";
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
  handleSnapshotOnly,
  handleDistribute,
  handleReconcile,
  handleReply,
  handleTickets,
  handleClose,
  handleCloseAll,
  handleAiStats,
  handleInfraHealth,
  handleHolderPool,
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
import { setSecurityAlertBot } from "./services/security-alerts.js";
import { setLenderAlarmBot } from "./api/lender-alarm-webhook.js";
import { startDailyOpsReport } from "./services/daily-ops-report.js";
import { startUsedNoncesCleaner } from "./services/used-nonces-cleaner.js";
import { startCreditOraclePublisher } from "./services/credit-oracle-publisher.js";
import { startPriceAttestor } from "./services/price-attestor.js";
import { startRwaScreener } from "./services/rwa-screener.js";
import { startHeliusUsageWatcher } from "./services/helius-usage-watcher.js";
import { startHolderDistributor } from "./services/magpie-holder-rewards.js";
import { startLpLoyaltyDistributor } from "./services/lp-loyalty.js";
import { startLoanReconciler } from "./services/loan-reconciler.js";
import { startLenderBalanceWatcher } from "./services/lender-balance-watcher.js";
import { startAutoProtect } from "./services/auto-protect.js";
import { startAiConversationDigest } from "./services/ai-conversation-digest.js";
import { startTicketAgingWatcher } from "./services/ticket-aging-watcher.js";
import { startInfraHealth } from "./services/infra-health.js";
import { startNeonSync } from "./services/neon-sync.js";
import { registerTxErrorCallbacks } from "./services/tx-error-callbacks.js";
import { startAiAgentHealth } from "./services/ai-agent-health.js";
import { startAutoTicketResolver } from "./services/auto-ticket-resolver.js";
import { startDormantReengagement, registerDormantCallbacks } from "./services/dormant-reengagement.js";
import { startIdleSolNudge } from "./services/idle-sol-nudge.js";
import { startWinbackAgent, registerWinbackCallbacks } from "./services/winback-agent.js";

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
bot.command("loans", handlePositions); // alias — users type /loans more often
bot.command("history", handleHistory);
bot.command("borrow", handleBorrow);
bot.command("repay", handleRepay);
bot.command("price", handlePrice);
bot.command("simulate", handleSimulate);
bot.command("supported", handleSupported);
bot.command("withdraw", handleWithdraw);
bot.command("export", handleExport);
bot.command("link", handleLink);
bot.command("site", handleSite);
bot.command("web", handleSite); // alias
bot.command("privacy", handlePrivacy);
bot.command("security", handleSecurity);
bot.command("exportdata", handleExportData);
bot.command("tx", handleTxLookup);
bot.command("signedhistory", handleSignedHistory);
bot.command("testalert", handleTestAlert);
bot.command("walletlookup", handleWalletLookup);
bot.command("version", handleVersion);
bot.command("whatsnew", handleWhatsNew);
bot.command("lock", handleLock);
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
bot.command("wallets", handleWallets);
bot.command("switchwallet", handleWallets); // alias
bot.command("reborrow", handleReborrow);
bot.command("home", handleHome);
bot.command("submit", handleSubmit);
bot.command("help", handleHelp);
bot.command("community", handleCommunity);
bot.command("magpie", handleMagpie);
bot.command("token", handleMagpie); // alias — users might guess this
bot.command("support", handleSupport);
bot.command("help_request", handleSupport); // alias — common term users guess
bot.command("ticket", handleSupport); // alias
bot.command("mytickets", handleMyTickets);
bot.command("tickets_mine", handleMyTickets); // alias
bot.command("autoprotect", handleAutoProtect);
bot.command("protect", handleAutoProtect); // alias
bot.command("calendar", handleCalendar);
bot.command("health", handleHealth);
bot.command("share", handleShare);
bot.command("flex", handleShare); // alias — crypto-native phrasing
bot.command("unlock", handleUnlock);
bot.command("potential", handleUnlock); // alias
bot.command("refer", handleRefer);
bot.command("referral", handleRefer); // alias
bot.command("invite", handleRefer); // alias — common term users guess
bot.command("holders", handleHolders);
bot.command("holder", handleHolders); // alias

// Admin commands (authorization enforced in handlers)
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("siteops", handleSiteOps);
bot.command("ban_user", handleBanUser);
bot.command("ban_tg", handleBanTg);
bot.command("ban_wallet", handleBanWallet);
bot.command("unban_user", handleUnbanUser);
bot.command("unban_wallet", handleUnbanWallet);
bot.command("ban_list", handleBanList);
bot.command("ban_sweep", handleBanSweep);
bot.command("adminlock", handleAdminLock);
bot.command("adminunlock", handleAdminUnlock);
bot.command("sitedisable", handleSiteDisable);
bot.command("siteenable", handleSiteEnable);
bot.command("sitestate", handleSiteState);
bot.command("announce", handleAnnounce);
bot.command("announcewarn", handleAnnounceWarn);
bot.command("announcecrit", handleAnnounceCrit);
bot.command("announceclear", handleAnnounceClear);
bot.command("note", handleNote);
bot.command("notes", handleNotes);
bot.command("notedel", handleNoteDel);
bot.command("clearstale", handleClearStale);
bot.command("enablemint", handleEnableMint);
bot.command("disablemint", handleDisableMint);
bot.command("broadcast", handleBroadcast);
bot.command("reviewtokens", handleReviewTokens);
bot.command("fundpool", handleFundPool);
bot.command("snapshotonly", handleSnapshotOnly);
bot.command("distribute", handleDistribute);
bot.command("reconcile", handleReconcile);
bot.command("reply", handleReply);
bot.command("tickets", handleTickets);
bot.command("close", handleClose);
bot.command("closeall", handleCloseAll);
bot.command("aistats", handleAiStats);
bot.command("infrahealth", handleInfraHealth);
bot.command("holderpool", handleHolderPool);
bot.command("pools", handleHolderPool); // alias

// Community moderation operator commands. Always registered so the
// operator can enable it on demand; the per-chat enable check inside
// the handlers ensures it does nothing in groups that haven't opted in.
import { handleCommunityEnable, handleCommunityDisable, handleCommunityStatus, handleCommunityAllowlist, handleCommunityBroadcastNow, handleCommunityRepostGuidelines, handleCommunityUnban, handleCommunityStrikes, handleCommunityClearStrikes, handleCommunityCrosspost } from "./commands/community-admin.js";
bot.command("community_enable", handleCommunityEnable);
bot.command("community_disable", handleCommunityDisable);
bot.command("community_status", handleCommunityStatus);
bot.command("community_allowlist", handleCommunityAllowlist);
bot.command("community_broadcast_now", handleCommunityBroadcastNow);
bot.command("community_repost_guidelines", handleCommunityRepostGuidelines);
// Member-management ops (operator-only)
bot.command("unban", handleCommunityUnban);
bot.command("strikes", handleCommunityStrikes);
bot.command("clear_strikes", handleCommunityClearStrikes);
bot.command("crosspost", handleCommunityCrosspost);

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
registerAutoProtectCallbacks(bot);
registerCalendarCallbacks(bot);
registerUnlockCallbacks(bot);
registerWalletsCallbacks(bot);
registerTxErrorCallbacks(bot);
registerDormantCallbacks(bot);
registerWinbackCallbacks(bot);
registerBorrowCallbacks(bot);
registerRepayCallbacks(bot);
registerWithdrawCallbacks(bot);
registerLockCallbacks(bot);
registerMeCallbacks(bot);
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

// Community moderation handlers — register BEFORE the message:text
// fallback so URL deletes / quarantine kicks happen before any
// other text-handling tries to process the message. Per-chat opt-in
// (community_chats.enabled) means it's a no-op in any chat the
// operator hasn't run /community_enable in.
import { registerCommunityHandlers } from "./handlers/community-handlers.js";
import { setBotTgId } from "./services/community-moderation.js";
registerCommunityHandlers(bot);

// Fallback: respond to any text message that isn't a command
bot.on("message:text", handleFallback);

// Global safety net — if ANY handler throws an uncaught exception,
// the user gets a clean fallback message instead of silence + dropped
// state. This is the last line of defense after each command's own
// try/catch and the tx-error translator.
bot.catch(async (err) => {
  console.error("[bot] Unhandled error:", err);
  try {
    const ctx = err?.ctx;
    if (ctx && ctx.chat?.id) {
      await ctx.api.sendMessage(
        ctx.chat.id,
        [
          "⚠️ *Something unexpected happened*",
          "",
          "We hit a snag handling that. The team has been logged.",
          "",
          "*What to do:*",
          "• Try the command again",
          "• Or /support → Chat with agent and describe what you were doing",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }
  } catch {
    // If even the fallback fails, we've exhausted options — just log
  }
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
      { command: "wallets", description: "🔀 Switch between your wallets" },
      { command: "unlock", description: "🔓 See your borrow potential" },
      { command: "borrow", description: "💰 Take a loan" },
      { command: "positions", description: "📊 Active loans" },
      { command: "calendar", description: "📅 Loans sorted by due date" },
      { command: "health", description: "🩺 Loan health snapshot" },
      { command: "autoprotect", description: "🛡 Auto-Protect (anti-liquidation)" },
      { command: "repay", description: "✅ Repay a loan" },
      { command: "deposit", description: "📥 Show deposit address" },
      { command: "withdraw", description: "📤 Withdraw SOL" },
      { command: "supported", description: "🪙 Approved collateral tokens" },
      { command: "credit", description: "⭐ Your credit score + points" },
      { command: "history", description: "📜 Loan history" },
      { command: "refer", description: "🎁 Earn 5% of friends' loan fees" },
      { command: "share", description: "📤 Flex your loan / streak on Twitter" },
      { command: "holders", description: "💎 $MAGPIE holder rewards" },
      { command: "submit", description: "➕ Submit a new token" },
      { command: "magpie", description: "✨ $MAGPIE token info" },
      { command: "support", description: "🛟 Self-serve help / message the team" },
      { command: "mytickets", description: "🎫 Your support tickets + status" },
      { command: "community", description: "💬 Join the public @magpietalk group" },
      { command: "site", description: "🌐 Open magpie.capital" },
      { command: "security", description: "🔐 Account security view + lock buttons" },
      { command: "privacy", description: "🔒 What we store + your controls" },
      { command: "lock", description: "🚨 Emergency pause on site signed actions" },
      { command: "exportdata", description: "📦 DM yourself a JSON file of your account" },
      { command: "tx", description: "🔍 Lookup any Solana tx by signature" },
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
    setBotTgId(info.id); // community moderation needs to whitelist the bot's own messages
    // Community daily digest — checks every 15min, fires once per UTC day at the configured hour.
    // No-op until at least one chat has been enabled via /community_enable.
    import("./services/community-broadcast.js").then((m) => m.startCommunityBroadcast(bot));
    // Community anomaly watcher — DMs operator on suspicious mod-action volume.
    import("./services/community-anomaly.js").then((m) => m.startCommunityAnomalyWatcher(bot));
    // Daily operator digest — once-per-day DM summarizing 24h mod activity.
    import("./services/community-operator-digest.js").then((m) => m.startCommunityOperatorDigest(bot));
    // Proactive Pip — captcha welcomes (zero cost), milestone auto-posts
    // (zero cost), and unanswered-question pickup (capped Anthropic spend
    // via PIP_DAILY_PROACTIVE_MAX). Set PIP_PROACTIVE_DISABLED=1 to
    // disable entirely without redeploying.
    import("./services/community-proactive.js").then((m) => m.startCommunityProactive(bot));
    // X (@MagpieLoans) auto-cross-post — polls every 5 min if
    // X_BEARER_TOKEN is set. No-op without the token; operator can
    // still manually use /crosspost <tweet-url> in either path.
    import("./services/community-x-crosspost.js").then((m) => m.startXCrosspostPoller(bot));
    registerBotCommands();
    // Background watchers — stagger startup to avoid RPC rate-limit flood.
    // Deposit watcher disabled: free public RPC can't handle background polling.
    // Re-enable when a dedicated RPC endpoint is available.
    setSecurityAlertBot(bot);
    setLenderAlarmBot(bot);
    startApiServer();
    setTimeout(() => startDailyOpsReport(bot), 60_000);
    startUsedNoncesCleaner();
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
    // RWA screener — discovers Backed Finance xStocks + similar via DexScreener
    // search every 4h. Auto-adds new mints meeting liquidity/volume thresholds.
    // Auto-disables enabled RWAs that degrade or get paused by the issuer.
    // Delayed start to avoid bunching with other startup workers.
    setTimeout(() => startRwaScreener(bot), 180_000);
    // $MAGPIE holder reward distributions (weekly snapshot + pro-rata payout).
    // Idempotent — only runs when the pool has accrued AND 7+ days have
    // passed since the last distribution.
    setTimeout(() => startHolderDistributor(bot), 90_000);
    // LP Loyalty distributor — rewards long-term LPs from 2% of fees
    setTimeout(() => startLpLoyaltyDistributor(), 120_000);
    // Loan reconciler — proactively syncs DB state with on-chain truth
    // every 5 min. Catches partial-repay/extend/liquidation drift.
    setTimeout(() => startLoanReconciler(), 45_000);
    // Overnight safety: DMs admin if lender wallet drops below safe thresholds
    setTimeout(() => startLenderBalanceWatcher(bot), 60_000);
    // Auto-Protect — opt-in anti-liquidation. Watches every 90s.
    setTimeout(() => startAutoProtect(bot), 50_000);
    // Daily AI conversation digest — disabled per admin preference.
    // To re-enable, uncomment the next line. Admin can pull stats on
    // their own schedule via /aistats instead.
    // setTimeout(() => startAiConversationDigest(bot), 75_000);
    // Ticket aging — DMs admin about open tickets that cross 2h/8h/24h
    setTimeout(() => startTicketAgingWatcher(bot), 90_000);
    // Infra health — probes Anthropic, Helius, public RPC, DB every 5 min
    // Alerts admin only on SUSTAINED degradation (15+ min) to avoid noise
    setTimeout(() => startInfraHealth(bot), 100_000);
    // Neon sync — periodic backup of critical tables (users, wallets,
    // wallet_snapshots, loans, referral_codes) to the Neon cold standby.
    // No-op if DATABASE_URL_SECONDARY not configured.
    setTimeout(() => startNeonSync(), 180_000);
    // AI agent quality — runs 6 eval cases every 12h, alerts admin only
    // if >25% fail (catches prompt/tool regressions). Silent when healthy.
    setTimeout(() => startAiAgentHealth(bot), 110_000);
    // Auto-Ticket Resolver — every 30 min, AI handles stale tickets
    // autonomously instead of pinging admin. Critical-reason tickets
    // (security/bug) skipped — those go to admin as designed.
    setTimeout(() => startAutoTicketResolver(bot), 120_000);
    // Dormant Re-Engagement — every 6h, nudges users who hold approved
    // collateral but have never borrowed. One DM per user per 30 days.
    setTimeout(() => startDormantReengagement(bot), 135_000);
    // Idle-SOL → /earn agent — daily, nudges users with ≥1 SOL idle
    // and no LP position. One DM per user per 30 days.
    setTimeout(() => startIdleSolNudge(bot), 150_000);
    // Past-borrower win-back agent — daily, nudges users who repaid
    // ≥1 loan but haven't been active in 30+ days. Once per 60 days.
    setTimeout(() => startWinbackAgent(bot), 165_000);
    // Credit oracle publisher disabled: requires funded authority wallet.
    // setTimeout(() => startCreditOraclePublisher(), 20_000);
  },
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});
