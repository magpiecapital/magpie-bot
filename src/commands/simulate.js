/**
 * /simulate <symbol|mint> <amount> [tier]
 *
 * Previews what a loan would look like before the user commits. Read-only;
 * no wallet, no DB writes, no on-chain calls.
 */
import { query } from "../db/pool.js";
import { getPriceInSol } from "../services/price.js";

const TIERS = {
  1: { ltv: 30, days: 2, feeBps: 300, label: "Express" },
  2: { ltv: 25, days: 3, feeBps: 200, label: "Quick" },
  3: { ltv: 20, days: 7, feeBps: 150, label: "Standard" },
};

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
    `SELECT mint, symbol, name, decimals FROM supported_mints
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
    return ctx.reply(`❌ Could not fetch price: ${err.message}`);
  }

  const collateralValueSol = amount * priceSol;

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
    lines.push(
      `*${t.ltv}% LTV · ${t.days}d (${t.label})*`,
      `  Receive:     ${receive.toFixed(6)} SOL`,
      `  Repay:       ${gross.toFixed(6)} SOL`,
      `  Liq. price:  ${liquidationPriceSol.toFixed(9)} SOL/token`,
      "",
    );
  }
  lines.push("_Liq. price = collateral price at which health hits 1.1x_");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
