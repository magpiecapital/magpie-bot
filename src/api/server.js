/**
 * Magpie Credit Protocol API Server
 *
 * RESTful API for external protocol integrations:
 *   - Credit score queries (composable primitive)
 *   - Token risk assessments
 *   - Marketplace stats
 *
 * Authentication: API key in X-API-Key header
 * Rate limiting: per-key, configurable
 */
import http from "node:http";
import { gzip, brotliCompress } from "node:zlib";
import { promisify } from "node:util";
import { query } from "../db/pool.js";
import crypto from "node:crypto";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const COMPRESS_MIN_BYTES = 1024; // Don't bother compressing tiny responses.

/**
 * Write a JSON response, compressing if the client supports it and
 * the body is large enough to benefit. Prefers brotli (better
 * compression ratio than gzip) when the client advertises it.
 *
 * Big aggregate endpoints (/transparency, /dashboard, /tokens) shrink
 * ~70-80% over the wire, which is material on mobile networks.
 */
async function writeJson(req, res, status, headers, body) {
  const json = JSON.stringify(body);
  const accept = (req.headers["accept-encoding"] || "").toString();

  if (json.length >= COMPRESS_MIN_BYTES) {
    if (/\bbr\b/.test(accept)) {
      try {
        const br = await brotliAsync(json);
        res.writeHead(status, { ...headers, "Content-Encoding": "br", "Vary": "Accept-Encoding" });
        res.end(br);
        return;
      } catch (e) {
        console.warn("[api] brotli failed, falling back:", e.message);
      }
    }
    if (/\bgzip\b/.test(accept)) {
      try {
        const gz = await gzipAsync(json);
        res.writeHead(status, { ...headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding" });
        res.end(gz);
        return;
      } catch (e) {
        console.warn("[api] gzip failed, sending plain:", e.message);
      }
    }
  }
  res.writeHead(status, headers);
  res.end(json);
}
import { getHeartbeats, getStartedAt } from "../lib/heartbeat.js";
import { handleCosignBorrow } from "./cosign-borrow.js";
import { handleAgentBuildBorrow } from "./agent.js";
import { handleAgentBuildRepay } from "./agent-repay.js";
import {
  handleAgentBuildExtend,
  handleAgentBuildTopup,
  handleAgentBuildPartialRepay,
} from "./agent-manage.js";
import { handleCreditAttest } from "./credit-attest.js";
import {
  handleAgentCreateIntent,
  handleAgentIntent,
  handleAgentListIntents,
} from "./agent-intents.js";
import { handleSyncLoan } from "./sync-loan.js";
import { handleDebugRecentErrors } from "./debug-recent-errors.js";
import { handleAiChatStream } from "./ai-chat-stream.js";
import { handleBackfillWalletLoans } from "./backfill-wallet-loans.js";
import { handleLenderAlarmWebhook } from "./lender-alarm-webhook.js";
import { handleLinkRequest, handleLinkStatus } from "./account-link.js";
import { handleSiteWithdraw } from "./withdraw.js";
import {
  handleSupportTickets,
  handleSupportTicketDetails,
  handleSupportDeleteTicket,
} from "./support-api.js";
import { handleSupportAsk } from "./support-ask.js";
import { handleWalletsList, handleWalletsSetActive } from "./wallets-api.js";
import { handlePrefsList, handlePrefsSet } from "./prefs-api.js";
import {
  handleGovernanceVoteSubmit,
  handleGovernanceVotesAggregate,
  initGovernanceSchema,
} from "./governance-api.js";
import { handleVotingPowerQuery } from "./governance-voting-power-api.js";
import { handleDistributionQuery } from "./governance-distribution-api.js";
import { handleDistributionsListQuery } from "./governance-distributions-list-api.js";
import { handleGovernanceTally } from "./governance-tally-api.js";
import { handleActivity } from "./activity-api.js";
import { handleAiChat } from "./ai-chat.js";
import { handlePipSession } from "./pip-session.js";
import { handleMeExport } from "./me-export.js";
import { handleDashboardAggregate } from "./dashboard-api.js";

// Staleness thresholds for each periodic service.
// 2x the configured POLL_INTERVAL_MS gives one missed cycle of slack.
const STALE_MS = {
  screener: 20 * 60 * 1000,        // 20 min (screener runs every 10)
  "token-health": 8 * 60 * 60 * 1000, // 8h (token-health runs every 4h)
};

// Grace period after startup before stale thresholds apply.
const STARTUP_GRACE_MS = 30 * 60 * 1000; // 30 min

const PORT = parseInt(process.env.PORT || process.env.API_PORT || "3001", 10);

// ─── Rate limiter ───────────────────────────────────────────────────────────
const rateLimitStore = new Map();

function checkRateLimit(keyHash, limitRpm) {
  const now = Date.now();
  const windowMs = 60_000;
  const key = keyHash;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, []);
  }

  const timestamps = rateLimitStore.get(key).filter(t => now - t < windowMs);
  if (timestamps.length >= limitRpm) {
    return false;
  }
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);
  return true;
}

// Per-IP rate limiter for PUBLIC routes — API-key gate doesn't apply, but
// we still don't want a single source enumerating per-wallet endpoints
// (governance distribution lookups, voting power, holder rewards) at scrape
// speed. Default 240 req/min/IP — well above legitimate dashboard polling,
// well below a useful scraper. Tunable per route below.
const ipRateLimitStore = new Map();
const PUBLIC_IP_LIMIT_RPM = parseInt(process.env.PUBLIC_IP_LIMIT_RPM || "240", 10);

function extractClientIp(req) {
  // Trust the leftmost x-forwarded-for value when behind Railway's proxy.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function checkIpRateLimit(ip, limitRpm) {
  const now = Date.now();
  const windowMs = 60_000;
  if (!ipRateLimitStore.has(ip)) {
    ipRateLimitStore.set(ip, []);
  }
  const timestamps = ipRateLimitStore.get(ip).filter((t) => now - t < windowMs);
  if (timestamps.length >= limitRpm) {
    return false;
  }
  timestamps.push(now);
  ipRateLimitStore.set(ip, timestamps);
  return true;
}

// Clean up rate limit stores every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore) {
    const valid = timestamps.filter(t => now - t < 60_000);
    if (valid.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, valid);
  }
  for (const [ip, timestamps] of ipRateLimitStore) {
    const valid = timestamps.filter((t) => now - t < 60_000);
    if (valid.length === 0) ipRateLimitStore.delete(ip);
    else ipRateLimitStore.set(ip, valid);
  }
}, 300_000);

// ─── Auth ───────────────────────────────────────────────────────────────────

async function authenticateRequest(req) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return null;

  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const { rows: [key] } = await query(
    `SELECT * FROM credit_api_keys WHERE api_key_hash = $1 AND enabled = true`,
    [keyHash],
  );
  if (!key) return null;

  if (!checkRateLimit(keyHash, key.rate_limit_rpm)) {
    return { rateLimited: true };
  }

  return key;
}

// ─── Route handlers ─────────────────────────────────────────────────────────

async function handleLpLoyalty(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  const { getLpLoyaltyByWallet, getLpLoyaltyRewardBps } = await import(
    "../services/lp-loyalty.js"
  );
  const info = await getLpLoyaltyByWallet(wallet);
  if (!info) return { status: 400, body: { error: "Invalid wallet" } };
  const liveBps = await getLpLoyaltyRewardBps();
  return {
    status: 200,
    body: {
      wallet: info.wallet,
      has_position: info.has_position,
      shares: info.shares,
      seconds_held: info.seconds_held,
      days_held: info.days_held,
      lifetime_lamports: info.lifetime_lamports.toString(),
      paid_lamports: info.paid_lamports.toString(),
      distributions_received: info.distributions_received,
      reward_bps: liveBps,
      reward_pct: liveBps / 100,
      // INTENTIONALLY OMITTED: weighted_deposit_at, next snapshot timing.
      // Same operator-private pattern as $MAGPIE holders.
      auto_distribute: true,
    },
  };
}

async function handleHolders(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  }
  const {
    getHolderInfoByWallet,
    MAGPIE_MINT,
  } = await import("../services/magpie-holder-rewards.js");
  const info = await getHolderInfoByWallet(wallet);
  if (!info) {
    return { status: 400, body: { error: "Invalid wallet address" } };
  }
  // info.holder_reward_bps_live reflects the LIVE bps from
  // governance_config (10% pre-MGP-001, 70% the moment it ratifies).
  const liveBps = info.holder_reward_bps_live;
  return {
    status: 200,
    body: {
      wallet: info.wallet,
      magpie_mint: MAGPIE_MINT.toBase58(),
      // balance_raw NOW INCLUDES collateralized $MAGPIE in addition to
      // in-wallet — matches the snapshot logic. held_raw and
      // collateralized_raw broken out for transparency.
      magpie_balance_raw: info.balance_raw,
      magpie_balance: Number(info.balance_raw) / 1e6, // $MAGPIE has 6 decimals
      held_raw: info.held_raw,
      collateralized_raw: info.collateralized_raw,
      has_balance: info.has_balance,
      reward_bps: liveBps,
      reward_pct: liveBps / 100,
      lifetime_lamports: info.lifetime_lamports.toString(),
      paid_lamports: info.paid_lamports.toString(),
      pending_lamports: info.pending_lamports.toString(),
      distributions_count: info.distributions_count,
      // The headline estimate includes any planned operator deposit
      // (HOLDER_REWARD_POOL_PLANNED_ADD_LAMPORTS env). The "live"
      // variant excludes it — clients that want strict-current-pool
      // can show that instead.
      estimated_next_payout_lamports: info.estimated_next_payout_lamports.toString(),
      estimated_next_payout_live_lamports: info.estimated_next_payout_live_lamports.toString(),
      // INTENTIONALLY NOT EXPOSED: snapshot timing. The window is random
      // (5-10 days) and internal-only — prevents mercenary holders from
      // timing buy-just-before / dump-just-after distributions.
      auto_distribute: true,
    },
  };
}

