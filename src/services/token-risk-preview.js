/**
 * Token risk preview — a one-line risk read shown right before the user
 * commits a borrow. Based on the data already in supported_mints from
 * the screener pipeline (liquidity, holder count, authority status,
 * top-10 concentration, safety score, age).
 *
 * Output bands:
 *   🟢 LOW      — well-established, deep liquidity, decentralized
 *   🟡 MEDIUM   — fine but with notable risk factors
 *   🟠 ELEVATED — multiple concerns; user should know
 *   🔴 HIGH     — only borrow what you'd be ok losing
 *
 * The screener already disabled-flags the most dangerous tokens, so
 * anything that gets here is at least minimally vetted.
 */
import { query } from "../db/pool.js";

const LIQUIDITY_THRESHOLDS = {
  low: 50_000,     // <$50k liquidity = high slippage risk
  medium: 250_000, // $50k-250k = medium
  good: 1_000_000, // >$1M = solid
};

const HOLDER_THRESHOLDS = {
  low: 500,        // <500 holders = thin
  medium: 5_000,
  good: 20_000,
};

const AGE_THRESHOLDS = {
  young: 168,    // <7d = young
  mature: 720,   // <30d = maturing
};

/**
 * Returns: { band: "low"|"medium"|"elevated"|"high",
 *            emoji: string, summary: string, factors: string[] }
 */
export async function previewTokenRisk(mintOrSymbol) {
  const { rows } = await query(
    `SELECT mint, symbol, liquidity_usd, volume_24h_usd, market_cap_usd,
            holder_count, has_mint_authority, has_freeze_authority,
            lp_burned, top10_holder_pct, safety_score, token_age_hours,
            protected
     FROM supported_mints
     WHERE mint = $1 OR LOWER(symbol) = LOWER($1)
     LIMIT 1`,
    [mintOrSymbol],
  );
  if (rows.length === 0) {
    return null;
  }
  const t = rows[0];

  // Protected tokens (like $MAGPIE) skip the risk read — they're trusted.
  if (t.protected) {
    return {
      band: "low",
      emoji: "🪶",
      summary: "Protocol-native token. Trusted.",
      factors: [],
    };
  }

  let score = 0; // higher = riskier
  const factors = [];

  // Liquidity
  const liq = Number(t.liquidity_usd) || 0;
  if (liq < LIQUIDITY_THRESHOLDS.low) {
    score += 3;
    factors.push(`thin liquidity (~$${(liq / 1000).toFixed(0)}k)`);
  } else if (liq < LIQUIDITY_THRESHOLDS.medium) {
    score += 1;
  }

  // Holders
  const holders = Number(t.holder_count) || 0;
  if (holders < HOLDER_THRESHOLDS.low) {
    score += 2;
    factors.push(`few holders (${holders.toLocaleString()})`);
  } else if (holders < HOLDER_THRESHOLDS.medium) {
    score += 1;
  }

  // Authority risk
  if (t.has_mint_authority) {
    score += 3;
    factors.push("mint authority active (supply can be inflated)");
  }
  if (t.has_freeze_authority) {
    score += 2;
    factors.push("freeze authority active (tokens can be frozen)");
  }

  // LP status
  if (!t.lp_burned) {
    score += 2;
    factors.push("LP not burned");
  }

  // Concentration
  const top10 = Number(t.top10_holder_pct) || 0;
  if (top10 > 60) {
    score += 3;
    factors.push(`top-10 hold ${top10.toFixed(0)}%`);
  } else if (top10 > 40) {
    score += 1;
  }

  // Age
  const age = Number(t.token_age_hours) || 0;
  if (age > 0 && age < AGE_THRESHOLDS.young) {
    score += 2;
    factors.push(`new token (~${Math.floor(age)}h old)`);
  } else if (age < AGE_THRESHOLDS.mature) {
    score += 1;
  }

  // Map score to band
  let band, emoji, summary;
  if (score <= 1) {
    band = "low";
    emoji = "🟢";
    summary = "Solid token — deep liquidity, mature, no major flags.";
  } else if (score <= 4) {
    band = "medium";
    emoji = "🟡";
    summary = "Reasonable risk. Standard memecoin profile.";
  } else if (score <= 7) {
    band = "elevated";
    emoji = "🟠";
    summary = "Elevated risk — multiple flags worth noting.";
  } else {
    band = "high";
    emoji = "🔴";
    summary = "High risk — borrow only what you'd be ok losing.";
  }

  return { band, emoji, summary, factors, score };
}

/**
 * Render the risk preview as a short Markdown block that fits cleanly
 * into the borrow flow's tier-selection message.
 */
export async function renderRiskBlock(mintOrSymbol) {
  const risk = await previewTokenRisk(mintOrSymbol);
  if (!risk) return "";
  const lines = [`${risk.emoji} *Token risk:* ${risk.summary}`];
  if (risk.factors.length > 0) {
    lines.push(`_Watch: ${risk.factors.slice(0, 3).join(" · ")}_`);
  }
  return lines.join("\n");
}
