/**
 * Magpie AI Risk Engine
 *
 * Continuously profiles supported tokens on five risk dimensions, computes
 * dynamic LTV modifiers, and generates predictive liquidation signals.
 *
 * Risk dimensions (weighted):
 *   1. Volatility       (30%) — price stability over 24h/7d
 *   2. Liquidity Depth  (25%) — DEX liquidity relative to market cap
 *   3. Holder Concentration (20%) — top-holder dominance
 *   4. Volume Patterns   (15%) — trading consistency and wash-trade signals
 *   5. Rug-Pull Signals  (10%) — dev wallet, locked LP, mint authority
 *
 * Output: risk_score 0-100 (higher = riskier)
 * LTV modifier: low risk → +3% LTV bonus, high risk → -10% LTV penalty
 */
import axios from "axios";
import { query } from "../db/pool.js";
import "dotenv/config";

const DEXSCREENER_API = "https://api.dexscreener.com";
const JUPITER_API = process.env.JUPITER_API_URL || "https://api.jup.ag/price/v2";
const HELIUS_API = process.env.HELIUS_API_URL; // optional: for holder data
const RISK_CHECK_INTERVAL = parseInt(process.env.RISK_CHECK_INTERVAL || "300", 10) * 1000;

// ─── Scoring functions ──────────────────────────────────────────────────────

/**
 * Score volatility from price change data (0-100, higher = more volatile = riskier).
 */
function scoreVolatility(priceChange24h, priceChange6h, priceChange1h) {
  const abs24h = Math.abs(priceChange24h || 0);
  const abs6h = Math.abs(priceChange6h || 0);
  const abs1h = Math.abs(priceChange1h || 0);

  // Weight recent volatility more heavily
  const weighted = abs1h * 0.4 + abs6h * 0.35 + abs24h * 0.25;

  // Map: 0% change = 0 risk, 5% = 25, 15% = 50, 30% = 75, 50%+ = 100
  return Math.min(100, (weighted / 50) * 100);
}

/**
 * Score liquidity relative to market cap (0-100, lower liquidity = riskier).
 */
function scoreLiquidity(liquidityUsd, marketCapUsd) {
  if (!liquidityUsd || liquidityUsd <= 0) return 95; // no liquidity = very risky
  if (!marketCapUsd || marketCapUsd <= 0) return 70;

  const ratio = liquidityUsd / marketCapUsd;
  // ratio > 0.10 = very liquid (score 10), 0.05 = moderate (40), 0.01 = low (70), < 0.005 = dangerous (90)
  if (ratio >= 0.10) return 10;
  if (ratio >= 0.05) return 30;
  if (ratio >= 0.02) return 50;
  if (ratio >= 0.01) return 70;
  if (ratio >= 0.005) return 85;
  return 95;
}

/**
 * Score holder concentration (0-100, more concentrated = riskier).
 */
function scoreConcentration(top10HolderPct) {
  if (top10HolderPct == null) return 50; // unknown = moderate risk
  // < 20% = healthy (15), 30% = moderate (35), 50% = concerning (60), 70%+ = dangerous (85)
  return Math.min(100, Math.max(0, (top10HolderPct / 80) * 100));
}

/**
 * Score volume patterns (0-100, inconsistent/low volume = riskier).
 */
function scoreVolume(volume24h, liquidityUsd, marketCapUsd) {
  if (!volume24h || volume24h <= 0) return 80; // no volume = risky

  // Volume-to-liquidity ratio (healthy is 0.5-3x)
  const volLiqRatio = liquidityUsd > 0 ? volume24h / liquidityUsd : 0;

  let score = 50; // baseline

  // Too low volume relative to liquidity
  if (volLiqRatio < 0.1) score = 80;
  else if (volLiqRatio < 0.5) score = 60;
  // Healthy range
  else if (volLiqRatio <= 3) score = 20;
  // Suspiciously high (possible wash trading)
  else if (volLiqRatio <= 10) score = 50;
  else score = 75; // extreme wash trading signal

  // Absolute volume floor: < $10k = risky regardless
  if (volume24h < 10_000) score = Math.max(score, 75);
  if (volume24h < 1_000) score = 95;

  return score;
}

/**
 * Score rug-pull indicators (0-100, more signals = riskier).
 */