async function handleHolderPool() {
  const { getHolderPoolState, getHolderRewardBps } = await import(
    "../services/magpie-holder-rewards.js"
  );
  const [state, liveBps] = await Promise.all([
    getHolderPoolState(),
    getHolderRewardBps(),
  ]);
  return {
    status: 200,
    body: {
      pool_lamports: state.accrued_lamports.toString(),
      pool_sol: Number(state.accrued_lamports) / 1e9,
      reward_bps: liveBps,
      reward_pct: liveBps / 100,
      // Timing intentionally omitted — snapshots fire at random within
      // a hidden 5-10 day window after each distribution.
    },
  };
}

async function handleReferrals(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  }
  const { getReferralSummaryByWallet, getReferralRewardBps, MIN_CLAIM_LAMPORTS } =
    await import("../services/referral-rewards.js");
  const [summary, liveReferralBps] = await Promise.all([
    getReferralSummaryByWallet(wallet),
    getReferralRewardBps(),
  ]);
  if (!summary) {
    return {
      status: 404,
      body: {
        error: "Wallet not linked to a Magpie account. Start the Telegram bot first.",
        bot_url: "https://t.me/magpie_capital_bot",
      },
    };
  }
  const botUsername = process.env.BOT_USERNAME || "magpie_capital_bot";
  const siteUrl = (process.env.MAGPIE_SITE_URL || "https://magpie.capital").replace(/\/$/, "");
  // Dual share links so referrers can pick the surface that fits
  // their audience. share_link kept for backward compat (TG-targeted).
  // site_share_link is the magpie.capital landing with ?ref= — the
  // site captures it via RefCapture and attributes on auto-bootstrap.
  const tgShareLink = summary.code
    ? `https://t.me/${botUsername}?start=${summary.code}`
    : null;
  const siteShareLink = summary.code
    ? `${siteUrl}?ref=${summary.code}`
    : null;
  return {
    status: 200,
    body: {
      code: summary.code,
      share_link: tgShareLink,           // backward-compat (TG audience)
      site_share_link: siteShareLink,    // for the magpie.capital audience
      tg_share_link: tgShareLink,        // explicit alias
      reward_bps: liveReferralBps,
      reward_pct: liveReferralBps / 100,
      min_claim_lamports: MIN_CLAIM_LAMPORTS.toString(),
      referred_count: summary.referred_count,
      borrowed_count: summary.borrowed_count,
      lifetime_lamports: summary.lifetime_lamports.toString(),
      paid_lamports: summary.paid_lamports.toString(),
      claimable_lamports: summary.claimable_lamports.toString(),
    },
  };
}

async function handleCreditScore(req, url) {
  const wallet = url.searchParams.get("wallet");
  const userId = url.searchParams.get("user_id");

  if (!wallet && !userId) {
    return { status: 400, body: { error: "Provide ?wallet=<address> or ?user_id=<id>" } };
  }

  let scoreData;
  if (wallet) {
    const { getScoreByWallet } = await import("../services/credit-score.js");
    scoreData = await getScoreByWallet(wallet);
  } else {
    const { getCreditScore } = await import("../services/credit-score.js");
    scoreData = await getCreditScore(parseInt(userId));
  }

  if (!scoreData) {
    return { status: 404, body: { error: "No credit score found" } };
  }

  return {
    status: 200,
    body: {
      score: scoreData.score,
      tier: scoreData.tier,
      factors: {
        repayment_history: Number(scoreData.f_repayment_history),
        loan_volume: Number(scoreData.f_loan_volume),
        account_age: Number(scoreData.f_account_age),
        collateral_diversity: Number(scoreData.f_collateral_diversity),
        liquidation_ratio: Number(scoreData.f_liquidation_ratio),
        protocol_engagement: Number(scoreData.f_protocol_engagement),
      },
      tier_benefits: {
        max_ltv: Number(scoreData.max_ltv),
        fee_rate: Number(scoreData.fee_rate),
        max_duration_days: scoreData.max_duration_days,
      },
      loans_scored: scoreData.loans_scored,
      updated_at: scoreData.updated_at,
    },
  };
}

async function handleCreditHistory(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  }

  const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
  const wUserId = await resolveWalletOwner(wallet);
  if (!wUserId) return { status: 404, body: { error: "Wallet not found" } };
  const w = { user_id: wUserId };

  const { getScoreHistory } = await import("../services/credit-score.js");
  const history = await getScoreHistory(w.user_id, 50);

  return {
    status: 200,
    body: { wallet, history: history.map(h => ({ score: h.score, tier: h.tier, timestamp: h.snapshot_at })) },
  };
}

/**
 * /api/v1/transparency — public aggregated protocol stats.
 *
 * Designed for the transparency page on magpie.capital and any third-party
 * tracker that wants to verify Magpie's health claims. No PII, no auth.
 *
 * Returns:
 *   - lifetime + 24h + 7d + 30d aggregates for loans, fees, users
 *   - default rate (liquidated / total) — currently 0, the marketing point
 *   - pool TVL + utilization
 *   - holder reward pool current size + last distribution
 *   - LP loyalty pool current size + last distribution
 *   - referral payouts (lifetime)
 */
