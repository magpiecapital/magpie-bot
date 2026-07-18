import { Bot } from "grammy";
import "dotenv/config";

// Sentry — env-gated stub. No-op when SENTRY_DSN unset. Initialized
// before installDbQuotaGuard so it can capture any startup-phase
// exceptions. Operator pays $26/mo when ready to flip; until then
// this is dormant. See src/services/sentry.js.
import { initSentry } from "./services/sentry.js";
initSentry();

// DB-quota guard — installs global unhandledRejection /
// uncaughtException handlers that detect DB-quota / DB-dead errors
// and switch the bot to degraded mode INSTEAD of crashing. Closes the
// 2026-06-14 outage class (Neon compute quota exhausted -> bot crash
// loops every restart -> ~30 min site-down). See
// src/lib/db-quota-guard.js for the full rationale and honest scope.
// MUST be installed before any other import that might queue
// DB-touching async work — the very first thing after dotenv.
import { installDbQuotaGuard } from "./lib/db-quota-guard.js";
installDbQuotaGuard();

// Fail-fast privacy assertion — refuses to start the bot if any
// public-route handler under src/api/ surfaces telegram_username in
// a response. This catches regressions BEFORE they ship, so a future
// code change can never accidentally re-expose user TG handles to
// anyone with a wallet pubkey. If a flag is a false positive, add
// the file to SIGNED_OWNER_ONLY in scripts/check-privacy.js with a
// comment explaining why exposure there is acceptable.
import { assertNoPrivacyLeaksOrThrow } from "../scripts/check-privacy.js";
try {
  assertNoPrivacyLeaksOrThrow();
  console.log("[privacy-lint] startup check passed — no telegram_username leaks in public handlers");
} catch (privacyErr) {
  console.error(privacyErr.message);
  process.exit(1);
}

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
import { handleProtocolFees } from "./commands/protocol-fees.js";
import {
  handleBanUser,
  handleBanTg,
  handleBanWallet,
  handleUnbanUser,
  handleUnbanWallet,
  handleBanList,
  handleBanSweep,
  handleExploitReport,
  handleExemptAdd,
  handleExemptRemove,
  handleExemptList,
  handleSetTokenCap,
  handleTokenCapList,
} from "./commands/bans.js";
import { handleTicketPulse } from "./commands/ticket-pulse.js";
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
import { handleFeedback } from "./commands/feedback.js";
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
import { handleRefer, handleReferSet, registerReferCallbacks } from "./commands/refer.js";
import { handleAudit } from "./commands/audit.js";
import { handleHolders, registerHoldersCallbacks } from "./commands/holders.js";
import { handleDistributions } from "./commands/distributions.js";
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
  handleConvStats,
  handleV4Status,
  handleEnableMint,
  handleDisableMint,
  handleBroadcast,
  handleFundPool,
  handleSnapshotOnly,
  handleDistribute,
  handleRewardsRecon,
  handleReconcile,
  handleReply,
  handleTickets,
  handleClose,
  handleCloseAll,
  handleAiStats,
  handleInfraHealth,
  handleHolderPool,
  handleAdminCmds,
  handleApprove,
  handleDeny,
  handlePendingApprovals,
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
import { initGovernanceSchema } from "./api/governance-api.js";
import { setSecurityAlertBot } from "./services/security-alerts.js";
import { setLenderAlarmBot } from "./api/lender-alarm-webhook.js";
import { setNotifyBot, notifyAdmin } from "./services/admin-notify.js";
import { startDailyOpsReport } from "./services/daily-ops-report.js";
import { startX402DailyDigest } from "./services/x402-daily-digest.js";
import { startUsedNoncesCleaner } from "./services/used-nonces-cleaner.js";
import { startCreditOraclePublisher } from "./services/credit-oracle-publisher.js";
import { startPriceAttestor, ensureAllEnabledFeedsInitialized } from "./services/price-attestor.js";
import {
  startExploitDetector,
  registerExploitDetectorCallbacks,
} from "./services/exploit-detector.js";
import { startPriceSnapshotter } from "./services/price-snapshotter.js";
import { startExtendLoanWatcher } from "./services/extend-loan-watcher.js";
import { startRwaScreener } from "./services/rwa-screener.js";
import { startHeliusUsageWatcher } from "./services/helius-usage-watcher.js";
import { startHolderDistributor } from "./services/magpie-holder-rewards.js";
import { startLpLoyaltyDistributor } from "./services/lp-loyalty.js";
import { startLoanReconciler } from "./services/loan-reconciler.js";
import { startLenderBalanceWatcher } from "./services/lender-balance-watcher.js";
import { startEngineTopupWatcher } from "./services/engine-topup-watcher.js";
import { startLcOperatorAlerts } from "./services/lc-operator-alerts.js";
import { startEngineHeartbeatWatcher } from "./services/engine-heartbeat-watcher.js";
import { startAutoProtect } from "./services/auto-protect.js";
import { startFeeWalletSweeper } from "./services/fee-wallet-sweeper.js";
import { startDistributionGapMonitor } from "./services/distribution-gap-monitor.js";
import { startDistributionAutoFunder } from "./services/distribution-auto-funder.js";
import { assertDistributorKeyDiscipline } from "./services/distributor-keypair.js";
import { startPendingArmRetryWatcher } from "./services/pending-arm-retry-watcher.js";
import { startAiConversationDigest } from "./services/ai-conversation-digest.js";
import { startTicketAgingWatcher } from "./services/ticket-aging-watcher.js";
import { registerSupportVigilCallbacks } from "./services/support-vigil.js";
import { startInfraHealth } from "./services/infra-health.js";
import { startLimitCloseStalenessWatcher } from "./services/limit-close-staleness-watcher.js";
import { startStaleArmIntentWatcher } from "./services/stale-arm-intent-watcher.js";
import { startLimitCloseNearTriggerWatcher } from "./services/limit-close-near-trigger-watcher.js";
import { registerLcStalenessCallbacks } from "./handlers/lc-staleness-callbacks.js";
import { registerLcRetryingCallbacks } from "./handlers/lc-retrying-callbacks.js";
import { startImpersonatorWatchdog } from "./services/impersonator-watchdog.js";
import { startCanaryWatcher } from "./services/canary-watcher.js";
import { startBorrowCanary } from "./services/borrow-canary.js";
import { startX402PathCanary } from "./services/x402-path-canary.js";
import { startBootV4FeedSync } from "./services/boot-v4-feed-sync.js";
import { ensureX402DestinationAtas } from "./services/x402-destination-atas.js";
import { startFeedReadinessWarmup } from "./services/v4-feed-readiness.js";
import { startLoanProgramIdHealer } from "./services/loan-program-id-healer.js";
import { startV4LoanHealthProbe } from "./services/v4-loan-health-probe.js";
import { startLimitCloseEngineProgramIdSentinel } from "./services/limit-close-engine-program-id-sentinel.js";
import { startWalletAttributionSentinel } from "./services/wallet-attribution-sentinel.js";
import { startStocksRwaProtectionSentinel } from "./services/stocks-rwa-protection-sentinel.js";
import { startLoanReceivedWatchdog } from "./services/loan-received-watchdog.js";
import { startFirstV2FireWatcher } from "./services/first-v2-fire-watcher.js";
import { startLimitCloseFirstV3FireWatcher } from "./services/limit-close-first-v3-fire-watcher.js";
import { startLimitCloseFirstV4FireWatcher } from "./services/limit-close-first-v4-fire-watcher.js";
import { startV4FireFailureRateWatcher } from "./services/limit-close-v4-fire-failure-rate-watcher.js";
import { startV4ConvertDrainWatcher } from "./services/v4-convert-drain-watcher.js";
import { startNeonSync } from "./services/neon-sync.js";
import { registerTxErrorCallbacks } from "./services/tx-error-callbacks.js";
import { startAiAgentHealth } from "./services/ai-agent-health.js";
import { startAutoTicketResolver } from "./services/auto-ticket-resolver.js";
import { startTreasurySweeper } from "./services/treasury-sweeper.js";
import { startLiquidationCollateralSweeper } from "./services/liquidation-collateral-sweeper.js";
import { startX402FeeSweeper } from "./services/x402-fee-sweeper.js";
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