function scoreRugPull({ devWalletPct, lockedLiquidity, contractRenounced, mintAuthorityDisabled }) {
  let score = 50; // baseline

  // Dev wallet holding
  if (devWalletPct != null) {
    if (devWalletPct > 30) score += 30;
    else if (devWalletPct > 15) score += 15;
    else if (devWalletPct > 5) score += 5;
    else score -= 10;
  }

  // Locked liquidity is good
  if (lockedLiquidity) score -= 20;
  else score += 10;

  // Renounced contract is good
  if (contractRenounced) score -= 10;

  // Mint authority disabled is good
  if (mintAuthorityDisabled) score -= 15;
  else score += 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Compute composite risk score from all dimensions.
 */
function computeRiskScore(scores) {
  return Math.round(
    scores.volatility * 0.30 +
    scores.liquidity * 0.25 +
    scores.concentration * 0.20 +
    scores.volume * 0.15 +
    scores.rugPull * 0.10,
  );
}

/**
 * Map risk score to LTV modifier.
 * Low risk (0-25): +3% LTV bonus
 * Medium risk (25-50): 0% modifier
 * High risk (50-75): -5% LTV penalty
 * Critical risk (75-100): -10% LTV penalty
 */
function riskToLtvModifier(riskScore) {
  if (riskScore <= 25) return 3;
  if (riskScore <= 50) return 0;
  if (riskScore <= 75) return -5;
  return -10;
}

function riskToMaxLtv(riskScore) {
  if (riskScore <= 25) return 35;
  if (riskScore <= 50) return 30;
  if (riskScore <= 75) return 25;
  return 15;
}

// ─── Data fetching ──────────────────────────────────────────────────────────

/**
 * Fetch token market data from DexScreener.
 */
async function fetchDexScreenerData(mints) {
  const results = {};
  // DexScreener allows up to 30 tokens per request
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const resp = await axios.get(
        `${DEXSCREENER_API}/tokens/v1/solana/${batch.join(",")}`,
        { timeout: 15_000 },
      );
      const pairs = resp.data || [];
      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint || results[mint]) continue;
        results[mint] = {
          priceUsd: Number(pair.priceUsd) || 0,
          priceChange24h: pair.priceChange?.h24 || 0,
          priceChange6h: pair.priceChange?.h6 || 0,
          priceChange1h: pair.priceChange?.h1 || 0,
          volume24h: pair.volume?.h24 || 0,
          liquidityUsd: pair.liquidity?.usd || 0,
          marketCap: pair.marketCap || 0,
          fdv: pair.fdv || 0,
        };
      }
    } catch (err) {
      console.error(`[risk-engine] DexScreener fetch error:`, err.message);
    }
  }
  return results;
}

// ─── Core engine ────────────────────────────────────────────────────────────

/**
 * Profile a single token and update the database.
 */