async function handleTransparency() {
  // Loans aggregate
  const { rows: [loans] } = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'repaid')::int AS repaid,
       COUNT(*) FILTER (WHERE status = 'liquidated')::int AS liquidated,
       COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '24 hours')::int AS new_24h,
       COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '7 days')::int  AS new_7d,
       COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '30 days')::int AS new_30d,
       COALESCE(SUM(loan_amount_lamports::numeric), 0)::text AS lifetime_borrowed_lamports,
       COALESCE(SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '24 hours'
                         THEN loan_amount_lamports::numeric ELSE 0 END), 0)::text
         AS borrowed_24h_lamports
     FROM loans`,
  );
  // Users aggregate
  const { rows: [users] } = await query(
    `SELECT
       COUNT(*)::int AS total_users,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new_users_24h,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int  AS new_users_7d
     FROM users`,
  );
  // Pool snapshot (on-chain)
  let pool = null;
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { getReadOnlyProgram } = await import("../solana/program.js");
    const { lendingPoolPda } = await import("../solana/pdas.js");
    const [poolPda] = lendingPoolPda(new PublicKey(process.env.LENDER_PUBKEY));
    const p = await getReadOnlyProgram().account.lendingPool.fetch(poolPda);
    const td = Number(p.totalDeposits);
    const tb = Number(p.totalBorrowed);
    pool = {
      tvl_sol: td / 1e9,
      borrowed_sol: tb / 1e9,
      available_sol: Math.max(0, td - tb) / 1e9,
      utilization_pct: td > 0 ? +((tb / td) * 100).toFixed(2) : 0,
      total_fees_earned_sol: Number(p.totalFeesEarned) / 1e9,
      paused: p.paused,
    };
  } catch { /* fall through */ }
  // Holder reward pool
  const { rows: [holders] } = await query(
    `SELECT
       (SELECT accrued_lamports::text FROM magpie_holder_pool WHERE id = 1) AS current_pool_lamports,
       (SELECT COUNT(*)::int FROM magpie_holder_distributions) AS lifetime_distributions,
       (SELECT total_distributed_lamports::text FROM magpie_holder_distributions
          ORDER BY id DESC LIMIT 1) AS last_distribution_lamports,
       (SELECT created_at FROM magpie_holder_distributions ORDER BY id DESC LIMIT 1)
         AS last_distribution_at`,
  );
  // LP loyalty pool
  const { rows: [lpLoy] } = await query(
    `SELECT
       (SELECT accrued_lamports::text FROM lp_loyalty_pool WHERE id = 1) AS current_pool_lamports,
       (SELECT COUNT(*)::int FROM lp_loyalty_distributions) AS lifetime_distributions`,
  );
  // Referral payouts lifetime
  const { rows: [refs] } = await query(
    `SELECT
       COALESCE(SUM(reward_lamports)::text, '0') AS lifetime_accrued,
       COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports ELSE 0 END)::text, '0')
         AS lifetime_paid
     FROM referral_earnings`,
  );
  // Default rate — % of finalized loans that were liquidated (NOT active)
  const finalized = loans.repaid + loans.liquidated;
  const defaultRatePct = finalized > 0 ? +((loans.liquidated / finalized) * 100).toFixed(3) : 0;

  return {
    status: 200,
    body: {
      // Top-line trust signals
      headline: {
        liquidations_lifetime: loans.liquidated,
        default_rate_pct: defaultRatePct,
        users: users.total_users,
        loans_lifetime: loans.total,
        tvl_sol: pool?.tvl_sol ?? null,
      },
      loans: {
        ...loans,
        lifetime_borrowed_sol: Number(loans.lifetime_borrowed_lamports) / 1e9,
        borrowed_24h_sol: Number(loans.borrowed_24h_lamports) / 1e9,
      },
      users,
      pool,
      holder_rewards: {
        // current_pool_sol is OPERATOR-PRIVATE. Exposing it would let
        // mercenary holders front-run snapshots. Only historical
        // distributions are public (chain shows them anyway).
        lifetime_distributions: holders.lifetime_distributions,
        last_distribution_sol: holders.last_distribution_lamports
          ? Number(holders.last_distribution_lamports) / 1e9 : null,
        last_distribution_at: holders.last_distribution_at,
      },
      lp_loyalty: {
        // current_pool_sol is OPERATOR-PRIVATE (same reason as
        // holder_rewards above). Only historical distribution count
        // is public.
        lifetime_distributions: lpLoy.lifetime_distributions,
      },
      referrals: {
        lifetime_accrued_sol: Number(refs.lifetime_accrued) / 1e9,
        lifetime_paid_sol: Number(refs.lifetime_paid) / 1e9,
      },
      generated_at: new Date().toISOString(),
      cache_ttl_seconds: 60,
    },
  };
}

async function handleTokenRisk(req, url) {
  const mint = url.searchParams.get("mint");
  if (!mint) {
    return { status: 400, body: { error: "Provide ?mint=<address>" } };
  }

  const { getTokenRisk } = await import("../services/risk-engine.js");
  const profile = await getTokenRisk(mint);
  if (!profile) {
    return { status: 404, body: { error: "No risk profile for this token" } };
  }

  return {
    status: 200,
    body: {
      mint: profile.mint,
      symbol: profile.symbol,
      risk_score: Number(profile.risk_score),
      dimensions: {
        volatility: Number(profile.volatility_score),
        liquidity: Number(profile.liquidity_score),
        concentration: Number(profile.concentration_score),
        volume: Number(profile.volume_score),
        rug_pull: Number(profile.rug_pull_score),
      },
      market_data: {
        liquidity_usd: Number(profile.liquidity_usd),
        volume_24h_usd: Number(profile.volume_24h_usd),
        market_cap_usd: Number(profile.market_cap_usd),
      },
      lending_impact: {
        ltv_modifier: Number(profile.ltv_modifier),
        max_allowed_ltv: Number(profile.max_allowed_ltv),
      },
      flagged: profile.flagged,
      flag_reason: profile.flag_reason,
      updated_at: profile.updated_at,
    },
  };
}

async function handleFlaggedTokens() {
  const { getFlaggedTokens } = await import("../services/risk-engine.js");
  const tokens = await getFlaggedTokens();
  return { status: 200, body: { flagged: tokens } };
}

async function handleTokens() {
  const { rows } = await query(
    `SELECT mint, symbol, name, decimals, category, image_url, enabled, created_at
     FROM supported_mints
     WHERE enabled = TRUE
     ORDER BY created_at ASC`,
  );
  return {
    status: 200,
    body: {
      count: rows.length,
      tokens: rows.map((t) => ({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        category: t.category || "memecoin",
        image: t.image_url || null,
      })),
    },
  };
}

async function handleLoans(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  }

  const { resolveWalletOwner: resolveOwner3 } = await import("../services/wallet-owner-resolver.js");
  const wUserId2 = await resolveOwner3(wallet);
  if (!wUserId2) {
    // Unknown wallet — return empty (not an error: dashboard may render zero state)
    return { status: 200, body: { wallet, active: [], history: [] } };
  }
  const w = { user_id: wUserId2 };

  const { rows: allUserRows } = await query(
    `SELECT l.id, l.loan_id, l.loan_pda, l.collateral_mint, l.collateral_amount,
            l.loan_amount_lamports, l.original_loan_amount_lamports,
            l.actual_received_lamports,
            l.ltv_percentage, l.duration_days,
            l.start_timestamp, l.due_timestamp,
            l.status, l.tx_signature, l.updated_at, l.program_id,
            sm.symbol, sm.name, sm.decimals, sm.image_url, sm.category
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE l.user_id = $1
      ORDER BY l.start_timestamp DESC
      LIMIT 100`,
    [w.user_id],
  );

  // Scope to JUST the requesting wallet's loans. Multi-wallet users
  // had loans from sibling wallets bleeding through because the query
  // was scoped to user_id. Now we filter to those whose on-chain PDA
  // matches what would be derived if `wallet` were the borrower.
  // Credit / points / holder rewards remain shared across wallets
  // (intentional) — only loan + collateral display is per-wallet.
  let rows;
  try {
    const { filterLoansForWallet } = await import("../services/wallet-scoped-loans.js");
    rows = filterLoansForWallet(allUserRows, wallet);
  } catch (err) {
    console.warn("[handleLoans] wallet-scope filter failed; returning user-wide:", err.message);
    rows = allUserRows;
  }

  const shape = (l, healthRatio) => ({
    loan_id: l.loan_id?.toString?.() ?? null,
    loan_pda: l.loan_pda,
    status: l.status,
    health_ratio: healthRatio,
    collateral: {
      mint: l.collateral_mint,
      symbol: l.symbol,
      name: l.name,
      decimals: l.decimals,
      image: l.image_url || null,
      category: l.category || "memecoin",
      amount: l.collateral_amount?.toString?.() ?? null,
    },
    loan: {
      // Legacy field (kept for back-compat with existing site code):
      // post-protocol-fee value. Does NOT subtract Solana account-
      // creation rent.
      amount_lamports: l.loan_amount_lamports?.toString?.() ?? null,
      // The borrower's TRUE on-chain SOL credit on the borrow tx.
      // Subtracts protocol fee AND Solana account-creation rent
      // (collateral vault ATA + borrower wSOL ATA). Render THIS in
      // user-facing "you received" UI — it matches what the user
      // sees in their wallet.
      actual_received_lamports: l.actual_received_lamports?.toString?.() ?? null,
      original_amount_lamports: l.original_loan_amount_lamports?.toString?.() ?? null,
      ltv_percentage: l.ltv_percentage,
      duration_days: l.duration_days,
    },
    timestamps: {
      started_at: l.start_timestamp,
      due_at: l.due_timestamp,
      updated_at: l.updated_at,
    },
    tx_signature: l.tx_signature,
  });

  // Compute live health_ratio for ACTIVE loans only (history doesn't need it).
  // Bounded parallelism via Promise.all; helpers fail-soft to null.
  // Health = collateral_value_in_lamports / owed_lamports.
  const activeRows = rows.filter((r) => r.status === "active");
  const historyRows = rows.filter((r) => r.status !== "active");
  let healthByLoanId = new Map();
  try {
    const { getLiveOwedLamports } = await import("../services/loans.js");
    const { collateralValueLamports } = await import("../services/price.js");
    const results = await Promise.all(activeRows.map(async (r) => {
      try {
        const owed = await getLiveOwedLamports(r).catch(() => BigInt(r.original_loan_amount_lamports ?? "0"));
        if (!owed || owed <= 0n) return [r.loan_id, null];
        if (r.decimals == null) return [r.loan_id, null];
        const cVal = await collateralValueLamports(r.collateral_mint, r.collateral_amount, r.decimals);
        if (!cVal || cVal <= 0n) return [r.loan_id, null];
        const ratio = Number(cVal) / Number(owed);
        return [r.loan_id, Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : null];
      } catch {
        return [r.loan_id, null];
      }
    }));
    healthByLoanId = new Map(results);
  } catch (err) {
    console.warn("[loans] health enrich failed:", err.message);
  }

  return {
    status: 200,
    body: {
      wallet,
      active: activeRows.map((r) => shape(r, healthByLoanId.get(r.loan_id) ?? null)),
      history: historyRows.map((r) => shape(r, null)),
    },
  };
}

async function handleWalletBalance(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  }

  const { PublicKey } = await import("@solana/web3.js");
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
  const { connection } = await import("../solana/connection.js");

  let walletPk;
  try {
    walletPk = new PublicKey(wallet);
  } catch {
    return { status: 400, body: { error: "Invalid wallet address" } };
  }

  // SOL balance + supported-token balances (both legacy SPL and Token-2022).
  const [solLamports, legacyAccounts, t22Accounts] = await Promise.all([
    connection.getBalance(walletPk).catch(() => 0),
    connection.getParsedTokenAccountsByOwner(walletPk, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] })),
    connection.getParsedTokenAccountsByOwner(walletPk, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] })),
  ]);

  const allAccts = [...legacyAccounts.value, ...t22Accounts.value];
  const byMint = new Map();
  for (const acc of allAccts) {
    const info = acc.account.data?.parsed?.info;
    if (!info?.mint || !info?.tokenAmount) continue;
    const amount = info.tokenAmount.uiAmount;
    if (!amount || amount <= 0) continue;
    byMint.set(info.mint, {
      mint: info.mint,
      raw_amount: info.tokenAmount.amount,
      decimals: info.tokenAmount.decimals,
      amount: amount,
    });
  }

  // Enrich with symbol/name/category from supported_mints for tokens we recognize.
  const mints = [...byMint.keys()];
  if (mints.length > 0) {
    const { rows } = await query(
      `SELECT mint, symbol, name, image_url, category
         FROM supported_mints
        WHERE mint = ANY($1)`,
      [mints],
    );
    for (const r of rows) {
      const t = byMint.get(r.mint);
      if (!t) continue;
      t.symbol = r.symbol;
      t.name = r.name;
      t.image = r.image_url || null;
      t.category = r.category || "memecoin";
      t.borrowable = true;
    }
  }

  // For mints we still don't know (not in supported_mints), look up the
  // real ticker/name via DexScreener so the dashboard doesn't display a
  // 4-char prefix of the mint pubkey. Batched (up to 30 mints per call).
  const unknownMints = [...byMint.values()].filter((t) => !t.symbol).map((t) => t.mint);
  if (unknownMints.length > 0) {
    try {
      const BATCH = 30;
      for (let i = 0; i < unknownMints.length; i += BATCH) {
        const batch = unknownMints.slice(i, i + BATCH);
        const res = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`,
          { signal: AbortSignal.timeout(8_000) },
        );
        if (!res.ok) continue;
        const pairs = await res.json();
        if (!Array.isArray(pairs)) continue;

        // Multiple pairs per token possible — keep the one with the highest liquidity.
        const bestByMint = new Map();
        for (const p of pairs) {
          const addr = p?.baseToken?.address;
          if (!addr || !byMint.has(addr)) continue;
          const liq = p?.liquidity?.usd ?? 0;
          const existing = bestByMint.get(addr);
          if (!existing || liq > (existing.liquidity?.usd ?? 0)) {
            bestByMint.set(addr, p);
          }
        }
        for (const [addr, p] of bestByMint) {
          const t = byMint.get(addr);
          if (!t) continue;
          t.symbol = p.baseToken?.symbol || t.symbol;
          t.name = p.baseToken?.name || p.baseToken?.symbol || t.name;
          t.image = p.info?.imageUrl || t.image || null;
          t.borrowable = false; // not in supported_mints
        }
      }
    } catch (err) {
      console.warn("[api] DexScreener lookup failed:", err.message);
    }
  }

  return {
    status: 200,
    body: {
      wallet,
      sol: {
        lamports: solLamports.toString(),
        amount: solLamports / 1e9,
      },
      tokens: [...byMint.values()],
    },
  };
}

