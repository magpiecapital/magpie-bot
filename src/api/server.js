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
import { getHeartbeats, getStartedAt } from "../lib/heartbeat.js";

// Staleness thresholds for each periodic service.
// 2x the configured POLL_INTERVAL_MS gives one missed cycle of slack.
const STALE_MS = {
  screener: 20 * 60 * 1000,        // 20 min (screener runs every 10)
  "token-health": 2 * 60 * 60 * 1000, // 2h (token-health runs every 1h)
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

  const { rows: [w] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1`, [wallet],
  );
  if (!w) {
    // Unknown wallet — return empty (not an error: dashboard may render zero state)
    return { status: 200, body: { wallet, active: [], history: [] } };
  }

  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.loan_pda, l.collateral_mint, l.collateral_amount,
            l.loan_amount_lamports, l.original_loan_amount_lamports,
            l.ltv_percentage, l.duration_days,
            l.start_timestamp, l.due_timestamp,
            l.status, l.tx_signature, l.updated_at,
            sm.symbol, sm.name, sm.decimals, sm.image_url, sm.category
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE l.user_id = $1
      ORDER BY l.start_timestamp DESC
      LIMIT 100`,
    [w.user_id],
  );

  const shape = (l) => ({
    loan_id: l.loan_id?.toString?.() ?? null,
    loan_pda: l.loan_pda,
    status: l.status,
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
      amount_lamports: l.loan_amount_lamports?.toString?.() ?? null,
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

  return {
    status: 200,
    body: {
      wallet,
      active: rows.filter((r) => r.status === "active").map(shape),
      history: rows.filter((r) => r.status !== "active").map(shape),
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

const PUBLIC_ROUTES = new Set([
  "/api/v1/health",
  "/api/v1/tokens",
  "/api/v1/loans",
  "/api/v1/wallet/balance",
  "/api/v1/credit/score",
  // Admin route is "public" at the HTTP layer but gates internally on
  // wallet === LENDER_PUBKEY, so any non-creator caller gets a 403.
  "/api/v1/admin/pool-stats",
  "/api/v1/pool/stats",
]);

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

  // Health check (no auth) — real liveness probe
  if (path === "/api/v1/health") {
    const checks = { db: "unknown", screener: "unknown", "token-health": "unknown" };
    const reasons = [];
    const now = Date.now();
    const sinceStartup = now - getStartedAt();
    const inGrace = sinceStartup < STARTUP_GRACE_MS;

    // 1. DB ping
    try {
      await query("SELECT 1");
      checks.db = "ok";
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
      case "/api/v1/tokens":
        result = await handleTokens();
        break;
      case "/api/v1/loans":
        result = await handleLoans(req, url);
        break;
      case "/api/v1/wallet/balance":
        result = await handleWalletBalance(req, url);
        break;
      case "/api/v1/admin/pool-stats":
        result = await handleAdminPoolStats(req, url);
        break;
      case "/api/v1/pool/stats":
        result = await handlePublicPoolStats();
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
              "GET /api/v1/tokens": "All approved tokens (public, no auth)",
              "GET /api/v1/loans?wallet=<address>": "Active + historical loans for a wallet",
              "GET /api/v1/wallet/balance?wallet=<address>": "SOL + token balances for a wallet",
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
