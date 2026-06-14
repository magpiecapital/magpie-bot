/**
 * /risk <symbol> — View AI risk assessment for a token
 *
 * Shows the token's risk score, dimension breakdown, LTV modifier,
 * and any active flags or warnings.
 */
import { getTokenRisk, getTokenRiskHistory } from "../services/risk-engine.js";
import { query } from "../db/pool.js";

function riskBar(value) {
  const filled = Math.round((value / 100) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function riskEmoji(score) {
  if (score <= 25) return "🟢";
  if (score <= 50) return "🟡";
  if (score <= 75) return "🟠";
  return "🔴";
}

function riskLabel(score) {
  if (score <= 25) return "Low Risk";
  if (score <= 50) return "Moderate Risk";
  if (score <= 75) return "High Risk";
  return "Critical Risk";
}

export async function handleRisk(ctx) {
  const symbol = ctx.message.text.split(/\s+/)[1]?.toUpperCase();
  if (!symbol) {
    return ctx.reply(
      "Usage: /risk <SYMBOL>\n\nExample: /risk WIF\n\nShows AI risk assessment including volatility, liquidity, and rug-pull detection.",
    );
  }

  try {
    // Find mint by symbol via the safe resolver — refuses to silently
    // pick when multiple enabled tokens share the same ticker (e.g. a
    // memecoin and a tokenized stock with the same symbol). Operator-
    // demanded class-of-vulnerability defense, 2026-06-14.
    const { resolveSymbol, formatAmbiguousMessage } = await import("../services/safe-symbol-lookup.js");
    const resolution = await resolveSymbol(symbol);
    if (resolution.status === "not_found") {
      return ctx.reply(`Token "${symbol}" not found in supported mints. Use /supported to see all.`);
    }
    if (resolution.status === "ambiguous") {
      return ctx.reply(formatAmbiguousMessage(symbol, resolution.candidates));
    }
    const mint = resolution.mint;

    const profile = await getTokenRisk(mint.mint);
    if (!profile) {
      return ctx.reply(`No risk data yet for ${symbol}. The risk engine will profile it on its next cycle.`);
    }

    const history = await getTokenRiskHistory(mint.mint, 6);

    // Trend
    let trend = "";
    if (history.length >= 2) {
      const diff = Number(profile.risk_score) - Number(history[history.length - 1].risk_score);
      trend = diff > 5 ? "📈 increasing" : diff < -5 ? "📉 decreasing" : "➡️ stable";
    }

    const rs = Number(profile.risk_score);

    const msg = [
      `🔬 <b>Risk Assessment: ${symbol}</b>`,
      ``,
      `${riskEmoji(rs)} <b>Risk Score: ${rs}/100</b> — ${riskLabel(rs)}`,
      trend ? `Trend: ${trend}` : ``,
      ``,
      `<b>Dimension Breakdown:</b>`,
      `Volatility (30%)`,
      `  ${riskBar(profile.volatility_score)} ${Math.round(Number(profile.volatility_score))}`,
      `Liquidity (25%)`,
      `  ${riskBar(profile.liquidity_score)} ${Math.round(Number(profile.liquidity_score))}`,
      `Concentration (20%)`,
      `  ${riskBar(profile.concentration_score)} ${Math.round(Number(profile.concentration_score))}`,
      `Volume (15%)`,
      `  ${riskBar(profile.volume_score)} ${Math.round(Number(profile.volume_score))}`,
      `Rug-Pull (10%)`,
      `  ${riskBar(profile.rug_pull_score)} ${Math.round(Number(profile.rug_pull_score))}`,
      ``,
      `<b>Market Data:</b>`,
      profile.liquidity_usd ? `  Liquidity: $${Number(profile.liquidity_usd).toLocaleString()}` : ``,
      profile.volume_24h_usd ? `  24h Volume: $${Number(profile.volume_24h_usd).toLocaleString()}` : ``,
      profile.market_cap_usd ? `  Market Cap: $${Number(profile.market_cap_usd).toLocaleString()}` : ``,
      ``,
      `<b>Lending Impact:</b>`,
      `  LTV Modifier: ${Number(profile.ltv_modifier) > 0 ? "+" : ""}${profile.ltv_modifier}%`,
      `  Max Allowed LTV: ${profile.max_allowed_ltv}%`,
      ``,
      profile.flagged ? `🚨 <b>FLAGGED:</b> ${profile.flag_reason}` : `✅ No active warnings`,
    ].filter(Boolean).join("\n");

    return ctx.reply(msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[risk] Error:", err);
    return ctx.reply("Error fetching risk data. Please try again.");
  }
}