async function handlePublicPoolStats() {
  // Public LP-relevant pool stats: TVL, utilization, fee periods, recent
  // fee events. No auth required — everything here is derivable from
  // on-chain state anyway. Used by the /earn page to show APR estimates
  // and recent yield activity.
  const { PublicKey } = await import("@solana/web3.js");
  const { getReadOnlyProgram } = await import("../solana/program.js");
  const { lendingPoolPda } = await import("../solana/pdas.js");

  let poolState = null;
  try {
    const [poolPda] = lendingPoolPda(new PublicKey(process.env.LENDER_PUBKEY));
    const p = await getReadOnlyProgram().account.lendingPool.fetch(poolPda);
    const totalDeposits = Number(p.totalDeposits);
    const totalBorrowed = Number(p.totalBorrowed);
    poolState = {
      pool_pda: poolPda.toBase58(),
      protocol_fee_bps: Number(p.protocolFeeBps),
      lp_fee_share_bps: 10_000 - Number(p.protocolFeeBps),
      total_deposits_sol: totalDeposits / 1e9,
      total_borrowed_sol: totalBorrowed / 1e9,
      total_shares: p.totalShares.toString(),
      available_liquidity_sol: Math.max(0, totalDeposits - totalBorrowed) / 1e9,
      utilization: totalDeposits > 0 ? totalBorrowed / totalDeposits : 0,
      total_fees_earned_sol: Number(p.totalFeesEarned) / 1e9,
      total_loans_issued: p.totalLoansIssued.toString(),
      // On-chain liquidation counter. Was missing from this endpoint,
      // which caused the landing page to silently default to 0 even
      // when /stats (DB-derived) correctly showed 1. Source of truth
      // is the on-chain pool counter — DB count from loans.status
      // should agree but the pool counter wins on disagreement.
      total_liquidations: p.totalLiquidations?.toString?.() ?? "0",
      paused: p.paused,
    };
  } catch { /* fall through */ }

  // Period-fee buckets (gross, before 80/20 split). LP receives lp_fee_share
  // of these. SUM(numeric × bps / 10000) gives the originated fee.
  const { rows: [periods] } = await query(
    `SELECT
       SUM(CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                ELSE original_loan_amount_lamports::numeric * 150 / 10000 END)::text AS lifetime,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '24 hours' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS d24h,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '7 days' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS d7d,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '30 days' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS d30d
       FROM loans`,
  );

  // Recent loans by start time — used for the "recent yield activity" stream.
  const { rows: recentLoans } = await query(
    `SELECT l.id, l.status,
            l.original_loan_amount_lamports::text AS amount_lamports,
            l.ltv_percentage, l.start_timestamp, l.updated_at,
            sm.symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      ORDER BY GREATEST(l.start_timestamp, l.updated_at) DESC
      LIMIT 8`,
  );

  return {
    status: 200,
    body: {
      pool: poolState,
      fees: {
        lifetime_lamports: periods?.lifetime || "0",
        last_24h_lamports: periods?.d24h || "0",
        last_7d_lamports: periods?.d7d || "0",
        last_30d_lamports: periods?.d30d || "0",
      },
      recent_loans: recentLoans.map((r) => {
        const feeBps = r.ltv_percentage >= 30 ? 300 : r.ltv_percentage >= 25 ? 200 : 150;
        const feeLamports = Math.floor(Number(r.amount_lamports) * feeBps / 10_000);
        return {
          symbol: r.symbol,
          status: r.status,
          loan_amount_lamports: r.amount_lamports,
          fee_lamports: feeLamports.toString(),
          timestamp: r.status === "active" ? r.start_timestamp : r.updated_at,
          event: r.status === "active" ? "borrow" : r.status === "repaid" ? "repay" : "liquidation",
        };
      }),
      generated_at: new Date().toISOString(),
    },
  };
}

async function handleAdminPoolStats(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "Provide ?wallet=<address>" } };
  }

  // Gate: only the configured creator/lender wallet can see this view.
  // Anyone querying with a different wallet gets a 403, not a 404, so we
  // don't leak existence of the endpoint.
  const LENDER_PUBKEY = process.env.LENDER_PUBKEY;
  if (!LENDER_PUBKEY || wallet !== LENDER_PUBKEY) {
    return { status: 403, body: { error: "Forbidden — not the protocol creator wallet" } };
  }

  const { PublicKey } = await import("@solana/web3.js");
  const { getReadOnlyProgram } = await import("../solana/program.js");
  const { lendingPoolPda } = await import("../solana/pdas.js");

  // ── 1. On-chain pool state ──
  let poolState = null;
  let poolPda = null;
  try {
    const lender = new PublicKey(LENDER_PUBKEY);
    [poolPda] = lendingPoolPda(lender);
    const program = getReadOnlyProgram();
    const p = await program.account.lendingPool.fetch(poolPda);
    const totalFeesEarnedLamports = Number(p.totalFeesEarned);
    const protocolBps = Number(p.protocolFeeBps);
    poolState = {
      pool_pda: poolPda.toBase58(),
      authority: p.authority.toBase58(),
      loan_token_mint: p.loanTokenMint.toBase58(),
      protocol_fee_bps: protocolBps,
      keeper_reward_bps: Number(p.keeperRewardBps),
      total_deposits_lamports: p.totalDeposits?.toString?.() ?? "0",
      total_deposits_sol: Number(p.totalDeposits) / 1e9,
      total_borrowed_lamports: p.totalBorrowed?.toString?.() ?? "0",
      total_borrowed_sol: Number(p.totalBorrowed) / 1e9,
      total_fees_earned_lamports: totalFeesEarnedLamports.toString(),
      total_fees_earned_sol: totalFeesEarnedLamports / 1e9,
      // Split into protocol cut (sent to fee wallet) vs LP cut (stays in pool)
      protocol_fee_share_sol: (totalFeesEarnedLamports * protocolBps) / 10_000 / 1e9,
      lp_fee_share_sol: (totalFeesEarnedLamports * (10_000 - protocolBps)) / 10_000 / 1e9,
      total_loans_issued: p.totalLoansIssued?.toString?.() ?? "0",
      total_liquidations: p.totalLiquidations?.toString?.() ?? "0",
      total_shares: p.totalShares?.toString?.() ?? "0",
      paused: p.paused,
    };
  } catch (err) {
    console.error("[admin] pool fetch failed:", err.message);
  }

  // ── 2. Loan aggregates from DB ──
  const { rows: byStatus } = await query(
    `SELECT status,
            COUNT(*)::int AS n,
            COALESCE(SUM(original_loan_amount_lamports::numeric), 0)::text AS total_lamports
       FROM loans
      GROUP BY status`,
  );
  const loanCounts = { active: 0, repaid: 0, liquidated: 0 };
  const loanVolume = { active: "0", repaid: "0", liquidated: "0" };
  for (const r of byStatus) {
    loanCounts[r.status] = r.n;
    loanVolume[r.status] = r.total_lamports;
  }
  const totalIssued = loanCounts.active + loanCounts.repaid + loanCounts.liquidated;
  const defaultRate = totalIssued > 0 ? loanCounts.liquidated / totalIssued : 0;

  // ── 3. Fee earnings by time window (from credit_events / DB) ──
  // Approximation: each repaid loan contributed its original_loan_amount × tier_fee_bps
  // to fees. Easier: use the on-chain total_fees_earned, then derive by-period
  // from loans repaid in that window weighted by tier.
  const { rows: feesByPeriod } = await query(
    `SELECT
       SUM(CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                ELSE original_loan_amount_lamports::numeric * 150 / 10000 END)::text AS lifetime,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '24 hours' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS last_24h,
       SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '7 days' THEN
            CASE WHEN ltv_percentage >= 30 THEN original_loan_amount_lamports::numeric * 300 / 10000
                 WHEN ltv_percentage >= 25 THEN original_loan_amount_lamports::numeric * 200 / 10000
                 ELSE original_loan_amount_lamports::numeric * 150 / 10000 END
          ELSE 0 END)::text AS last_7d
       FROM loans`,
  );
  const fees = feesByPeriod[0] || { lifetime: "0", last_24h: "0", last_7d: "0" };

  // ── 4. Top collateral mints by loan count ──
  const { rows: topMints } = await query(
    `SELECT l.collateral_mint, sm.symbol, sm.name,
            COUNT(*)::int AS loans,
            COALESCE(SUM(l.original_loan_amount_lamports::numeric), 0)::text AS volume_lamports
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      GROUP BY l.collateral_mint, sm.symbol, sm.name
      ORDER BY loans DESC
      LIMIT 10`,
  );

  // ── 5. User counts ──
  const { rows: [userStats] } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS total_users,
       (SELECT COUNT(DISTINCT user_id)::int FROM loans) AS borrowers,
       (SELECT COUNT(DISTINCT user_id)::int FROM loans WHERE status = 'active') AS active_borrowers`,
  );

  // ── 6. Supported tokens count ──
  const { rows: [tokenStats] } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM supported_mints WHERE enabled = TRUE) AS enabled_mints,
       (SELECT COUNT(*)::int FROM token_screen_queue WHERE status = 'pending') AS pending_review`,
  );

  // ── 7. Recent loans (last 10) ──
  const { rows: recentLoans } = await query(
    `SELECT l.id, l.status,
            l.collateral_mint, sm.symbol,
            l.original_loan_amount_lamports::text AS amount,
            l.ltv_percentage, l.duration_days,
            l.start_timestamp, l.updated_at, l.tx_signature
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      ORDER BY l.start_timestamp DESC
      LIMIT 10`,
  );

  // Pool utilization = borrowed / deposited
  const utilization = poolState && poolState.total_deposits_sol > 0
    ? poolState.total_borrowed_sol / poolState.total_deposits_sol
    : 0;

  return {
    status: 200,
    body: {
      pool: poolState,
      loans: {
        counts: loanCounts,
        volume_lamports: loanVolume,
        total_issued: totalIssued,
        default_rate: defaultRate,
        recent: recentLoans,
      },
      fees: {
        // gross fees (before 80/20 split)
        lifetime_lamports: fees.lifetime || "0",
        last_24h_lamports: fees.last_24h || "0",
        last_7d_lamports: fees.last_7d || "0",
        // protocol cut (what's in the fee wallet, sent to authority's wSOL ATA)
        protocol_share_bps: poolState?.protocol_fee_bps ?? 2000,
        lp_share_bps: 10000 - (poolState?.protocol_fee_bps ?? 2000),
      },
      top_collateral_mints: topMints,
      users: userStats,
      tokens: tokenStats,
      pool_utilization: utilization,
      generated_at: new Date().toISOString(),
    },
  };
}

