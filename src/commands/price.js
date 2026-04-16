import { query } from "../db/pool.js";
import { getPriceInSol } from "../services/price.js";

export async function handlePrice(ctx) {
  const arg = ctx.message?.text?.split(/\s+/)[1];
  if (!arg) {
    return ctx.reply("Usage: `/price <symbol or mint>`", { parse_mode: "Markdown" });
  }

  // Look up by symbol or by mint address.
  const { rows } = await query(
    `SELECT mint, symbol, name, decimals FROM supported_mints
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
    const tiers = [
      { ltv: 30, days: 2 },
      { ltv: 25, days: 3 },
      { ltv: 20, days: 7 },
    ];
    const lines = [
      `💰 *${token.symbol}* — ${token.name ?? ""}`,
      `\`${token.mint}\``,
      "",
      `Price: ${priceSol.toFixed(9)} SOL`,
      "",
      "*Max loan per token:*",
    ];
    for (const t of tiers) {
      const loanPerToken = priceSol * (t.ltv / 100) * 0.985; // 1.5% fee
      lines.push(`• ${t.ltv}% LTV / ${t.days}d: ${loanPerToken.toFixed(9)} SOL`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply(`❌ Could not fetch price: ${err.message}`);
  }
}
