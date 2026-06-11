/**
 * /credit — View your Magpie Credit Score
 *
 * Shows the user's 300-850 credit score with factor breakdown,
 * tier benefits, and score history trend.
 */
import { getCreditScore, getScoreHistory, tierBenefits } from "../services/credit-score.js";
import { findUserByTelegramId } from "../services/users.js";

function factorBar(value, max = 100) {
  const filled = Math.round((value / max) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function tierLabel(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Pip-as-coach: one warm, contextual line above the score that reads the
 * user's number and reacts. Picks tone from the score band and the
 * trend direction. Pure prose — doesn't reveal any internal score
 * formula, just speaks to what the user has done.
 */
function creditCoachLine(score, trendStr) {
  const s = score.score;
  const trendingUp = trendStr.includes("up");
  const trendingDown = trendStr.includes("down");
  if (s >= 800) {
    return trendingDown
      ? `Elite tier, but trending down — one liquidation can move you fast at this level. Stay defensive.`
      : `Elite tier. You've earned the lowest fees in the protocol. Keep the streak.`;
  }
  if (s >= 700) {
    return trendingUp
      ? `Strong score, still climbing. Each on-time repay edges you toward Platinum benefits.`
      : `Strong score — you're getting better rates than most users on the protocol.`;
  }
  if (s >= 600) {
    return trendingUp
      ? `Building momentum. Repay your next 2 on time and you'll cross into the next tier.`
      : `Solid baseline. Quickest path up: repay your active loans on time and pick up diverse collateral.`;
  }
  if (s >= 500) {
    return trendingDown
      ? `Score slipped — a missed deadline or liquidation hit you. Open a small loan and repay it cleanly to recover.`
      : `Mid-range. You're trusted, but the upside (Gold/Platinum) requires consistent repayment.`;
  }
  if (s >= 400) {
    return `Early days. One clean cycle (borrow → repay on time) is worth ~15 points. Start small to compound.`;
  }
  // Below 400
  return trendingDown
    ? `Score is low and trending down. Pause new loans until existing ones are squared away — protect the recovery.`
    : `Low score, but every clean repayment from here adds up. The fastest rebuild: small loan + early repay.`;
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
        "<b>Credit Score</b>\n\n" +
        "No credit history yet. Take out a loan and repay it to start building your score.",
        { parse_mode: "HTML" },
      );
    }

    const benefits = tierBenefits(score.tier);
    const history = await getScoreHistory(user.id, 5);

    // Score trend
    let trend = "";
    if (history.length >= 2) {
      const diff = score.score - history[history.length - 1].score;
      trend = diff > 0 ? `up +${diff}` : diff < 0 ? `down ${diff}` : "stable";
    }

    // Pip's read of the score — short, warm, scored to the actual number.
    // Surfaces above the technical breakdown so the user gets the
    // *story* before the data.
    const coachLine = creditCoachLine(score, trend);

    const msg = [
      `<b>Magpie Credit Score</b>`,
      ``,
      `<b>${score.score}</b> / 850 · ${tierLabel(score.tier)} tier${trend ? ` · ${trend}` : ""}`,
      coachLine ? `<i>Pip: ${coachLine}</i>` : null,
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