// ─── Admin lifetime stats — cached 1h ───
// Returns the full earnings/distribution picture per stakeholder so the
// operator can see lifetime numbers without asking the bot operator's
// engineer. Auth: same wallet-gate as handleAdminPoolStats.
//
// Cache: 1-hour in-memory. First request after expiry computes fresh and
// caches; subsequent requests within the hour return the cached snapshot.
// Acceptable trade-off because the underlying data only meaningfully
// changes when loans are taken/repaid (low single-digit per hour at
// current volume).
let _lifetimeStatsCache = null;
let _lifetimeStatsCachedAt = 0;
const LIFETIME_STATS_TTL_MS = 60 * 60 * 1000; // 1 hour

async function computeLifetimeStats() {
  const { PublicKey } = await import("@solana/web3.js");
  const { getReadOnlyProgram } = await import("../solana/program.js");
  const { lendingPoolPda } = await import("../solana/pdas.js");

  const LENDER_PUBKEY = process.env.LENDER_PUBKEY;
  const lender = new PublicKey(LENDER_PUBKEY);
  const [poolPda] = lendingPoolPda(lender);
  const program = getReadOnlyProgram();
  const p = await program.account.lendingPool.fetch(poolPda);

  // On-chain pool — canonical source for fees + deposits + utilization
  const totalFees = BigInt(p.totalFeesEarned.toString());
  const totalDeposits = BigInt(p.totalDeposits.toString());
  const totalBorrowed = BigInt(p.totalBorrowed.toString());
  const split = {
    lp_yield_lamports:        (totalFees * 80n / 100n).toString(),
    magpie_holders_lamports:  (totalFees * 10n / 100n).toString(),
    referrers_lamports:       (totalFees *  5n / 100n).toString(),
    lp_loyalty_lamports:      (totalFees *  2n / 100n).toString(),
    protocol_treasury_lamports: (totalFees * 3n / 100n).toString(),
  };

  // DB pulls
  const [
    { rows: [loans] },
    { rows: [refs] },
    { rows: [holderDist] },
    { rows: [holderRewards] },
    { rows: [holderPool] },
    { rows: [loyaltyDist] },
    { rows: [loyaltyPool] },
    { rows: [loyaltyRewards] },
    { rows: [users] },
  ] = await Promise.all([
    query(`SELECT
              COUNT(*)::int                                                  AS total,
              COUNT(*) FILTER (WHERE status='active')::int                   AS active,
              COUNT(*) FILTER (WHERE status='repaid')::int                   AS repaid,
              COUNT(*) FILTER (WHERE status='liquidated')::int               AS liquidated,
              COUNT(DISTINCT user_id)::int                                   AS unique_borrowers,
              COALESCE(SUM(loan_amount_lamports::numeric), 0)::text          AS volume_lamports
            FROM loans`),
    query(`SELECT
              COUNT(*)::int                                                                                  AS events,
              COUNT(DISTINCT referrer_user_id)::int                                                          AS unique_referrers,
              COALESCE(SUM(reward_lamports::numeric), 0)::text                                               AS accrued_lamports,
              COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports::numeric ELSE 0 END), 0)::text       AS paid_lamports,
              COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports::numeric ELSE 0 END), 0)::text    AS pending_lamports
            FROM referral_earnings`),
    query(`SELECT COUNT(*)::int AS count,
                  COALESCE(SUM(pool_lamports::numeric), 0)::text AS total_distributed_lamports
            FROM magpie_holder_distributions`),
    query(`SELECT
              COUNT(*) FILTER (WHERE status='paid')::int                                                     AS paid_count,
              COUNT(*) FILTER (WHERE status='accrued')::int                                                  AS pending_count,
              COUNT(DISTINCT wallet_address)::int                                                            AS unique_recipients,
              COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports::numeric ELSE 0 END), 0)::text       AS paid_lamports,
              COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports::numeric ELSE 0 END), 0)::text    AS pending_lamports
            FROM magpie_holder_rewards`),
    query(`SELECT accrued_lamports::text AS accrued_lamports, next_distribution_at
            FROM magpie_holder_pool WHERE id=1`),
    query(`SELECT COUNT(*)::int AS count,
                  COALESCE(SUM(pool_lamports::numeric), 0)::text AS total_distributed_lamports
            FROM lp_loyalty_distributions`),
    query(`SELECT accrued_lamports::text AS accrued_lamports FROM lp_loyalty_pool WHERE id=1`),
    query(`SELECT
              COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports::numeric ELSE 0 END), 0)::text       AS paid_lamports,
              COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports::numeric ELSE 0 END), 0)::text    AS pending_lamports
            FROM lp_loyalty_rewards`),
    query(`SELECT
              COUNT(*)::int                                                                  AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int          AS new_24h,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int            AS new_7d,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int           AS new_30d
            FROM users`),
  ]);

  return {
    generated_at: new Date().toISOString(),
    pool: {
      pda: poolPda.toBase58(),
      total_deposits_lamports: totalDeposits.toString(),
      total_borrowed_lamports: totalBorrowed.toString(),
      utilization_pct: totalDeposits > 0n
        ? Number((totalBorrowed * 10000n / totalDeposits)) / 100
        : 0,
      total_loans_issued: Number(p.totalLoansIssued),
      total_liquidations: Number(p.totalLiquidations),
      total_fees_earned_lamports: totalFees.toString(),
      paused: p.paused,
    },
    fee_split: split,
    loans: {
      total: loans.total,
      active: loans.active,
      repaid: loans.repaid,
      liquidated: loans.liquidated,
      unique_borrowers: loans.unique_borrowers,
      lifetime_volume_lamports: loans.volume_lamports,
    },
    referrals: {
      reward_events: refs.events,
      unique_referrers_paid: refs.unique_referrers,
      lifetime_accrued_lamports: refs.accrued_lamports,
      paid_lamports: refs.paid_lamports,
      pending_claim_lamports: refs.pending_lamports,
    },
    magpie_holders: {
      distributions_to_date: holderDist.count,
      total_distributed_lamports: holderDist.total_distributed_lamports,
      paid_count: holderRewards.paid_count,
      pending_count: holderRewards.pending_count,
      unique_recipients: holderRewards.unique_recipients,
      paid_lamports: holderRewards.paid_lamports,
      pending_lamports: holderRewards.pending_lamports,
      accrued_lamports: holderPool.accrued_lamports,
      // next_distribution_at is operator-internal per the standing rule on
      // randomized-cadence snapshots — exact firing time is unguessable on
      // purpose. Not surfaced in admin responses.
    },
    lp_loyalty: {
      distributions_to_date: loyaltyDist.count,
      total_distributed_lamports: loyaltyDist.total_distributed_lamports,
      paid_lamports: loyaltyRewards.paid_lamports,
      pending_lamports: loyaltyRewards.pending_lamports,
      accrued_lamports: loyaltyPool.accrued_lamports,
    },
    users: {
      total: users.total,
      new_24h: users.new_24h,
      new_7d: users.new_7d,
      new_30d: users.new_30d,
    },
  };
}