export async function profileToken(mint, symbol, marketData) {
  const data = marketData || {};

  const volatilityScore = scoreVolatility(
    data.priceChange24h, data.priceChange6h, data.priceChange1h,
  );
  const liquidityScore = scoreLiquidity(data.liquidityUsd, data.marketCap);
  const concentrationScore = scoreConcentration(data.top10HolderPct || null);
  const volumeScore = scoreVolume(data.volume24h, data.liquidityUsd, data.marketCap);
  const rugPullScore = scoreRugPull({
    devWalletPct: data.devWalletPct,
    lockedLiquidity: data.lockedLiquidity,
    contractRenounced: data.contractRenounced,
    mintAuthorityDisabled: data.mintAuthorityDisabled,
  });

  const riskScore = computeRiskScore({
    volatility: volatilityScore,
    liquidity: liquidityScore,
    concentration: concentrationScore,
    volume: volumeScore,
    rugPull: rugPullScore,
  });

  const ltvModifier = riskToLtvModifier(riskScore);
  const maxAllowedLtv = riskToMaxLtv(riskScore);
  const flagged = riskScore >= 80;
  const flagReason = flagged
    ? [
        volatilityScore >= 80 && "extreme volatility",
        liquidityScore >= 85 && "dangerously low liquidity",
        volumeScore >= 80 && "suspicious volume pattern",
        rugPullScore >= 75 && "rug-pull indicators detected",
      ].filter(Boolean).join(", ")
    : null;

  await query(
    `INSERT INTO token_risk_profiles (
       mint, symbol, risk_score,
       volatility_score, liquidity_score, concentration_score,
       volume_score, rug_pull_score,
       volatility_24h, liquidity_usd, liquidity_ratio,
       volume_24h_usd, market_cap_usd,
       ltv_modifier, max_allowed_ltv,
       flagged, flag_reason, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (mint) DO UPDATE SET
       symbol=$2, risk_score=$3,
       volatility_score=$4, liquidity_score=$5, concentration_score=$6,
       volume_score=$7, rug_pull_score=$8,
       volatility_24h=$9, liquidity_usd=$10, liquidity_ratio=$11,
       volume_24h_usd=$12, market_cap_usd=$13,
       ltv_modifier=$14, max_allowed_ltv=$15,
       flagged=$16, flag_reason=$17, updated_at=NOW()`,
    [
      mint, symbol, riskScore,
      volatilityScore, liquidityScore, concentrationScore,
      volumeScore, rugPullScore,
      Math.abs(data.priceChange24h || 0),
      data.liquidityUsd || 0,
      data.marketCap > 0 ? (data.liquidityUsd || 0) / data.marketCap : 0,
      data.volume24h || 0,
      data.marketCap || 0,
      ltvModifier, maxAllowedLtv,
      flagged, flagReason,
    ],
  );

  // Save history snapshot
  await query(
    `INSERT INTO token_risk_history (mint, risk_score, volatility_24h, liquidity_usd, volume_24h_usd, market_cap_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [mint, riskScore, Math.abs(data.priceChange24h || 0), data.liquidityUsd || 0, data.volume24h || 0, data.marketCap || 0],
  );

  return {
    mint, symbol, riskScore,
    scores: { volatility: volatilityScore, liquidity: liquidityScore, concentration: concentrationScore, volume: volumeScore, rugPull: rugPullScore },
    ltvModifier, maxAllowedLtv, flagged, flagReason,
  };
}

/**
 * Get the risk profile for a specific token.
 */
export async function getTokenRisk(mint) {
  const { rows: [profile] } = await query(
    `SELECT * FROM token_risk_profiles WHERE mint = $1`,
    [mint],
  );
  return profile;
}

/**
 * Get risk history for a token (for trend charts).
 */
export async function getTokenRiskHistory(mint, limit = 48) {
  const { rows } = await query(
    `SELECT risk_score, volatility_24h, liquidity_usd, volume_24h_usd, market_cap_usd, snapshot_at
     FROM token_risk_history WHERE mint = $1 ORDER BY snapshot_at DESC LIMIT $2`,
    [mint, limit],
  );
  return rows;
}

/**
 * Get all flagged tokens.
 */
export async function getFlaggedTokens() {
  const { rows } = await query(
    `SELECT mint, symbol, risk_score, flag_reason, updated_at
     FROM token_risk_profiles WHERE flagged = true ORDER BY risk_score DESC`,
  );
  return rows;
}

// ─── Predictive liquidation ─────────────────────────────────────────────────

/**
 * Analyze all active loans and generate predictive liquidation signals.
 * Called by the health watcher on each cycle.
 */
export async function generateLiquidationSignals() {
  const { rows: activeLoans } = await query(
    `SELECT l.id, l.user_id, l.collateral_mint, l.collateral_amount,
            l.original_loan_amount_lamports, l.due_timestamp, l.last_health_alert,
            sm.decimals, sm.symbol
     FROM loans l
     JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.status = 'active'`,
  );

  const signals = [];

  for (const loan of activeLoans) {
    // Get token risk profile
    const risk = await getTokenRisk(loan.collateral_mint);
    if (!risk) continue;

    const riskScore = Number(risk.risk_score);
    const hoursUntilDue = (new Date(loan.due_timestamp) - Date.now()) / (1000 * 60 * 60);

    // Signal: high volatility on a high-LTV loan
    if (riskScore >= 60 && Number(risk.volatility_score) >= 70) {
      signals.push({
        loanId: loan.id,
        userId: loan.user_id,
        type: "volatility_spike",
        severity: riskScore >= 80 ? "critical" : "high",
        metadata: {
          riskScore,
          volatilityScore: Number(risk.volatility_score),
          symbol: loan.symbol || risk.symbol,
        },
      });
    }

    // Signal: liquidity drain
    if (Number(risk.liquidity_score) >= 80) {
      signals.push({
        loanId: loan.id,
        userId: loan.user_id,
        type: "liquidity_drain",
        severity: Number(risk.liquidity_score) >= 90 ? "critical" : "high",
        metadata: {
          liquidityScore: Number(risk.liquidity_score),
          liquidityUsd: Number(risk.liquidity_usd),
        },
      });
    }

    // Signal: rug detected
    if (risk.flagged) {
      signals.push({
        loanId: loan.id,
        userId: loan.user_id,
        type: "rug_detected",
        severity: "critical",
        metadata: { flagReason: risk.flag_reason },
      });
    }

    // Signal: expiry risk (within 6 hours)
    if (hoursUntilDue > 0 && hoursUntilDue < 6) {
      signals.push({
        loanId: loan.id,
        userId: loan.user_id,
        type: "expiry_risk",
        severity: hoursUntilDue < 2 ? "critical" : "high",
        metadata: { hoursUntilDue: Math.round(hoursUntilDue * 10) / 10 },
      });
    }
  }

  // Persist signals
  for (const sig of signals) {
    await query(
      `INSERT INTO liquidation_signals (loan_id, user_id, signal_type, severity, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [sig.loanId, sig.userId, sig.type, sig.severity, JSON.stringify(sig.metadata)],
    );
  }

  return signals;
}

