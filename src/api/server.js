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
import { query } from "../db/pool.js";
import crypto from "node:crypto";
import { handleVaultApi } from "./vault-api.js";

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

// Clean up rate limit store every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore) {
    const valid = timestamps.filter(t => now - t < 60_000);
    if (valid.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, valid);
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

  const { rows: [w] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1`, [wallet],
  );
  if (!w) return { status: 404, body: { error: "Wallet not found" } };

  const { getScoreHistory } = await import("../services/credit-score.js");
  const history = await getScoreHistory(w.user_id, 50);

  return {
    status: 200,
    body: { wallet, history: history.map(h => ({ score: h.score, tier: h.tier, timestamp: h.snapshot_at })) },
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

async function handleMarketplaceStats() {
  const { getMarketplaceStats } = await import("../services/p2p-marketplace.js");
  const stats = await getMarketplaceStats();
  return { status: 200, body: { stats } };
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
        username: l.telegram_username ? `@${l.telegram_username}` : "anonymous",
      })),
    },
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

const PUBLIC_ROUTES = new Set(["/api/v1/health"]);

async function router(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "X-API-Key, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Health check (no auth)
  if (path === "/api/v1/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", service: "magpie-credit-protocol" }));
  }

  // Agent Vault routes (public — agents authenticate with their keypair)
  if (path.startsWith("/api/v1/vault")) {
    return handleVaultApi(req, res, url, path);
  }

  // Auth required for all other routes
  if (!PUBLIC_ROUTES.has(path)) {
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
      case "/api/v1/risk/token":
        result = await handleTokenRisk(req, url);
        break;
      case "/api/v1/risk/flagged":
        result = await handleFlaggedTokens();
        break;
      case "/api/v1/marketplace/stats":
        result = await handleMarketplaceStats();
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
              "GET /api/v1/risk/token?mint=<address>": "Token risk assessment",
              "GET /api/v1/risk/flagged": "Currently flagged tokens",
              "GET /api/v1/marketplace/stats": "P2P marketplace statistics",
            },
            auth: "Pass API key in X-API-Key header",
          },
        };
    }
  } catch (err) {
    console.error(`[api] Error on ${path}:`, err.message);
    result = { status: 500, body: { error: "Internal server error" } };
  }

  res.writeHead(result.status, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=30",
  });
  res.end(JSON.stringify(result.body));
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startApiServer() {
  const server = http.createServer(router);
  server.listen(PORT, () => {
    console.log(`[api] Credit Protocol API listening on port ${PORT}`);
  });
  return server;
}