// ── DM-only guard for account-scoped commands ──────────────────────────
// Personal wallet / loan / security actions must run ONLY in the user's
// private 1:1 chat with the bot — never in the Magpie Talk community group
// (which is a public forum for chat + protocol questions with Pip).
// Operator-mandated 2026-07-03 after a /lock ran in the group and posted a
// personal security notice publicly. Read-only/community/info commands
// (/stats, /price, /audit, /refer, etc.) are intentionally NOT gated.
const DM_ONLY_COMMANDS = new Set([
  "deposit", "borrow", "repay", "partialrepay", "reborrow", "withdraw",
  "topup", "extend", "lock", "autoprotect", "protect", "tp", "sl",
  "export", "exportdata", "import", "wallet", "wallets", "switchwallet",
  "signedhistory", "me", "positions", "loans", "history",
  // Agent-delegation commands are account-scoped (they authorize a delegate to
  // act on the caller's wallet) — NEVER let them run in a public group, where a
  // copy-pasted /agent_authorize could silently grant an attacker's key access.
  "agent_authorize", "agent_revoke", "agent_list",
]);
bot.use(async (ctx, next) => {
  const text = ctx.message?.text || "";
  const m = text.match(/^\/([a-z_]+)(?:@\w+)?/i);
  if (
    m &&
    ctx.chat?.type &&
    ctx.chat.type !== "private" &&
    DM_ONLY_COMMANDS.has(m[1].toLowerCase())
  ) {
    await ctx
      .reply(
        "🔒 That's a personal wallet command — for your security it only works in our private 1:1 chat. Open your Magpie wallet: DM @magpie_capital_bot.\n\nMagpie Talk is for community chat + protocol questions with Pip. 🐦‍⬛",
        { disable_web_page_preview: true },
      )
      .catch(() => {});
    return; // stop — never run an account command in a group
  }
  return next();
});

// Pinned-message awareness: capture pin events so Pip treats operator
// announcements (e.g. "we chose Sec3") as current authoritative state and
// never gives a stale answer. Fire-and-forget; always continues the chain.
bot.use(async (ctx, next) => {
  const pm = ctx.msg?.pinned_message;
  if (pm && ctx.chat?.id) {
    import("./services/community-pins.js")
      .then(({ recordPinnedMessage }) =>
        recordPinnedMessage({
          chatId: ctx.chat.id,
          messageId: pm.message_id,
          text: pm.text || pm.caption || "",
          pinnedBy: ctx.from?.username || String(ctx.from?.id || ""),
        }),
      )
      .catch(() => {});
  }
  return next();
});

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
bot.command("setref", handleReferSet); // claim a custom vanity referral code
bot.command("refcode", handleReferSet); // alias
bot.command("audit", handleAudit); // public audit status (Sec3 engaged for V4)
bot.command("holders", handleHolders);
bot.command("holder", handleHolders); // alias
bot.command("distributions", handleDistributions);
bot.command("distribution", handleDistributions); // alias
bot.command("mydistributions", handleDistributions); // alias

// Admin commands (authorization enforced in handlers — every gate now
// logs success + denied attempts to admin_command_log per audit F-4).
bot.command("pause", handlePause);
bot.command("resume", handleResume);
bot.command("adminstatus", handleAdminStatus);
bot.command("convstats", handleConvStats); // /convstats — per-path conversion success rates
bot.command(["v4status", "v4-status", "v4"], handleV4Status);
bot.command(["admincmds", "adminlog"], handleAdminCmds);
// Limit-close engine observability (operator-facing). Read-only.
{
  const lcStatus = await import("./commands/lc-status.js");
  bot.command(["lc-status", "lcstatus", "lc_status"], lcStatus.handleLcStatus);
  const lcPerf = await import("./commands/lc-perf.js");
  bot.command(["lc-perf", "lcperf", "lc_perf"], lcPerf.handleLcPerf);
  // V4 Hardening T7 (2026-06-15 PM) — one-shot V4 health snapshot
  // (active loans + arms/fires + sol_proceeds_vault probe + canary
  // tail + arm-attempt audit). Read-only diagnostic.
  const v4Status = await import("./commands/v4-status.js");
  bot.command(["v4-status", "v4status", "v4_status"], v4Status.handleV4Status);
  // Treasury sweeper observability (operator-facing). Read-only.
  const treasuryStatus = await import("./commands/treasury-status.js");
  bot.command(
    ["treasury-status", "treasurystatus", "treasury_status", "treasury"],
    treasuryStatus.handleTreasuryStatus,
  );
  const scanImp = await import("./commands/scan-impersonators.js");
  bot.command(
    ["scan-impersonators", "scanimpersonators", "scan_impersonators"],
    scanImp.handleScanImpersonators,
  );
  // Attestation tier management (Phase 1: schema + admin tooling only,
  // no behavior change in attestor loops yet).
  const tierCmd = await import("./commands/tier.js");
  bot.command(["tier", "tiers"], tierCmd.handleTier);
}
// F-4 multi-step approval — second-admin sign-off for sensitive commands.
// Default gated commands: enablemint, disablemint, broadcast (tunable via
// ADMIN_COMMAND_APPROVAL_REQUIRED env var). Solo-admin operators bypass
// transparently — the bypass is logged via admin_command_log.
bot.command("approve", handleApprove);
bot.command("deny", handleDeny);
bot.command(["pending", "pending_approvals"], handlePendingApprovals);
bot.command("siteops", handleSiteOps);
bot.command(["protocolfees", "protocol-fees"], handleProtocolFees);
bot.command("ban_user", handleBanUser);
bot.command("ban_tg", handleBanTg);
bot.command("ban_wallet", handleBanWallet);
bot.command("unban_user", handleUnbanUser);
bot.command("unban_wallet", handleUnbanWallet);
bot.command("ban_list", handleBanList);
bot.command("ban_sweep", handleBanSweep);
bot.command("exploit_report", handleExploitReport);
bot.command("exempt_add", handleExemptAdd);
bot.command("exempt_remove", handleExemptRemove);
bot.command("exempt_list", handleExemptList);
bot.command("ticket_pulse", handleTicketPulse);
bot.command("set_token_cap", handleSetTokenCap);
bot.command("token_caps", handleTokenCapList);
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
bot.command("rewardsrecon", handleRewardsRecon); // read-only Option-A reconciliation
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
import { handleCommunityEnable, handleCommunityDisable, handleCommunityStatus, handleCommunityAllowlist, handleCommunityBroadcastNow, handleCommunityRepostGuidelines, handleCommunityUnban, handleCommunityBan, handleCommunityStrikes, handleCommunityClearStrikes, handleCommunityCrosspost } from "./commands/community-admin.js";
import { handleGovPause, handleGovResume, handleGovStatus, handleGovConfirmManual } from "./commands/gov-admin.js";
import { handleBurnConfirm, handleBurnRecord, handleBurnStats, handleBurnPending } from "./commands/burn-admin.js";
import { handleVote, handleVotingPower } from "./commands/vote.js";
import {
  handleNominate,
  handleNominationsList,
  handleUpvoteNomination,
  handleWithdrawNomination,
  handleNominationReview,
  handleMyNominations,
} from "./commands/nominations.js";
bot.command("community_enable", handleCommunityEnable);
bot.command("community_disable", handleCommunityDisable);
bot.command("community_status", handleCommunityStatus);
bot.command("community_allowlist", handleCommunityAllowlist);
bot.command("community_broadcast_now", handleCommunityBroadcastNow);
bot.command("community_repost_guidelines", handleCommunityRepostGuidelines);
// Member-management ops (operator-only)
bot.command("ban", handleCommunityBan);
bot.command("unban", handleCommunityUnban);
bot.command("strikes", handleCommunityStrikes);
bot.command("clear_strikes", handleCommunityClearStrikes);
bot.command("crosspost", handleCommunityCrosspost);
// Raid monitor — public claim + status; operator add/remove/list.
{
  const r = await import("./commands/raid.js");
  bot.command("raided", r.handleRaided);
  bot.command("raidstatus", r.handleRaidStatus);
  bot.command("raidadd", r.handleRaidAdd);
  bot.command("raidremove", r.handleRaidRemove);
  bot.command("raidlist", r.handleRaidList);
}

