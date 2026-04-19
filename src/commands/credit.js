/**
 * /credit — View your Magpie Credit Score
 *
 * Shows the user's 300-850 credit score with factor breakdown,
 * tier benefits, and score history trend.
 */
import { getCreditScore, getScoreHistory, tierBenefits } from "../services/credit-score.js";
import { findUserByTelegramId } from "../services/users.js";

const TIER_EMOJI = {
  bronze: "🥉",
  silver: "🥈",
  gold: "🥇",
  platinum: "💎",
};

function factorBar(value, max = 100) {
  const filled = Math.round((value / max) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function tierLabel(tier) {
  return `${TIER_EMOJI[tier] || ""} ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
}

export async function handleCredit(ctx) {
  const user = await findUserByTelegramId(ctx.from.id);
  if (!user) {
    return ctx.reply("Please /start first to create your account.");
  }

  try {
    const score = await getCreditScore(user.id);
    if (!score) {
      return ctx.reply(
        "📊 <b>Credit Score</b>\n\n" +
        "No credit history yet. Take out a loan and repay it to start building your score!",
        { parse_mode: "HTML" },
      );
    }

    const benefits = tierBenefits(score.tier);
    const history = await getScoreHistory(user.id, 5);

    // Score trend
    let trend = "";
    if (history.length >= 2) {
      const diff = score.score - history[history.length - 1].score;
      trend = diff > 0 ? `📈 +${diff}` : diff < 0 ? `📉 ${diff}` : "➡️ stable";
    }

    const msg = [
      `📊 <b>Magpie Credit Score</b>`,
      ``,
      `<b>${score.score}</b> / 850  ${tierLabel(score.tier)}  ${trend}`,
      ``,
      `<b>Factor Breakdown:</b>`,
      `Repayment History (35%)`,
      `  ${factorBar(score.f_repayment_history)} ${Math.round(score.f_repayment_history)}%`,
      `Loan Volume (20%)`,
      `  ${factorBar(score.f_loan_volume)} ${Math.round(score.f_loan_volume)}%`,
      `Account Age (15%)`,
      `  ${factorBar(score.f_account_age)} ${Math.round(score.f_account_age)}%`,
      `Collateral Diversity (15%)`,
      `  ${factorBar(score.f_collateral_diversity)} ${Math.round(score.f_collateral_diversity)}%`,
      `Liquidation Ratio (10%)`,
      `  ${factorBar(score.f_liquidation_ratio)} ${Math.round(score.f_liquidation_ratio)}%`,
      `Protocol Engagement (5%)`,
      `  ${factorBar(score.f_protocol_engagement)} ${Math.round(score.f_protocol_engagement)}%`,
      ``,
      `<b>Tier Benefits:</b>`,
      `  Max LTV: ${benefits.maxLtv}%`,
      `  Fee Rate: ${(benefits.feeRate * 100).toFixed(2)}%`,
      `  Max Duration: ${benefits.maxDays} days`,
      ``,
      `<b>How to improve:</b>`,
      score.score < 500 ? `  • Repay loans on time (+15 pts)` : ``,
      score.score < 650 ? `  • Repay early for bonus (+20 pts)` : ``,
      score.score < 750 ? `  • Use diverse collateral (+5 pts)` : ``,
      `  • Top up collateral proactively (+8 pts)`,
      `  • Refer other borrowers (+10 pts)`,
    ].filter(Boolean).join("\n");

    return ctx.reply(msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[credit] Error:", err);
    return ctx.reply("Error fetching credit score. Please try again.");
  }
}