async function handleAdminLifetimeStats(req, url) {
  const wallet = url.searchParams.get("wallet");
  const LENDER_PUBKEY = process.env.LENDER_PUBKEY;
  if (!LENDER_PUBKEY || wallet !== LENDER_PUBKEY) {
    return { status: 403, body: { error: "Forbidden — not the protocol creator wallet" } };
  }

  const now = Date.now();
  const ageMs = now - _lifetimeStatsCachedAt;
  if (_lifetimeStatsCache && ageMs < LIFETIME_STATS_TTL_MS) {
    return {
      status: 200,
      body: { ..._lifetimeStatsCache, cached_age_seconds: Math.floor(ageMs / 1000) },
    };
  }

  try {
    const fresh = await computeLifetimeStats();
    _lifetimeStatsCache = fresh;
    _lifetimeStatsCachedAt = now;
    return { status: 200, body: { ...fresh, cached_age_seconds: 0 } };
  } catch (err) {
    console.error("[admin/lifetime-stats] compute failed:", err.message);
    // Stale-on-error: if we have any cached data, return it rather than 500
    if (_lifetimeStatsCache) {
      return {
        status: 200,
        body: {
          ..._lifetimeStatsCache,
          cached_age_seconds: Math.floor(ageMs / 1000),
          warning: "Compute failed; returning stale cache. Check server logs.",
        },
      };
    }
    return { status: 500, body: { error: "Failed to compute stats", detail: err.message } };
  }
}

async function handleMarketplaceStats() {
  const { getMarketplaceStats } = await import("../services/p2p-marketplace.js");
  const stats = await getMarketplaceStats();
  return { status: 200, body: { stats } };
}

/**
 * GET /api/v1/public/activity
 *
 * Public, anonymized stream of recent protocol activity. Designed for
 * agents (and any third-party monitor) checking "is this protocol alive?"
 * without going through wallet-scoped views.
 *
 * Returns the last N (default 50, max 200) of: borrow / repay /
 * liquidate events. Each event's wallet is reduced to a
 * `Xxxx…Yyyy` short form — recognizable by its owner, useless for
 * profiling. No usernames, no Telegram, no PII.
 *
 * Cached upstream — implementation does fresh DB hits and lets the
 * CDN handle deduplication via Cache-Control.
 */
async function handlePublicActivity(_req, url) {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
  const short = (pk) => (pk && pk.length >= 8 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : null);

  const [
    { rows: borrows },
    { rows: closed },
  ] = await Promise.all([
    query(
      `SELECT l.loan_id, l.loan_amount_lamports::text AS amount, l.duration_days,
              l.ltv_percentage, l.start_timestamp AS at, l.borrower_wallet,
              sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.start_timestamp > NOW() - INTERVAL '7 days'
        ORDER BY l.start_timestamp DESC
        LIMIT $1`,
      [limit],
    ),
    query(
      `SELECT l.loan_id, l.original_loan_amount_lamports::text AS amount,
              l.status, l.updated_at AS at, l.borrower_wallet,
              sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.status IN ('repaid', 'liquidated')
          AND l.updated_at > NOW() - INTERVAL '7 days'
        ORDER BY l.updated_at DESC
        LIMIT $1`,
      [limit],
    ),
  ]);

  const events = [];
  for (const b of borrows) {
    events.push({
      type: "borrow",
      at: b.at,
      borrower_short: short(b.borrower_wallet),
      amount_sol: Number(b.amount) / 1e9,
      collateral_symbol: b.symbol || null,
      ltv_pct: b.ltv_percentage,
      duration_days: b.duration_days,
    });
  }
  for (const c of closed) {
    events.push({
      type: c.status, // "repaid" | "liquidated"
      at: c.at,
      borrower_short: short(c.borrower_wallet),
      amount_sol: Number(c.amount) / 1e9,
      collateral_symbol: c.symbol || null,
    });
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    status: 200,
    body: { events: events.slice(0, limit), count: Math.min(events.length, limit) },
  };
}

/**
 * GET /api/v1/public/protocol-pulse
 *
 * Pure aggregates over the last 24h. Lightweight, cheap to cache,
 * useful as a healthcheck-with-context for any monitor — "the protocol
 * had X borrows worth Y SOL in the last day, Z active loans right now."
 *
 * No per-wallet data emitted. No PII possible.
 */