// Limit-close-and-sell — Tier 1 (custodial TG users only). Engine that
// actually executes lives in the private magpiecapital/magpie-limitclose
// repo; this bot only writes orders to the DB. The notification sender
// further down reads pending_notifications and DMs users when the engine
// fires an order.
{
  const lc = await import("./commands/limit-close.js");
  // Primary names + memorable aliases. "/takeprofit" + "/tp" are
  // dramatically more discoverable than "/limitclose" — users know
  // what "take profit" means; "limit close" is jargon.
  bot.command("limitclose", lc.handleLimitClose);
  bot.command("takeprofit", lc.handleLimitClose);
  bot.command("tp", lc.handleLimitClose);
  bot.command("lo", lc.handleLimitClose);
  // /sell — operator-mandated 2026-06-16 PM after PUMP loan 810: users
  // reach for "sell at 1.3x" before they reach for "takeprofit at 1.3x".
  // Routes to handleLimitClose which infers direction from the parsed
  // strike (multiplier >= 1 → above/TP, < 1 → below/SL). Natural verb,
  // same arm-core path.
  bot.command("sell", lc.handleLimitClose);
  // /preview, /previewsl — TG arm pre-flight (operator-mandated
  // 2026-06-16 PM, feedback_tg_must_follow_v4_at_highest_level.md).
  // Dry-run any /takeprofit or /stoploss without persisting. Mirror
  // of x402's /agent/preflight + site's /arm-preflight so TG users
  // get the same "would this work?" check before committing a slot.
  bot.command(["preview", "checkarm", "preflight"], lc.handlePreviewTp);
  bot.command(["previewsl", "checkarmsl"], lc.handlePreviewSl);
  // Stop-loss — same arm-core path, direction='below' flips the engine's
  // trigger comparator from >= to <=. 1% protocol fee applies in BOTH
  // directions (operator rule 2026-06-12). Cutting losses before the
  // liquidation edge is the user's choice; the engine still charges
  // the fee on proceeds either way.
  bot.command("stoploss", lc.handleStopLoss);
  // Trailing-stop variant — the trigger floats with peak. See migration 057.
  bot.command("trailingstop", lc.handleTrailingStop);
  bot.command("ts", lc.handleTrailingStop); // memorable shortcut
  bot.command("sl", lc.handleStopLoss);
  // Bracket = TP + SL on the same loan in a single command. Atomic:
  // if leg 2 fails, leg 1 is rolled back so users never end up in a
  // half-armed state. Schema/engine already allow TP+SL on same loan
  // (migration 047 + sibling-cancel on fire).
  bot.command(["bracket", "tpsl", "protectboth"], lc.handleBracket);
  bot.command("limitorders", lc.handleLimitOrders);
  bot.command("takeprofitorders", lc.handleLimitOrders);
  bot.command("tps", lc.handleLimitOrders);
  bot.command("los", lc.handleLimitOrders);
  bot.command("stoplosses", lc.handleLimitOrders);
  bot.command("sls", lc.handleLimitOrders);
  bot.command("cancellimitorder", lc.handleCancelLimitOrder);
  bot.command("canceltp", lc.handleCancelLimitOrder);
  bot.command("cancelsl", lc.handleCancelLimitOrder);
  // Cancels both legs of a bracket on a loan in one shot — companion
  // to /bracket so users don't have to /cancellimitorder twice.
  bot.command(["cancelbracket", "canceltpsl"], lc.handleCancelBracket);
  // In-place order modification — change trigger / slippage / dest /
  // expires without canceling. Order stays armed throughout so users
  // can fine-tune without a market-move gap.
  bot.command(["modifyorder", "modifylimitorder", "lcmodify", "lc_modify"], lc.handleModifyLimitOrder);

  // Layer 3 — intervention callback handler (inline keyboard taps).
  // Registers a bot.callbackQuery(/^lcint:/) handler that processes
  // approve/decline/cancel taps from the intervention DMs the
  // engine sends when single-block + TWAP both can't fit within
  // the borrower's slippage cap.
  const lci = await import("./commands/limit-close-intervention.js");
  lci.registerLimitCloseInterventionCallbacks(bot);

  // /fixarm — TG analog of the site's V4 silent-arm-recovery banner
  // (operator-mandated 2026-06-16 PM). Detects V4 loans without
  // armed orders and surfaces one-tap retry buttons. Companion to
  // PR #147 (site recovery banner) so TG-only users get the same
  // rescue path.
  bot.command(["fixarm", "armretry", "recoverarm"], lc.handleFixArm);
  lc.registerFixArmCallbacks(bot);
}
// Agent delegations — Tier 2 (x402 agentic wrapper). Users authorize
// agents to arm limit-close orders on their behalf within explicit
// bounds (max per order, max active, max slippage, expiry). The
// magpie-x402 endpoint validates every agent request against these
// rows BEFORE writing to limit_close_orders.
{
  const ad = await import("./commands/agent-delegations.js");
  bot.command("agent_authorize", ad.handleAgentAuthorize);
  bot.command("agent_revoke", ad.handleAgentRevoke);
  bot.command("agent_list", ad.handleAgentList);
}
// Agent delegations — Tier 2 (x402 agentic wrapper). Users authorize
// agents to arm limit-close orders on their behalf within explicit
// bounds (max per order, max active, max slippage, expiry). The
// magpie-x402 endpoint validates every agent request against these
// rows BEFORE writing to limit_close_orders.
{
  const ad = await import("./commands/agent-delegations.js");
  bot.command("agent_authorize", ad.handleAgentAuthorize);
  bot.command("agent_revoke", ad.handleAgentRevoke);
  bot.command("agent_list", ad.handleAgentList);
}