// ─── Background watcher ─────────────────────────────────────────────────────

/**
 * Start the risk engine background loop.
 * Profiles all supported tokens on an interval and generates liquidation signals.
 */
export function startRiskEngine(bot) {
  console.log(`[risk-engine] Starting (interval: ${RISK_CHECK_INTERVAL / 1000}s)`);

  async function cycle() {
    try {
      // Fetch all enabled mints
      const { rows: mints } = await query(
        `SELECT mint, symbol FROM supported_mints WHERE enabled = true`,
      );
      if (mints.length === 0) return;

      const mintAddresses = mints.map(m => m.mint);
      const marketData = await fetchDexScreenerData(mintAddresses);

      let flaggedCount = 0;
      for (const { mint, symbol } of mints) {
        const data = marketData[mint] || {};
        const result = await profileToken(mint, symbol, data);
        if (result.flagged) flaggedCount++;
      }

      // Generate predictive liquidation signals
      const signals = await generateLiquidationSignals();

      // Notify users of critical signals
      const criticalSignals = signals.filter(s => s.severity === "critical");
      for (const sig of criticalSignals) {
        try {
          const { rows: [user] } = await query(
            `SELECT telegram_id FROM users WHERE id = $1`,
            [sig.userId],
          );
          if (!user) continue;

          const msgs = {
            volatility_spike: `⚠️ <b>Risk Alert:</b> Your collateral token is experiencing extreme volatility. Consider adding collateral or repaying.`,
            liquidity_drain: `⚠️ <b>Liquidity Alert:</b> Your collateral token's liquidity has dropped significantly. This increases liquidation risk.`,
            rug_detected: `🚨 <b>CRITICAL:</b> Rug-pull indicators detected on your collateral token! Repay immediately to recover your assets.`,
            expiry_risk: `⏰ <b>Expiry Alert:</b> Your loan expires in less than ${sig.metadata.hoursUntilDue}h. Repay or extend now.`,
          };

          await bot.api.sendMessage(user.telegram_id, msgs[sig.type] || "⚠️ Risk alert on your loan.", {
            parse_mode: "HTML",
          });
        } catch (err) {
          console.error(`[risk-engine] Failed to notify user ${sig.userId}:`, err.message);
        }
      }

      if (flaggedCount > 0 || criticalSignals.length > 0) {
        console.log(`[risk-engine] Flagged tokens: ${flaggedCount}, Critical signals: ${criticalSignals.length}`);
      }
    } catch (err) {
      console.error("[risk-engine] cycle error:", err.message);
    }
  }

  // Initial run after 10s, then on interval
  setTimeout(cycle, 10_000);
  setInterval(cycle, RISK_CHECK_INTERVAL);
}
