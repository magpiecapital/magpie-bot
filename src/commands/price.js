import { query } from "../db/pool.js";
import { getPriceInSol } from "../services/price.js";
import { getEligibleTiers } from "../services/loan-tier-resolver.js";

export async function handlePrice(ctx) {
  const arg = ctx.message?.text?.split(/\s+/)[1];
  if (!arg) {
    return ctx.reply("Usage: `/price <symbol or mint>`", { parse_mode: "Markdown" });
  }

  // Look up by symbol or by mint address. Category drives the loan-tier
  // resolver — RWA mints (stock/etf/metal) get the higher-LTV / longer-
  // term / higher-fee schedule out of rwa_loan_tiers; memecoin and
  // uncategorized fall through to the legacy MEMECOIN_TIERS.
  const { rows } = await query(
    `SELECT mint, symbol, name, decimals, category FROM supported_mints
     WHERE enabled = TRUE AND (UPPER(symbol) = UPPER($1) OR mint = $1)
     LIMIT 1`,
    [arg],
  );

  if (rows.length === 0) {
    return ctx.reply(
      `❌ \`${arg}\` is not a supported collateral token.`,
      { parse_mode: "Markdown" },
    );
  }

  const token = rows[0];
  try {
    const priceSol = await getPriceInSol(token.mint);
    const tiers = await getEligibleTiers({ category: token.category });
    const lines = [
      `💰 *${token.symbol}* — ${token.name ?? ""}`,
      `\`${token.mint}\``,
      "",
      `Price: ${priceSol.toFixed(9)} SOL`,
      "",
      "*Max loan per token:*",
    ];
    for (const t of tiers) {
      const loanPerToken = priceSol * (t.ltv / 100) * (1 - t.feeBps / 10_000);
      // Resolver-supplied label already includes LTV/days/fee for RWA;
      // memecoin label is just "Express"/"Quick"/"Standard". Compose
      // consistently either way.
      const stub = t.label.includes("LTV") ? t.label : `${t.label} (${t.ltv}% / ${t.days}d / ${(t.feeBps / 100).toFixed(1)}% fee)`;
      lines.push(`• ${stub}: ${loanPerToken.toFixed(9)} SOL`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.warn("[price] fetch failed:", err.message);
    await ctx.reply(
      [
        "⚠️ *Price feed briefly unavailable*",
        "",
        "Couldn't get a fresh price right now. Usually clears in 15-30 seconds.",
        "",
        "Try /price again in a moment.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }
}
