/**
 * /simulate <symbol|mint> <amount> [tier]
 *
 * Previews what a loan would look like before the user commits. Read-only;
 * no wallet, no DB writes, no on-chain calls.
 */
import { query } from "../db/pool.js";
import { getPriceInSol } from "../services/price.js";
import { getEligibleTiers } from "../services/loan-tier-resolver.js";

function usage(ctx) {
  return ctx.reply(
    "Usage: `/simulate <symbol|mint> <amount> [1|2|3]`\n" +
      "_tier 1 = 30%/2d, 2 = 25%/3d, 3 = 20%/7d; omit to see all_",
    { parse_mode: "Markdown" },
  );
}

export async function handleSimulate(ctx) {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (parts.length < 2) return usage(ctx);

  const [arg, amtStr, tierStr] = parts;
  const amount = Number(amtStr);
  if (!Number.isFinite(amount) || amount <= 0) return usage(ctx);

  const { rows } = await query(
    `SELECT mint, symbol, name, decimals, category FROM supported_mints
     WHERE enabled = TRUE AND (UPPER(symbol) = UPPER($1) OR mint = $1)
     LIMIT 1`,
    [arg],
  );
  if (rows.length === 0) {
    return ctx.reply(`❌ \`${arg}\` is not a supported collateral token.`, {
      parse_mode: "Markdown",
    });
  }
  const token = rows[0];

  let priceSol;
  try {
    priceSol = await getPriceInSol(token.mint);
  } catch (err) {
    console.warn("[simulate] price fetch failed:", err.message);
    return ctx.reply(
      [
        "⚠️ *Price feed briefly unavailable*",
        "",
        `Couldn't get a fresh ${token.symbol} price right now. Usually clears in 15-30 seconds.`,
        "",
        "Try /simulate again, or check /price for a quick read.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  const collateralValueSol = amount * priceSol;

  // Resolve tier set by category. RWA (stock/etf/metal) returns the
  // higher-LTV / longer-term / higher-fee schedule out of rwa_loan_tiers;
  // memecoin (and uncategorized) gets MEMECOIN_TIERS. Same resolver as
  // borrow.js so /simulate previews match what /borrow will actually offer.
  const resolved = await getEligibleTiers({ category: token.category });
  // User-facing tier picker is 1-indexed; resolver returns option-indexed.
  // Build the same lookup shape simulate.js historically used: {1, 2, 3}.
  const TIERS = {};
  resolved.forEach((t, i) => { TIERS[String(i + 1)] = t; });

  const tierList = tierStr ? [TIERS[tierStr]].filter(Boolean) : Object.values(TIERS);
  if (tierList.length === 0) return usage(ctx);

  const lines = [
    `🧮 *Loan simulator — ${token.symbol}*`,
    "",
    `Collateral: ${amount.toLocaleString()} ${token.symbol}`,
    `Value:      ${collateralValueSol.toFixed(6)} SOL`,
    `Price:      ${priceSol.toFixed(9)} SOL/token`,
    "",
  ];

  for (const t of tierList) {
    const gross = collateralValueSol * (t.ltv / 100);
    const fee = gross * (t.feeBps / 10_000);
    const receive = gross - fee;
    const liquidationPriceSol = (gross / 1.1) / amount; // price at which ratio drops to 1.1x
    // Resolver-built labels for RWA already include LTV/days/fee; strip
    // them out of the header line so we don't double-print.
    const headerLabel = (t.label && t.label.includes("LTV"))
      ? t.label.replace(/.*\(([^)]+)\).*/, "$1") || t.label
      : t.label;
    lines.push(
      `*${t.ltv}% LTV · ${t.days}d (${headerLabel})*`,
      `  Receive:     ${receive.toFixed(6)} SOL`,
      `  Repay:       ${gross.toFixed(6)} SOL`,
      `  Liq. price:  ${liquidationPriceSol.toFixed(9)} SOL/token`,
      "",
    );
  }
  lines.push("_Liq. price = collateral price at which health hits 1.1x_");

  // ── "Cheaper than selling" wedge ──
  // Re-frame the user's mental model: their real alternative isn't another
  // loan, it's SELLING. Show the cost comparison.
  // Estimated memecoin sell slippage: assume 2% as a conservative midpoint.
  // (Long-tail tokens often 5%+, larger ones <1%; 2% is fair averaged.)
  const ESTIMATED_SELL_SLIPPAGE_PCT = 2.0;
  // "Hardest" tier — last in the resolved set (typically longest-term + lowest LTV
  // for memecoin = Standard; for RWA = RWA Standard at 70% LTV / 30d / 5% fee).
  const standardTier = resolved[resolved.length - 1];
  const standardGross = collateralValueSol * (standardTier.ltv / 100);
  const standardFee = standardGross * (standardTier.feeBps / 10_000);
  const sellSlippageCost = collateralValueSol * (ESTIMATED_SELL_SLIPPAGE_PCT / 100);
  // Side-by-side: "if you sold" vs "if you Magpie"
  lines.push(
    "",
    "*Why borrow instead of sell?*",
    `If you sold ${amount.toLocaleString()} $${token.symbol} now:`,
    `  • ~${ESTIMATED_SELL_SLIPPAGE_PCT}% slippage = *${sellSlippageCost.toFixed(4)} SOL gone*`,
    `  • Capital gains taxable event (jurisdiction-dependent)`,
    `  • You no longer hold the bag — miss any upside`,
    "",
    `If you borrow on Standard tier (${standardTier.ltv}% LTV):`,
    `  • Fee: *${standardFee.toFixed(4)} SOL* (${(standardTier.feeBps / 100).toFixed(2)}%)`,
    `  • You keep the full ${amount.toLocaleString()} $${token.symbol} bag`,
    `  • No taxable event`,
    "",
    `_Borrowing costs *${standardFee.toFixed(4)} SOL* vs selling's ${sellSlippageCost.toFixed(4)} SOL slippage alone (before tax). Keep your bag, take liquidity._`,
  );

  const { InlineKeyboard } = await import("grammy");
  const kb = new InlineKeyboard().text("💰 Borrow now", "start:borrow");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}