// Governance autopilot admin — operator-only commands gated inside each handler
// via OPERATOR_TG_IDS env var. /gov-pause is the master kill switch.
bot.command("gov-pause", handleGovPause);
bot.command("gov_pause", handleGovPause);   // underscore alias (TG strips dashes inconsistently on some clients)
bot.command("feedback", handleFeedback);    // operator-only: review captured user replies (see fallback reply-capture)
bot.command("gov-resume", handleGovResume);
bot.command("gov_resume", handleGovResume);
bot.command("gov-status", handleGovStatus);
bot.command("gov_status", handleGovStatus);
bot.command("gov-confirm-manual", handleGovConfirmManual);
bot.command("gov_confirm_manual", handleGovConfirmManual);

// $MAGPIE burn ledger admin
bot.command("burn-confirm", handleBurnConfirm);
bot.command("burn_confirm", handleBurnConfirm);
bot.command("burn-record", handleBurnRecord);
bot.command("burn_record", handleBurnRecord);
bot.command("burn-stats", handleBurnStats);
bot.command("burn_stats", handleBurnStats);
bot.command("burn-pending", handleBurnPending);
bot.command("burn_pending", handleBurnPending);

// Public voter-engagement commands
bot.command("vote", handleVote);
bot.command("votingpower", handleVotingPower);
bot.command("voting_power", handleVotingPower);

// User-driven governance nominations — anyone can nominate, upvote, etc.
// Operator-only review command gated inside its handler.
bot.command("nominate", handleNominate);
bot.command("nominations", handleNominationsList);
bot.command("upvote_nomination", handleUpvoteNomination);
bot.command("withdraw_nomination", handleWithdrawNomination);
bot.command("my_nominations", handleMyNominations);
bot.command("nomination_review", handleNominationReview);

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
// Support vigil callbacks must register BEFORE bot.start — Grammy
// throws if listeners are added during another listener's execution.
// The vigil's timer starts later via startSupportVigil() from inside
// the runtime startup section.
registerSupportVigilCallbacks(bot);
registerLcStalenessCallbacks(bot);
registerLcRetryingCallbacks(bot);
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
registerExploitDetectorCallbacks(bot);
registerStartCallbacks(bot);
registerFallbackCallbacks(bot);

// Community moderation handlers — register BEFORE the message:text
// fallback so URL deletes / quarantine kicks happen before any
// other text-handling tries to process the message. Per-chat opt-in
// (community_chats.enabled) means it's a no-op in any chat the
// operator hasn't run /community_enable in.
import { registerCommunityHandlers, handleAppealCommand } from "./handlers/community-handlers.js";
import { setBotTgId } from "./services/community-moderation.js";
// /appeal must be registered BEFORE the generic group message handler that
// registerCommunityHandlers installs, so a DM /appeal from a removed user
// reaches the command (the message handler early-returns on non-group chats).
bot.command("appeal", handleAppealCommand);
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
          "*That didn't go through.*",
          "",
          "Server-side hiccup — logged and routed to ops.",
          "",
          "Try the same command again. If it sticks, use /support to chat with a human.",
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
      { command: "home", description: "Home / main menu" },
      { command: "wallet", description: "Your wallet + SOL balance" },
      { command: "wallets", description: "Switch between your wallets" },
      { command: "unlock", description: "See your borrow potential" },
      { command: "borrow", description: "Take a loan" },
      { command: "positions", description: "Active loans" },
      { command: "calendar", description: "Loans sorted by due date" },
      { command: "health", description: "Loan health snapshot" },
      { command: "autoprotect", description: "Auto-Protect (anti-liquidation)" },
      { command: "repay", description: "Repay a loan" },
      { command: "deposit", description: "Show deposit address" },
      { command: "withdraw", description: "Withdraw SOL" },
      { command: "supported", description: "Approved collateral tokens" },
      { command: "credit", description: "Your credit score + points" },
      { command: "history", description: "Loan history" },
      { command: "refer", description: "Earn 10% of friends' loan fees" },
      { command: "share", description: "Flex your loan / streak on Twitter" },
      { command: "holders", description: "$MAGPIE holder rewards" },
      { command: "distributions", description: "Your full distribution history" },
      { command: "submit", description: "Submit a new token" },
      { command: "magpie", description: "$MAGPIE token info" },
      { command: "support", description: "Self-serve help / message the team" },
      { command: "mytickets", description: "Your support tickets + status" },
      { command: "community", description: "Join the public @magpietalk group" },
      { command: "site", description: "Open magpie.capital" },
      { command: "security", description: "Account security view + lock buttons" },
      { command: "privacy", description: "What we store + your controls" },
      { command: "lock", description: "Emergency pause on site signed actions" },
      { command: "exportdata", description: "DM yourself a JSON file of your account" },
      { command: "tx", description: "Lookup any Solana tx by signature" },
      { command: "help", description: "Full command list" },
    ]);
    await bot.api.setChatMenuButton({
      menu_button: { type: "commands" },
    });
  } catch (err) {
    console.warn("[bot] setMyCommands failed:", err.message);
  }
}

