/**
 * /supported — live list of accepted collateral with current SOL prices.
 *
 * Price fetches are parallelized; a single failure doesn't break the list.
 */
import { query } from "../db/pool.js";
import { getPriceInSol } from "../services/price.js";

export async function handleSupported(ctx) {
  const { rows } = await query(
    `SELECT mint, symbol, name, decimals FROM supported_mints
     WHERE enabled = TRUE ORDER BY symbol`,
  );
  if (rows.length === 0) {
    return ctx.reply("📭 No supported collateral mints right now.");
  }

  const prices = await Promise.all(
    rows.map((r) => getPriceInSol(r.mint).catch(() => null)),
  );

  const lines = ["🪙 *Supported collateral*", ""];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = prices[i];
    const priceStr = p != null ? `${p.toFixed(9)} SOL` : "_price unavailable_";
    lines.push(`• *${r.symbol}* ${r.name ? `— ${r.name}` : ""}`);
    lines.push(`  ${priceStr}`);
  }
  lines.push("", "Use /simulate to preview a loan.");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