async function handleProtocolPulse() {
  const { rows: [agg] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')::int AS active_loans,
       COUNT(DISTINCT borrower_wallet) FILTER (WHERE status = 'active')::int AS active_borrowers,
       COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '24 hours')::int AS borrows_24h,
       COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '1 hour')::int  AS borrows_1h,
       COALESCE(SUM(CASE WHEN start_timestamp > NOW() - INTERVAL '24 hours'
                          THEN loan_amount_lamports::numeric ELSE 0 END), 0)::text
         AS borrowed_24h_lamports,
       COUNT(*) FILTER (WHERE status = 'repaid' AND updated_at > NOW() - INTERVAL '24 hours')::int
         AS repays_24h,
       COUNT(*) FILTER (WHERE status = 'liquidated' AND updated_at > NOW() - INTERVAL '24 hours')::int
         AS liquidations_24h
     FROM loans`,
  );
  return {
    status: 200,
    body: {
      active_loans: agg.active_loans,
      active_borrowers: agg.active_borrowers,
      borrows_1h: agg.borrows_1h,
      borrows_24h: agg.borrows_24h,
      borrowed_24h_sol: Number(agg.borrowed_24h_lamports) / 1e9,
      repays_24h: agg.repays_24h,
      liquidations_24h: agg.liquidations_24h,
      generated_at: new Date().toISOString(),
    },
  };
}

async function handleLeaderboard() {
  const { getLeaderboard } = await import("../services/credit-score.js");
  const leaders = await getLeaderboard(20);
  return {
    status: 200,
    body: {
      leaderboard: leaders.map(l => ({
        score: l.score,
        tier: l.tier,
        loans_scored: l.loans_scored,
        // PRIVACY: never publish Telegram handles on the public
        // leaderboard. Display the user's currently-active wallet
        // pubkey, truncated to a short prefix+suffix — keeps the
        // competitive surface (people can recognize their own
        // entry, others can verify on-chain) without leaking TG
        // identities. Fall back to "anonymous" if for some reason
        // there's no wallet on file.
        username: l.public_key
          ? `${l.public_key.slice(0, 4)}…${l.public_key.slice(-4)}`
          : "anonymous",
      })),
    },
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = new Set([
  "/api/v1/health",
  "/api/v1/tokens",
  "/api/v1/loans",
  "/api/v1/wallet/balance",
  "/api/v1/loan-tiers",
  "/api/v1/credit/score",
  // Public leaderboard — no PII, just usernames (TG handles) + scores.
  "/api/v1/credit/leaderboard",
  // Public anonymized activity feed + protocol pulse — both designed
  // for agents and third-party monitors. No PII, anonymized wallet
  // short-forms only, pure aggregates on protocol-pulse.
  "/api/v1/public/activity",
  "/api/v1/public/protocol-pulse",
  // Live x402 revenue + adoption — pure aggregates over the
  // x402_paid_calls log. No payer pubkeys surfaced, only counts +
  // SOL totals + per-endpoint breakdown.
  "/api/v1/public/x402-metrics",
  // Internal record endpoint — auth is INTERNAL_API_TOKEN at the
  // handler level (same pattern as the agent endpoints), so we list
  // it as "public" at the API-key layer to bypass the API-key gate.
  "/api/v1/internal/x402/record",
  // Internal agent-limit-close arm/read/cancel — same INTERNAL_API_TOKEN
  // model. The x402 service is the only legitimate caller; it has
  // already verified the agent's x402 payment and proven (via the
  // payer pubkey on-chain) the agent_pubkey it forwards. We trust
  // the inbound agent_pubkey on this path BECAUSE the token gate
  // proves it came from the x402 service.
  "/api/v1/internal/agent/limit-close/arm",
  "/api/v1/internal/agent/limit-close/preflight",
  "/api/v1/internal/agent/limit-close/modify",
  "/api/v1/internal/agent/limit-close",
  "/api/v1/internal/agent/limit-close/list",
  "/api/v1/internal/agent/limit-close/delegations",
  "/api/v1/internal/agent/limit-close/eligible-loans",
  // Pre-borrow price refresh. Site calls this BEFORE buildBorrowTransaction
  // so the on-chain feed is fresh by the time the wallet simulates the
  // tx — closes the window where Phantom rejects with StalePriceAttestation
  // before the user can even sign.
  "/api/v1/price/refresh",
  // Site take-profit (limit-close) endpoints. GET is unsigned read-only;
  // POST + DELETE require an Ed25519-signed envelope. Security is
  // enforced internally by the handler (signature verification + linked
  // wallet check), so the API-key gate is bypassed.
  "/api/v1/site/limit-close",
  "/api/v1/site/limit-close/arm",
  "/api/v1/site/limit-close/modify",
  "/api/v1/site/limit-close/cancel",
  // Admin routes are "public" at the HTTP layer but gate internally on
  // wallet === LENDER_PUBKEY, so any non-creator caller gets a 403.
  "/api/v1/admin/pool-stats",
  "/api/v1/admin/lifetime-stats",
  "/api/v1/pool/stats",
  "/api/v1/referrals",
  "/api/v1/holders",
  "/api/v1/holders/pool",
  "/api/v1/lp-loyalty",
  // Transparency dashboard — aggregated protocol health, no PII.
  // Designed for public consumption (the transparency page on the site,
  // third-party trackers, etc.). No auth, cached for 60s upstream.
  "/api/v1/transparency",
  // Co-sign borrow — security is enforced INTERNALLY by the handler
  // (strict instruction-discriminator allowlist). The endpoint will only
  // sign request_and_fund_loan and rejects anything else. No API-key gate
  // because the site needs to call it from any user's browser; the
  // protection is in the handler's own validation, not the auth layer.
  "/api/v1/cosign-borrow",
  // Account linking endpoints — no API-key gate. Site needs to call from
  // any user's browser. Security is in the code's 15-min TTL + 5e14
  // keyspace + 5-codes-per-wallet throttle.
  "/api/v1/link/request",
  "/api/v1/link/status",
  // Site-initiated withdraw. Security is enforced INTERNALLY: Ed25519
  // signature from a linked wallet, one-shot nonce, freshness window,
  // destination = signer (unless MAGPIE_SITE_WITHDRAW_ANY_DEST=1).
  // See src/api/withdraw.js for the full gate list.
  "/api/v1/withdraw",
  // Support tickets viewer — METADATA ONLY by-wallet read. Message
  // bodies + admin replies are gated behind the signed
  // /api/v1/support/ticket-details endpoint so a public wallet pubkey
  // alone can't unlock the user's private messages.
  "/api/v1/support/tickets",
  // Signed read for a single ticket's full content.
  "/api/v1/support/ticket-details",
  // Signed delete for a single CLOSED ticket — privacy / data minimization.
  "/api/v1/support/delete-ticket",
  // Signed support actions (open ticket, follow up, close). Auth +
  // replay protection enforced inside the handler (see support-ask.js).
  "/api/v1/support/ask",
  // Wallets list (by-wallet read) and signed set-active.
  "/api/v1/wallets",
  "/api/v1/wallets/set-active",
  // User prefs (notifications, auto-protect). Read is wallet-keyed,
  // write is signed JSON.
  "/api/v1/prefs",
  "/api/v1/prefs/set",
  // Governance — wallet-signed vote submission + aggregate (counts
  // only) read. Per-wallet vote choices never published per the
  // v0 GOVERNANCE.md commitment.
  "/api/v1/governance/vote",
  "/api/v1/governance/votes",
  // Live aggregate WEIGHTS for the on-page live-results bar. Aggregate-
  // only; no per-wallet detail; no snapshot file publication. Server-
  // side cached 30s.
  "/api/v1/governance/tally",
  // Voting-power and distribution lookups — per-wallet eligibility +
  // expected SOL allocation. Public read; both surface info that's
  // either derivable from the public snapshot or specifically meant
  // to be visible to the wallet's owner on the dashboard.
  "/api/v1/governance/voting-power",
  "/api/v1/governance/distribution",
  "/api/v1/governance/distributions",
  // Unified activity feed (borrows, repays, auto-protect, withdraws,
  // referral payouts, holder rewards). Same risk envelope as /loans.
  "/api/v1/activity",
  // Ephemeral AI chat — signed message OR Bearer session token.
  "/api/v1/ai/chat",
  // Mint a Pip chat session — sign once, chat for 24h.
  "/api/v1/auth/pip-session",
  // Signed JSON dump of all of the user's data — privacy / GDPR.
  "/api/v1/me/export",
  // Dashboard aggregate — single-fetch primer for the linked-user dashboard.
  "/api/v1/dashboard",
  // Helius webhook for lender-wallet outflow alarms. NOT api-key gated
  // because Helius can't easily pass an x-api-key header. Auth is done
  // INSIDE the handler via a separate shared secret (Authorization
  // header, LENDER_ALARM_WEBHOOK_SECRET on Railway). The handler is
  // fail-closed: returns 503 if the env var isn't set.
  "/api/v1/lender-alarm-webhook",
  // Streaming variant of ai-chat. Same auth as /api/v1/ai/chat
  // (Bearer or signed Ed25519 inside the handler).
  "/api/v1/ai/chat/stream",
  // Post-tx sync hook. The site calls this right after a repay /
  // partial-repay / topup / extend lands so the bot's DB (which feeds
  // the activity feed, /stats lifetime totals, credit score, and
  // streak tracking) picks up the state change immediately instead of
  // waiting for the every-5-min loan-reconciler. The endpoint can
  // ONLY pull DB state toward on-chain truth — it cannot move funds
  // or write anything that isn't already true on-chain — so it's safe
  // to expose without auth.
  "/api/v1/sync-loan",
  // Live-debug ring buffer of recent console.error/warn output. No
  // PII; bounded in-memory; cleared on restart.
  "/api/v1/debug/recent-errors",
  // Backfill any wallet's on-chain loans into the DB. Public-safe —
  // can only pull DB toward on-chain truth; rate-limited per wallet
  // by the handler. Used by the dashboard on-connect to self-heal
  // any missing-loan drift.
  "/api/v1/wallet/backfill-loans",
]);

async function router(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "X-API-Key, Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Public site-status read: tells the dashboard whether signed
  // endpoints are globally disabled + any soft announcement.
  if (path === "/api/v1/site-status") {
    try {
      const { getGlobalSiteState } = await import("../services/site-global.js");
      const { getAnnouncement } = await import("../services/site-announcement.js");
      const [s, a] = await Promise.all([getGlobalSiteState(), getAnnouncement()]);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        disabled: s.disabled,
        reason: s.reason,
        set_at: s.set_at,
        announcement: a.message
          ? {
              message: a.message,
              severity: a.severity,
              expires_at: a.expires_at,
            }
          : null,
      }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ disabled: false, announcement: null }));
    }
  }

  // Health check (no auth) — real liveness probe
  if (path === "/api/v1/health") {
    const checks = { db: "unknown", screener: "unknown", "token-health": "unknown" };
    const reasons = [];
    const now = Date.now();
    const sinceStartup = now - getStartedAt();
    const inGrace = sinceStartup < STARTUP_GRACE_MS;

    // 1. DB ping — and if the guard has us in degraded mode, surface
    // that even when SELECT 1 happens to succeed in a brief window of
    // recovery. The guard's state is the authoritative "is the DB
    // layer healthy" signal.
    try {
      const { degradedSnapshot } = await import("../lib/db-quota-guard.js");
      const dbg = degradedSnapshot();
      if (dbg.degraded) {
        checks.db = "degraded";
        reasons.push(`db: ${dbg.reason ?? "degraded"} (since ${Math.round((dbg.ageMs ?? 0) / 1000)}s ago)`);
      } else {
        await query("SELECT 1");
        checks.db = "ok";
      }
    } catch (err) {
      checks.db = "fail";
      reasons.push(`db: ${err.message}`);
    }

    // 2. Service heartbeats — stale if no successful cycle in threshold,
    //    unless we're still in startup grace period.
    const hb = getHeartbeats();
    for (const [name, threshold] of Object.entries(STALE_MS)) {
      const entry = hb.services[name];
      if (!entry) {
        if (inGrace) {
          checks[name] = "warming-up";
        } else {
          checks[name] = "fail";
          reasons.push(`${name}: no cycle since startup`);
        }
        continue;
      }
      if (!entry.ok) {
        checks[name] = "fail";
        reasons.push(`${name}: last cycle errored`);
        continue;
      }
      if (entry.ageMs > threshold) {
        checks[name] = "stale";
        reasons.push(`${name}: ${Math.round(entry.ageMs / 60000)}m since last ok cycle`);
        continue;
      }
      checks[name] = "ok";
    }

    const failing = reasons.length > 0;
    res.writeHead(failing ? 503 : 200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: failing ? "degraded" : "ok",
      service: "magpie-credit-protocol",
      checks,
      reasons: failing ? reasons : undefined,
      uptimeMs: hb.uptimeMs,
      startedAt: hb.startedAt,
      heartbeats: hb.services,
    }));
  }

  // Per-IP rate limit for public routes — auth-gated routes use the
  // per-API-key limiter inside authenticateRequest() instead.
  if (PUBLIC_ROUTES.has(path)) {
    const clientIp = extractClientIp(req);
    if (!checkIpRateLimit(clientIp, PUBLIC_IP_LIMIT_RPM)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }
  } else {
    // Auth required for all other routes
    const auth = await authenticateRequest(req);
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid or missing API key" }));
    }
    if (auth.rateLimited) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }
  }

  let result;
  try {
    switch (path) {
      case "/api/v1/credit/score":
        result = await handleCreditScore(req, url);
        break;
      case "/api/v1/credit/history":
        result = await handleCreditHistory(req, url);
        break;
      case "/api/v1/credit/leaderboard":
        result = await handleLeaderboard();
        break;
      case "/api/v1/public/activity":
        result = await handlePublicActivity(req, url);
        break;
      case "/api/v1/public/protocol-pulse":
        result = await handleProtocolPulse();
        break;
      case "/api/v1/public/x402-metrics": {
        const { handleX402Metrics } = await import("./x402-metrics.js");
        result = await handleX402Metrics();
        break;
      }
      case "/api/v1/internal/x402/record": {
        const { handleX402Record } = await import("./x402-metrics.js");
        result = await handleX402Record(req);
        break;
      }
      case "/api/v1/internal/agent/limit-close/arm": {
        const { handleAgentLimitCloseArm } = await import("./internal-agent-limitclose.js");
        result = await handleAgentLimitCloseArm(req);
        break;
      }
      case "/api/v1/internal/agent/limit-close/preflight": {
        const { handleAgentLimitClosePreflight } = await import("./internal-agent-limitclose.js");
        result = await handleAgentLimitClosePreflight(req);
        break;
      }
      case "/api/v1/internal/agent/limit-close/modify": {
        const { handleAgentLimitCloseModify } = await import("./internal-agent-limitclose.js");
        result = await handleAgentLimitCloseModify(req);
        break;
      }
      case "/api/v1/internal/agent/limit-close/list": {
        const { handleAgentLimitCloseList } = await import("./internal-agent-limitclose.js");
        result = await handleAgentLimitCloseList(req, Object.fromEntries(url.searchParams));
        break;
      }
      case "/api/v1/internal/agent/limit-close/delegations": {
        const { handleAgentLimitCloseListDelegations } = await import("./internal-agent-limitclose.js");
        result = await handleAgentLimitCloseListDelegations(req, Object.fromEntries(url.searchParams));
        break;
      }
      case "/api/v1/internal/agent/limit-close/eligible-loans": {
        const { handleAgentLimitCloseEligibleLoans } = await import("./internal-agent-limitclose.js");
        result = await handleAgentLimitCloseEligibleLoans(req, Object.fromEntries(url.searchParams));
        break;
      }
      case "/api/v1/internal/agent/limit-close": {
        const m = await import("./internal-agent-limitclose.js");
        if (req.method === "DELETE") {
          result = await m.handleAgentLimitCloseDelete(req, Object.fromEntries(url.searchParams));
        } else {
          result = await m.handleAgentLimitCloseGet(req, Object.fromEntries(url.searchParams));
        }
        break;
      }
      case "/api/v1/price/refresh": {
        const { handlePriceRefresh } = await import("./price-refresh.js");
        result = await handlePriceRefresh(req);
        break;
      }
      case "/api/v1/site/limit-close": {
        const { handleSiteLimitCloseList } = await import("./site-limit-close.js");
        result = await handleSiteLimitCloseList(req, url);
        break;
      }
      case "/api/v1/site/limit-close/arm": {
        const { handleSiteLimitCloseArm } = await import("./site-limit-close.js");
        result = await handleSiteLimitCloseArm(req);
        break;
      }
      case "/api/v1/site/limit-close/cancel": {
        const { handleSiteLimitCloseCancel } = await import("./site-limit-close.js");
        result = await handleSiteLimitCloseCancel(req);
        break;
      }
      case "/api/v1/site/limit-close/modify": {
        const { handleSiteLimitCloseModify } = await import("./site-limit-close.js");
        result = await handleSiteLimitCloseModify(req);
        break;
      }
      case "/api/v1/tokens":
        result = await handleTokens();
        break;
      case "/api/v1/loan-tiers": {
        const { handleLoanTiers } = await import("./loan-tiers-api.js");
        result = await handleLoanTiers(req, url);
        break;
      }
      case "/api/v1/loans":
        result = await handleLoans(req, url);
        break;
      case "/api/v1/wallet/balance":
        result = await handleWalletBalance(req, url);
        break;
      case "/api/v1/admin/pool-stats":
        result = await handleAdminPoolStats(req, url);
        break;
      case "/api/v1/admin/lifetime-stats":
        result = await handleAdminLifetimeStats(req, url);
        break;
      case "/api/v1/pool/stats":
        result = await handlePublicPoolStats();
        break;
      case "/api/v1/transparency":
        result = await handleTransparency();
        break;
      case "/api/v1/risk/token":
        result = await handleTokenRisk(req, url);
        break;
      case "/api/v1/risk/flagged":
        result = await handleFlaggedTokens();
        break;
      case "/api/v1/marketplace/stats":
        result = await handleMarketplaceStats();
        break;
      case "/api/v1/referrals":
        result = await handleReferrals(req, url);
        break;
      case "/api/v1/holders":
        result = await handleHolders(req, url);
        break;
      case "/api/v1/holders/pool":
        result = await handleHolderPool();
        break;
      case "/api/v1/lp-loyalty":
        result = await handleLpLoyalty(req, url);
        break;
      case "/api/v1/cosign-borrow":
        result = await handleCosignBorrow(req);
        break;
      case "/api/v1/agent/build-borrow":
        result = await handleAgentBuildBorrow(req);
        break;
      case "/api/v1/agent/build-repay":
        result = await handleAgentBuildRepay(req);
        break;
      case "/api/v1/agent/build-extend":
        result = await handleAgentBuildExtend(req);
        break;
      case "/api/v1/agent/build-topup":
        result = await handleAgentBuildTopup(req);
        break;
      case "/api/v1/agent/build-partial-repay":
        result = await handleAgentBuildPartialRepay(req);
        break;
      case "/api/v1/agent/credit-attest":
        result = await handleCreditAttest(req, url);
        break;
      case "/api/v1/agent/intent":
        // POST creates a conditional borrow intent.
        // GET ?id=... reads its state.
        // DELETE ?id=... cancels a pending intent.
        if (req.method === "POST") {
          result = await handleAgentCreateIntent(req);
        } else {
          result = await handleAgentIntent(req, Object.fromEntries(url.searchParams));
        }
        break;
      case "/api/v1/agent/intents":
        result = await handleAgentListIntents(req, Object.fromEntries(url.searchParams));
        break;
      case "/api/v1/sync-loan":
        result = await handleSyncLoan(req);
        break;
      case "/api/v1/debug/recent-errors":
        // Live tail of console.error/warn. Safe to expose — no PII,
        // cleared on restart, bounded at 200 entries.
        result = await handleDebugRecentErrors(req, url);
        break;
      case "/api/v1/wallet/backfill-loans":
        result = await handleBackfillWalletLoans(req);
        break;
      case "/api/v1/ai/chat/stream":
        // Streaming variant of /api/v1/ai/chat. Writes NDJSON frames
        // directly to res — we mark the response handled and skip
        // the writeJson at the end so we don't double-send.
        result = await handleAiChatStream(req, res);
        if (result && result.__handled) return;
        break;
      case "/api/v1/lender-alarm-webhook":
        result = await handleLenderAlarmWebhook(req);
        break;
      case "/api/v1/link/request":
        result = await handleLinkRequest(req);
        break;
      case "/api/v1/link/status":
        result = await handleLinkStatus(req, url);
        break;
      case "/api/v1/withdraw":
        result = await handleSiteWithdraw(req);
        break;
      case "/api/v1/support/tickets":
        result = await handleSupportTickets(req, url);
        break;
      case "/api/v1/support/ticket-details":
        result = await handleSupportTicketDetails(req);
        break;
      case "/api/v1/support/delete-ticket":
        result = await handleSupportDeleteTicket(req);
        break;
      case "/api/v1/support/ask":
        result = await handleSupportAsk(req);
        break;
      case "/api/v1/wallets":
        result = await handleWalletsList(req, url);
        break;
      case "/api/v1/wallets/set-active":
        result = await handleWalletsSetActive(req);
        break;
      case "/api/v1/prefs":
        result = await handlePrefsList(req, url);
        break;
      case "/api/v1/prefs/set":
        result = await handlePrefsSet(req);
        break;
      case "/api/v1/governance/vote":
        result = await handleGovernanceVoteSubmit(req);
        break;
      case "/api/v1/governance/votes":
        result = await handleGovernanceVotesAggregate(req, url);
        break;
      case "/api/v1/governance/tally":
        result = await handleGovernanceTally(req, url);
        break;
      case "/api/v1/governance/voting-power":
        result = await handleVotingPowerQuery(req, url);
        break;
      case "/api/v1/governance/distribution":
        result = await handleDistributionQuery(req, url);
        break;
      case "/api/v1/governance/distributions":
        result = await handleDistributionsListQuery(req, url);
        break;
      case "/api/v1/activity":
        result = await handleActivity(req, url);
        break;
      case "/api/v1/ai/chat":
        result = await handleAiChat(req);
        break;
      case "/api/v1/auth/pip-session":
        result = await handlePipSession(req);
        break;
      case "/api/v1/me/export":
        result = await handleMeExport(req);
        break;
      case "/api/v1/dashboard":
        result = await handleDashboardAggregate(req, url);
        break;
      default:
        result = {
          status: 200,
          body: {
            service: "Magpie Credit Protocol API",
            version: "1.0.0",
            endpoints: {
              "GET /api/v1/health": "Service health check",
              "GET /api/v1/credit/score?wallet=<address>": "Query credit score by wallet",
              "GET /api/v1/credit/history?wallet=<address>": "Score history trend",
              "GET /api/v1/credit/leaderboard": "Top credit scores",
              "GET /api/v1/tokens": "All approved tokens (public, no auth)",
              "GET /api/v1/loans?wallet=<address>": "Active + historical loans for a wallet",
              "GET /api/v1/referrals?wallet=<address>": "Referral code + earnings for a wallet",
              "GET /api/v1/holders?wallet=<address>": "$MAGPIE holder balance + reward stats",
              "GET /api/v1/holders/pool": "Current $MAGPIE holder reward pool size",
              "GET /api/v1/wallet/balance?wallet=<address>": "SOL + token balances for a wallet",
              "GET /api/v1/risk/token?mint=<address>": "Token risk assessment",
              "GET /api/v1/risk/flagged": "Currently flagged tokens",
              "GET /api/v1/marketplace/stats": "P2P marketplace statistics",
              "GET /api/v1/transparency": "Aggregated public protocol health stats (no auth, no PII)",
            },
            auth: "Pass API key in X-API-Key header",
          },
        };
    }
  } catch (err) {
    console.error(`[api] Error on ${path}:`, err.message);
    result = { status: 500, body: { error: "Internal server error" } };
  }

  await writeJson(req, res, result.status, {
    "Content-Type": "application/json",
    // 30s fresh, 60s stale-while-revalidate: clients get instant
    // responses for the next 90s after a fetch, with the background
    // revalidating after 30s. Material on mobile where re-fetches
    // pause UI; staleness for read-only public data is acceptable.
    "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
  }, result.body);
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startApiServer() {
  const server = http.createServer(router);
  server.listen(PORT, () => {
    console.log(`[api] Credit Protocol API listening on port ${PORT}`);
  });
  return server;
}