console.log("Magpie bot starting...");
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
    // Seed current pinned messages so Pip is aware of announcements pinned
    // while the bot was offline (Telegram doesn't re-send pin events on boot).
    import("./services/community-pins.js").then((m) => m.seedPinsForEnabledChats(bot.api)).catch(() => {});
    // Token-catalog → @MagpieLoans auto-announce — reconciliation worker that
    // diffs supported_mints.enabled and tweets when a token is added/removed
    // from the approved-collateral catalog (the /tokens page). No-op posting
    // until X_API_KEY/SECRET + X_ACCESS_TOKEN/SECRET are set; seeds state
    // meanwhile so it never backlog-dumps. See token-catalog-announcer.js.
    import("./services/token-catalog-announcer.js").then((m) => m.startTokenCatalogAnnouncer(bot));
    // Points reconciler — self-heals the points ledger (backstop to the inline
    // forward-sync in loans.js) AND clears the historical backlog of loans
    // opened after the 2026-06-27 manual backfill. Idempotent; audit 2026-06-28
    // P0/P1 (points were frozen — new loans accrued zero). See points-reconciler.js.
    import("./services/points-reconciler.js").then((m) => m.startPointsReconciler());
    // Overdue-loan alarm REMOVED 2026-06-28 per operator ("I don't want an
    // alarm") — superseded by the fair-liquidation build (default handling
    // becomes automatic + fair on-chain, so no alert is needed).
    // Raid monitor — DISABLED 2026-06-12 per operator. The Nitter
    // upstream instances die constantly and the X API requires a paid
    // bearer token; alerts about "data sources offline" were noise.
    // To re-enable: uncomment the line below + supply X_BEARER_TOKEN
    // on Railway. Code lives in src/services/raid-monitor.js untouched.
    // import("./services/raid-monitor.js").then((m) => m.startRaidMonitor(bot));
    // Notification sender — drains pending_notifications and DMs users.
    // Used by the private limit-close engine to talk back to TG users.
    import("./services/notification-sender.js").then((m) => m.startNotificationSender(bot));
    registerBotCommands();
    // Background watchers — stagger startup to avoid RPC rate-limit flood.
    // Deposit watcher disabled: free public RPC can't handle background polling.
    // Re-enable when a dedicated RPC endpoint is available.
    setSecurityAlertBot(bot);
    setLenderAlarmBot(bot);
    // Register bot for module-level notifyAdmin() calls from API
    // handlers (e.g. support-ask, cosign-borrow) that don't otherwise
    // have access to a bot ref.
    setNotifyBot(bot);
    startApiServer();
    // Idempotent governance vote table init — runs once at startup,
    // ON CONFLICT-safe so re-runs are a no-op.
    initGovernanceSchema().catch((err) =>
      console.warn("[bot] initGovernanceSchema failed (continuing):", err.message),
    );
    // Governance autopilot — wakes every 5 min, processes any proposal whose
    // voting window has closed. No-op while autopilot is disabled (operator
    // toggle via /gov-pause /gov-resume; DB-backed flag). Safe to start even
    // before any proposal is active — pipeline finds no work and exits clean.
    import("./services/governance-pipeline-scheduler.js").then((m) =>
      m.startGovernancePipelineScheduler(),
    );
    // Vote-reminder scheduler — smart cadence (4-6 posts per proposal across
    // the voting window, not hourly spam). Idempotent via governance_reminders
    // table primary key. No-op when no proposal is in an active window.
    import("./services/governance-reminder-scheduler.js").then((m) =>
      m.startGovernanceReminderScheduler(),
    );
    // Shadow-LendingPool detective control — polls mainnet for non-canonical
    // LendingPool inits on the live program (the exploit-prep signature for
    // the loan-pool-substitution drain found in the 2026-06-10 audit) and
    // DMs the operator on first detection per shadow pool. Read-only.
    import("./services/shadow-pool-watcher.js").then((m) =>
      m.startShadowPoolWatcher(),
    );
    setTimeout(() => startDailyOpsReport(bot), 60_000);
    setTimeout(() => startX402DailyDigest(bot), 75_000);
    startUsedNoncesCleaner();
    // startDepositWatcher(bot);
    setTimeout(() => startLoanWatcher(bot), 5_000);
    setTimeout(() => startHealthWatcher(bot), 10_000);
    setTimeout(() => startRiskEngine(bot), 15_000);
    setTimeout(() => startPumpWatcher(bot), 20_000);
    setTimeout(() => startTokenScreener(bot), 25_000);
    setTimeout(() => startTokenHealth(bot), 30_000);
    // Apply file-based migrations BEFORE startup-patches and BEFORE
    // anything else that writes to the DB. Migration 017 sat unapplied
    // in prod for several hours after PR-merge today because there was
    // no auto-runner — manual psql was the previous workflow. We crash
    // on failure: a half-migrated DB is worse than a visibly-down bot.
    //
    // Sequencing matters: the previous version kicked both
    // applyPendingMigrations and applyStartupPatches off as parallel
    // .then() chains, which meant startup-patches could race against
    // the migration runner during a clean deploy — patches could land
    // on a pre-migration schema (and either fail or no-op the wrong
    // version of the table). The IIFE serializes them.
    (async () => {
      try {
        const runner = await import("./db/migrations-runner.js");
        const res = await runner.applyPendingMigrations();
        if (res.applied.length > 0) {
          console.log(`[migrations] applied ${res.applied.length} new migration(s): ${res.applied.join(", ")}`);
        }
      } catch (err) {
        // CHANGED 2026-06-11: previously we process.exit(1) on migration
        // failure, the reasoning being "a half-migrated DB is worse than
        // a visibly-down bot." That trade-off ate us at 21:04Z when a
        // ledger desync caused 027 to re-run + ADD CONSTRAINT fail; the
        // bot crashloop took the whole site + Pip down for ~30 minutes
        // while users couldn't /borrow or /repay anything.
        //
        // New trade-off: log + alert operator + KEEP SERVING the API.
        // The API server already started at line 553, and the previous
        // schema is functional for everything that was working before
        // the failed migration. The only thing that breaks is what the
        // NEW migration was supposed to add — which is feature work,
        // not core functionality.
        //
        // We page the operator via the security-alerts DM so they know
        // a migration is stuck and can intervene. We also set a process
        // env flag DB_MIGRATIONS_FAILED so admin commands can check it.
        console.error("[bot] migrations FAILED — CONTINUING in degraded mode:", err.message);
        process.env.DB_MIGRATIONS_FAILED = err.message?.slice(0, 500) || "unknown";
        try {
          const { sendSecurityAlert } = await import("./services/security-alerts.js");
          await sendSecurityAlert(
            `🚨 BOT MIGRATIONS FAILED on boot — running in DEGRADED mode.\n\n` +
            `error: ${err.message?.slice(0, 300)}\n\n` +
            `Core /borrow + /repay + site still serving the EXISTING schema.\n` +
            `Investigate the migration manually: Railway shell -> psql -> check the failing migration's SQL.\n` +
            `Then either fix the file + redeploy, or run the SQL + INSERT INTO schema_migrations.`,
          );
        } catch (alertErr) {
          console.error("[bot] couldn't even DM the migration alert:", alertErr.message);
        }
      }
      try {
        const pool = await import("./db/pool.js");
        await pool.applyStartupPatches();
      } catch (err) {
        console.warn("[bot] applyStartupPatches failed (continuing):", err.message);
      }
    })();
    startDbHealth(bot); // Start immediately — monitors DB connectivity
    // Self-monitoring — probes sub-systems every 60s and DMs operator
    // on degradation BEFORE users notice. Catches silent failures the
    // external watchdogs can't see (queue backlog, DB pool exhaustion,
    // stuck orders, lingering TWAPs, migration ledger drift).
    import("./services/self-monitor.js").then((m) => m.startSelfMonitor(bot));
    // LP-excess monitor — every 6h, reads each program's pool +
    // loan_token_vault and DMs operator with the per-pool excess
    // (vault_balance - total_deposits). Read-only telemetry; no
    // on-chain action. Foundation for the eventual auto-sweeper.
    // [[feedback_distribution_wallet_must_be_auto_funded]]
    import("./services/lp-excess-monitor.js").then((m) => m.startLpExcessMonitor(bot));
    // LP-excess auto-sweeper (Phase 2) — every 24h, calls admin_withdraw
    // on each pool with positive excess and routes the SOL directly to
    // CHCAM via the closeAccount-with-arbitrary-destination pattern.
    // Default: dry-run. Operator flips LP_EXCESS_AUTO_SWEEP_ENABLED=true
    // on Railway to live-broadcast. [[feedback_distribution_wallet_must_be_auto_funded]]
    import("./services/lp-excess-sweeper.js").then((m) => m.startLpExcessSweeper(bot));
    // Upside Watcher — every 15 min, scans active loans whose collateral
    // has appreciated and DMs the borrower a Pip nudge to arm a TP. Seeds
    // first take-profit fills by surfacing the opportunity the moment it
    // exists, instead of waiting for the user to think to check.
    import("./services/upside-watcher.js").then((m) => m.startUpsideWatcher());
    // Credit-events auto-healer — every 6h, scans for loans missing
    // canonical credit_events and backfills them. Belt-and-suspenders
    // for the live recordLoan / markLoanRepaid writers; any future bug
    // that drops an event has its impact bounded to one healer cycle.
    // Self-monitor's stale_credit probe DMs the operator faster.
    import("./services/credit-events-healer.js").then((m) => m.startCreditEventsHealer());
    // Take-profit fee accrual — every 2 min, finds fired TP orders that
    // haven't been accrued yet and routes the 1% protocol_fee_lamports
    // through accrueFromLoan + accrueToHolderPool + accrueToLpLoyaltyPool.
    // Same pipeline as borrow fees, so MGP-001's 70/10/10/10 rebalance
    // applies uniformly to BOTH fee types once ratified.
    import("./services/limit-close-fee-accrual-watcher.js").then((m) => m.startLimitCloseFeeAccrualWatcher());
    // Protocol fee sweeper — hourly, consolidates TP fees from
    // PROTOCOL_FEE_DESTINATION into the lender wallet so the existing
    // distributor includes them in the 70-10-10-10 split. NO-OPs silently
    // if PROTOCOL_FEE_KEYPAIR isn't set — operator can sweep manually
    // + use /protocolfees for state.
    import("./services/protocol-fee-sweeper.js").then((m) => m.startProtocolFeeSweeper());
    // Downside Watcher — symmetric to upside. Pip DMs at -20% / -35% /
    // -50% depreciation with concrete derisk options BEFORE the
    // health-watcher's liquidation tiers escalate.
    import("./services/downside-watcher.js").then((m) => m.startDownsideWatcher());
    // Support vigil — closes the awaiting_user gap so no support case
    // goes silently unresolved. Pip DMs the user at 24h + 96h asking
    // "did this resolve?" with inline confirm/reopen buttons, and
    // auto-closes after 7d total of silence.
    import("./services/support-vigil.js").then((m) => m.startSupportVigil(bot));
    setTimeout(() => startHeliusUsageWatcher(bot), 60_000); // Helius credit alerts
    // Neon quota watcher — hourly probe of Neon's HTTP API; pages
    // the operator when usage crosses NEON_ALERT_THRESHOLD_PCT (default
    // 70%) on compute or storage. Closes the 2026-06-14 outage class
    // ([[project_magpie_outage_2026_06_14_neon_quota]]) by giving us a
    // 24h+ heads-up before the quota cliff. Silent no-op if NEON_API_KEY
    // / NEON_PROJECT_ID aren't set.
    import("./services/neon-quota-watcher.js").then((m) => m.startNeonQuotaWatcher());
    // Extend-loan fee-wallet watcher — mitigates v1 Anchor Finding 1
    // (SECURITY-AUDIT-ANCHOR-2026-06-09.md). Polls confirmed program
    // sigs every 30s, audits extend_loan instructions, applies a
    // credit-score penalty on detected fee-wallet evasion. Removed
    // once v3 ships with the on-chain owner constraint.
    setTimeout(() => startExtendLoanWatcher(), 40_000);
    // Push fresh prices to on-chain price feeds. DB-driven: the attestor
    // queries supported_mints (enabled=TRUE) every tick, so newly approved
    // tokens get attested without a restart.
    //
    // 20s interval: V4's on-chain TWAP needs 8 samples in the rolling
    // 5-minute window. At 20s ticks the V4 throttle (MAX_GAP_MS_V4=35s)
    // writes every other tick → ~40s effective cadence → 7-8 samples in
    // any 5-min window. Previous 45s interval gave ~90s effective cadence
    // (only 3-4 samples in window), which caused SPCX V3 borrows to fail
    // with PriceImpactPumpDetected when price moved during the long gap.
    // Operator hit it 2026-06-17 PM. Forensic: scripts/diagnose-spcx-twap-lag.mjs
    const PRICE_ATTESTOR_TICK_MS = Number(process.env.PRICE_ATTESTOR_TICK_MS) || 20_000;
    setTimeout(() => startPriceAttestor(PRICE_ATTESTOR_TICK_MS), 35_000);
    // FEED-INIT SWEEP — guarantees every enabled mint's price-feed PDA(s) exist
    // (category pool + V4) so a user can NEVER hit AccountNotInitialized on a
    // borrow, especially for a freshly-approved token. Boot heals any token
    // already in that state (e.g. $ANSEM was); the 90s tick covers new approvals
    // even if an approval-path hook is missed. Cheap (skips confirmed mints).
    setTimeout(() => ensureAllEnabledFeedsInitialized().catch((e) => console.warn("[feed-init-sweep] boot failed:", e.message?.slice(0, 120))), 45_000);
    setInterval(() => ensureAllEnabledFeedsInitialized().catch((e) => console.warn("[feed-init-sweep] tick failed:", e.message?.slice(0, 120))), 90_000);
    // RWA screener — discovers Backed Finance xStocks + similar via DexScreener
    // search every 4h. Auto-adds new mints meeting liquidity/volume thresholds.
    // Auto-disables enabled RWAs that degrade or get paused by the issuer.
    // Delayed start to avoid bunching with other startup workers.
    setTimeout(() => startRwaScreener(bot), 180_000);
    // $MAGPIE holder reward distributions — DISABLED as of MGP-001 (2026-06-10).
    // Distributions now flow through the governance autopilot (MGP-XXX) instead
    // of an automated bot-driven cadence. The auto-snapshotter previously created
    // pre-staged rows in magpie_holder_rewards that confused the dashboard's
    // activity feed when the actual on-chain send never happened. Keeping it
    // permanently off; if a future MGP proposal restores automated distributions,
    // re-enable this line as part of that proposal's ratified implementation.
    // setTimeout(() => startHolderDistributor(bot), 90_000);
    // LP Loyalty distributor — rewards long-term LPs from 10% of fees
    setTimeout(() => startLpLoyaltyDistributor(), 120_000);
    // Loan reconciler — proactively syncs DB state with on-chain truth
    // every 5 min. Catches partial-repay/extend/liquidation drift.
    setTimeout(() => startLoanReconciler(), 45_000);
    // Liquidation economics watcher (2026-06-14 policy, Phase 1A) —
    // tracks per-default principal vs sale proceeds and the
    // pre-computed 70/10/10/10 distribution splits. Data capture only;
    // the actual ledger credits happen in the distribution watcher
    // below. $MAGPIE collateral defaults stay 'magpie_burn_pending'
    // until the operator manually conducts the burn.
    import("./services/liquidation-economics-watcher.js").then((m) =>
      m.startLiquidationEconomicsWatcher(),
    );
    // Liquidation distribution watcher (Phase 2) — picks up
    // 'awaiting_distribution' rows and credits the rewards pool
    // ledgers via the existing accrual primitives. Idempotent via
    // row status transitions + per-loan event_type='default_profit'
    // uniqueness on protocol_reserve_events + referral_earnings.
    import("./services/liquidation-distribution-watcher.js").then((m) =>
      m.startLiquidationDistributionWatcher(),
    );
    // Liquidation safety watchdog — the "keeper canary." READ-ONLY: DMs the
    // operator if any active loan goes overdue and is NOT liquidated (i.e. the
    // separate keeper process is down/stalled/unfunded). The post-liquidation
    // watchers above assume liquidations happen; this makes the EXECUTOR's
    // health observable so a silent keeper death can't accrue bad debt unseen.
    import("./services/liquidation-safety-watchdog.js").then((m) =>
      m.startLiquidationSafetyWatchdog(bot),
    );
    // Exploit-detector — auto-bans wallets/users matching the
    // pump-and-borrow attack pattern, alerts on weaker signals.
    // Multi-signal requirement (outcome + profile) keeps false-positive
    // ban rate low. Idempotent; respects already-banned actors.
    setTimeout(() => startExploitDetector(bot), 75_000);
    // Price snapshotter — feeds the off-chain TWAP gate. Captures live
    // DEX price + liquidity every 2 min for every enabled non-RWA mint
    // and stores in mint_price_snapshots. The borrow flow's TWAP check
    // queries this trailing window to refuse loans against pumped pools.
    setTimeout(() => startPriceSnapshotter(), 80_000);
    // Overnight safety: DMs admin if lender wallet drops below safe thresholds
    setTimeout(() => startLenderBalanceWatcher(bot), 60_000);
    // Same pattern for the limit-close engine topup wallet. P0 from
    // LIMIT_CLOSE_ENGINE_AUDIT.md — if this drains, every engine fire
    // reverts with topup_transfer_failed and no orders execute.
    setTimeout(() => startEngineTopupWatcher(bot), 65_000);
    // Operator fire/failure alerts on limit-close orders. Polls every 60s
    // for fired/partial_fired/failed orders past a cursor and DMs the
    // operator. Critical for "perfected" demo readiness — operator sees
    // every fire + failure in real time.
    setTimeout(() => startLcOperatorAlerts(bot), 70_000);
    // Engine heartbeat — DMs operator with WARN/CRITICAL/EMERGENCY tiers
    // if the limit-close engine stops ticking. Pairs with the engine's
    // tick-time writeHeartbeat() in magpie-limitclose PR #9.
    setTimeout(() => startEngineHeartbeatWatcher(bot), 75_000);
    // Limit-close staleness sweeper — every 6h DMs users whose armed
    // orders are old AND trigger far from current price. One-time
    // nudge per order. See feedback_tg_changes_careful.
    setTimeout(() => startLimitCloseStalenessWatcher(), 90_000);
    // Stale-arm-intent watcher — every 60s DMs users whose V4 arm
    // intents (recorded by site / TG / Pip / x402) haven't resolved
    // to an armed order within 90s. Proactive recovery for silent
    // arm drops; reactive surfaces (/fixarm + site recovery banner)
    // still work without this, but the watcher catches users who
    // never look. Operator-mandated 2026-06-16 PM after PUMP loan
    // 810. See [[feedback_tg_v4_must_match_site_quality]].
    setTimeout(() => startStaleArmIntentWatcher(), 30_000);
    // Near-trigger nudge — every 5 min DMs users whose armed orders
    // are within ~10% of firing. One-time per arm; reset on modify so
    // a re-tuned trigger gets a fresh nudge if it lands in the band.
    // Different cadence + audience than the staleness watcher:
    // staleness = "forgotten old order", near-trigger = "imminent
    // action heads-up". See feedback_tg_changes_careful.
    setTimeout(() => startLimitCloseNearTriggerWatcher(), 95_000);
    // Impersonator watchdog — every 30 min retroactively scans the
    // last 24h of community joins against the CURRENT
    // IMPERSONATION_PATTERNS list. Catches impersonators who slipped
    // through during a bot-down window OR who joined before a
    // relevant pattern was added (e.g. \bpip\b added 2026-06-13
    // after the live incident). Defense-in-depth on top of the
    // real-time on-join filter.
    setTimeout(() => startImpersonatorWatchdog(bot), 95_000);
    // Canary watcher — reads engine_canary_runs (written by the
    // engine every hour) and DMs operator on consecutive failures.
    // The actual canary RUNS in the magpie-limitclose engine; this
    // is the bot-side observation surface.
    setTimeout(() => startCanaryWatcher(bot), 105_000);
    // Borrow canary — every 60s, probes the 4 critical predictors of a
    // successful V4 borrow. Logs to conversion_events.borrow_canary;
    // DMs operator on 2 consecutive fails per check, recovery DM on
    // first success after a fail. Catches every "users would currently
    // see this class" degradation within 60s. Mandated 2026-06-19 PM.
    setTimeout(() => startBorrowCanary(bot), 110_000);
    // x402-path canary — every ~5 min, drives the cross-service
    // x402 → bot → cosign borrow CONTRACT (HOP1 x402 /health, HOP2 x402
    // discovery doc, HOP3 inner build-borrow summary + x402 field-shape
    // transform, HOP4 cosign field-name, HOP5 build-repay field-contract).
    // BUILD-ONLY: never pays, signs, or cosigns — zero SOL, zero on-chain
    // effect. Catches auth/PUBLIC_ROUTES omission, proxy field rename,
    // summary-shape drift, and cosign field rename — the cross-service
    // failure class borrow-canary cannot see. DMs operator on 2 consecutive
    // fails per hop, recovery DM on first success, logs to
    // conversion_events(path='x402_path_canary').
    setTimeout(() => startX402PathCanary(bot), 115_000);
    // Boot-time V4 PriceFeed sync — at +90s, walk every enabled
    // supported_mints entry and ensure the V4 PriceFeed PDA exists.
    // Eliminates the AccountNotInitialized class for never-borrowed-
    // against mints. Per V4 loan lifecycle mandate NN1 (operator-
    // mandated 2026-06-19 PM after user 948 incident).
    startBootV4FeedSync(bot);
    // x402 standard-rail destination ATAs — idempotently ensure the payTo
    // wallet's USDC + wSOL ATAs exist so the standard v2 SVM rail can settle
    // (the x402 service is keyless; the bot owns the payTo == lender wallet).
    // No-ops once they exist. +50s so the RPC + keypair are ready.
    setTimeout(() => ensureX402DestinationAtas(bot).catch((e) =>
      console.warn("[x402-atas] boot ensure threw:", e.message)
    ), 50_000);
    // V4 feed readiness — priority-mint burst warmup on boot. After
    // a 30s settle window so DB pool + attestor are alive. State
    // surfaces on /api/v1/health.v4_feeds; the site reads it to gate
    // the borrow CTA so users never see wait_for_warmup. THE
    // architectural class-elimination fix for the redeploy-cold-feed
    // class. Operator-mandated 2026-06-19 PM.
    setTimeout(() => startFeedReadinessWarmup().catch((e) =>
      console.warn("[v4-readiness] start threw:", e.message)
    ), 30_000);
    // Loan program_id healer — every 10 min, scans non-closed loans
    // and auto-corrects any DB row whose stored program_id disagrees
    // with the on-chain owner of loan_pda. Defense-in-depth layer
    // alongside the write-time on-chain authoritative check in
    // recordLoan + the self-monitor drift probe. Ensures user-facing
    // wallet-scoped filtering on the dashboard never silently drops
    // a loan due to stale/wrong program_id.
    setTimeout(() => startLoanProgramIdHealer(bot), 115_000);
    // engine_program_id NULL sentinel — DMs admin if any post-2026-06-13
    // limit_close_orders row is missing engine_program_id. Closes the
    // silent-wrong-pool-fire failure mode flagged in the V3 audit.
    setTimeout(() => startLimitCloseEngineProgramIdSentinel(bot), 120_000);
    // Wallet-attribution sentinel — DMs admin if any active/overdue loan
    // is attributed to the wrong user_id (ghost site_native instead of the
    // canonical TG-linked user). Closes the failure-mode behind PR #231
    // + #232 — operator hit it on V3 SPCX loan id=720 not visible in /repay.
    setTimeout(() => startWalletAttributionSentinel(bot), 125_000);
    // Stocks/RWA protection sentinel — enforces category-level invariant
    // that every enabled stock/rwa mint MUST be hot+protected. Operator-
    // mandated 2026-06-19 PM after TSLAx StalePriceAttestation. JIT
    // attestation cannot fill the 8-sample TWAP window for low-liquidity
    // xStocks. Runs immediately on boot, then every 5 min.
    setTimeout(() => startStocksRwaProtectionSentinel(), 5_000);
    // V4 Hardening T5 (2026-06-15 PM) — sweeps every active V4 loan
    // every 15 min and verifies the sol_proceeds_vault PDA is either
    // uninitialized OR owned by classic SPL Token (NOT Token-2022).
    // Catches any regression of the patched Token-2022 init bug class
    // within minutes instead of when the next user hits it. Read-only;
    // V4-only; degrades silently on RPC blip.
    setTimeout(() => startV4LoanHealthProbe(bot), 130_000);
    // Loan actual-received watchdog — backfills + verifies the
    // on-chain SOL delta per borrow row. Catches the class of bug
    // where the dashboard shows ~$1 more "received" than the
    // borrower's wallet actually went up by (2026-06-13 audit
    // finding — protocol takes account-creation rent out of loan
    // proceeds without reflecting it in loan_amount_lamports).
    setTimeout(() => startLoanReceivedWatchdog(bot), 130_000);
    // First-V2-fire watcher — one-shot celebratory DM when the very
    // first RWA limit-close fires through V2. End-to-end RWA
    // limit-close shipped 2026-06-13; this watcher closes the loop
    // by announcing when production validates it.
    setTimeout(() => startFirstV2FireWatcher(bot), 145_000);
    // First V3 limit-close fire watcher — two prongs: celebrate the first
    // successful V3 fire AND alert on the first V3 fire FAILURE so the
    // operator hears about a broken executeRepayLoanV3 path BEFORE more
    // orders pile up. Closes the V3-engine-readiness gap from the audit.
    setTimeout(() => startLimitCloseFirstV3FireWatcher(bot), 150_000);
    // First-V4-fire watcher (2026-06-15) — V4 fires via convert_collateral_slice
    // which is a brand-new path. Same celebrate/alert two-prong model
    // as V3; closes the V4-engine-readiness gap from the Wave 4 audit.
    setTimeout(() => startLimitCloseFirstV4FireWatcher(bot), 150_000);
    // V4 fire-failure RATE watcher — complements the first-fire one-shot
    // by tracking ongoing failure rates per mint and engine-wide. Alerts
    // when 3+ failures hit one mint or 5+ across all mints in a 1h window.
    // First-fire watcher catches "V4 wired up?" — this one catches "V4
    // is wired but something is silently failing repeatedly."
    setTimeout(() => startV4FireFailureRateWatcher(bot), 180_000);
    // INTERIM detection for the unpatched V4 convert_collateral_slice drain
    // (audit #1 critical; on-chain fix ships as V4.x pending Sec3). Read-only.
    setTimeout(() => startV4ConvertDrainWatcher(bot), 190_000);
    // Auto-Protect — opt-in anti-liquidation. Watches every 90s.
    setTimeout(() => startAutoProtect(bot), 50_000);
    // Fee-wallet auto-sweeper — every 1h moves accrued fee SOL from
    // the lender's wSOL ATA to the distribution wallet (CHCAMWtn).
    // Idempotent + audit-logged via fee_wallet_sweeps table.
    // See src/services/fee-wallet-sweeper.js +
    // feedback_distribution_wallet_must_be_auto_funded.md.
    setTimeout(() => startFeeWalletSweeper(bot), 120_000);
    // Distribution-wallet gap monitor — every 10 min checks DB
    // accruals vs distributor on-chain balance, admin-DMs if the
    // next snapshot would skip (P0 if > 5 SOL deficit).
    setTimeout(() => startDistributionGapMonitor(bot), 130_000);
    // Distribution-wallet AUTO-FUNDER — every 15 min closes the gap the
    // monitor above only alerts on: tops the distribution wallet up to
    // (owed across pools + reserve) by moving EXACTLY the gap from the
    // lender wallet's native fee revenue. Gap-bounded + reserve-protected
    // + guarded + allowlisted + audited (distribution_funding_events).
    // Eliminates manual funding. Operator-mandated 2026-06-28.
    // See src/services/distribution-auto-funder.js +
    // memory feedback_distribution_wallet_must_be_auto_funded.
    // Boot-time custody discipline: the bot MUST run in lender-fallback mode —
    // it must NEVER hold CHCAM's private key (off-Railway custody minimizes
    // blast radius; distributions are operator-initiated LOCAL ops). CRIT-log +
    // admin-alert (NOT a hard throw, so a misconfig can never block boot /
    // loan execution — the #1 priority) if REWARDS_DISTRIBUTOR_PRIVATE_KEY is
    // ever set or the pubkey drifts from the canonical CHCAM.
    try {
      const disc = assertDistributorKeyDiscipline({ hard: false });
      if (!disc.ok) {
        notifyAdmin(
          bot,
          `🚨 *Distributor key discipline violated*\n${disc.issues.join("\n")}\n\nThe bot must NOT hold CHCAM's key. Unset REWARDS_DISTRIBUTOR_PRIVATE_KEY on Railway.`,
          { parse_mode: "Markdown" },
        ).catch(() => {});
      }
    } catch (e) {
      console.error("[boot] distributor key-discipline check failed:", e.message);
    }
    setTimeout(() => startDistributionAutoFunder(bot), 135_000);
    // Pending-arm retry watcher — Tier-2 architectural fix for the
    // arm-race failure class. When arm-core's 30s phase-1 polling
    // window expires, the arm is queued to pending_arms with the
    // signed-envelope freshness anchor. This watcher polls every 10s
    // and replays the arm the moment the loan row lands in DB —
    // user never has to re-sign. See
    // feedback_loan_830_full_postmortem_and_defenses.md.
    setTimeout(() => startPendingArmRetryWatcher(bot), 140_000);
    // Conditional-borrow watcher — fires agent intents when their
    // trigger condition (price/time/liquidity) matches. Postgres
    // advisory lock ensures single-instance even across replicas.
    setTimeout(() => {
      import("./services/intent-watcher.js")
        .then((m) => m.startIntentWatcher())
        .catch((err) => console.error("[bot] intent-watcher failed to start:", err.message));
    }, 100_000);
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
    // Treasury sweeper — periodically moves accumulated fees from the
    // lender wallet to the hardware-key-controlled treasury vault so a
    // compromise of the hot key bounds the lifetime-fee-drain loss to
    // a single sweep window. Disabled until TREASURY_SWEEP_DISABLED
    // is explicitly unset and an operational reserve is verified.
    // See project_treasury_vault_2026_06_18.
    setTimeout(() => startTreasurySweeper(bot), 130_000);
    // Liquidation collateral auto-sweeper — Layer 5 of the 2026-06-18
    // cosign-borrow exploit defense. Auto-Jupiters seized memecoin
    // collateral to SOL within ~60s of liquidation so the lender wallet
    // doesn't hold drain-bait. See
    // feedback_cosign_borrow_token_drain_exploit_2026_06_18.
    setTimeout(() => startLiquidationCollateralSweeper(bot), 140_000);
    // x402 USDC fee sweeper — converts accrued x402 API fees paid in USDC
    // to SOL, credits the holder pool's governance share (idempotent), and
    // routes the realized SOL to the distribution wallet. wSOL x402 fees
    // already flow via the fee-wallet sweeper (shared canonical ATA).
    // Disabled until X402_FEE_SWEEP_ENABLED=true. See x402-fee-sweeper.js.
    setTimeout(() => startX402FeeSweeper(bot), 150_000);
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
