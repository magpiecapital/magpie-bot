/**
 * /supported — top approved collateral tokens by liquidity, with live SOL prices.
 *
 * Two failure modes the previous implementation hit:
 *   1. Listing all 300+ approved tokens blew past Telegram's 4096-char limit.
 *   2. Firing 300 parallel Jupiter price calls instant-429s their rate limit.
 *
 * Fix: pull the top 25 by recorded liquidity, batch the price fetch into a
 * single Jupiter call (getPricesInSolBatch already exists for this), point
 * users at magpie.capital/tokens for the full list.
 */
import { query } from "../db/pool.js";
import { getPricesInSolBatch } from "../services/price.js";
import { InlineKeyboard } from "grammy";

const TOP_N = 25;

export async function handleSupported(ctx) {
  const { rows: top } = await query(
    `SELECT mint, symbol, name, decimals, liquidity_usd
       FROM supported_mints
      WHERE enabled = TRUE
      ORDER BY liquidity_usd DESC NULLS LAST, symbol
      LIMIT $1`,
    [TOP_N],
  );
  const { rows: [{ n: totalCount }] } = await query(
    `SELECT COUNT(*)::int AS n FROM supported_mints WHERE enabled = TRUE`,
  );

  if (top.length === 0) {
    return ctx.reply("📭 No supported collateral mints right now.");
  }

  // Batch price fetch — 1-2 Jupiter calls total instead of N per-mint calls.
  let priceMap;
  try {
    priceMap = await getPricesInSolBatch(top.map((r) => r.mint));
  } catch {
    priceMap = new Map();
  }

  const lines = [
    `🪙 *Top ${top.length} supported tokens* (of ${totalCount} approved)`,
    "",
    "Sorted by liquidity. Prices in SOL.",
    "",
  ];

  for (const r of top) {
    const p = priceMap.get(r.mint);
    const priceStr = p != null ? `${p.toFixed(9)} SOL` : "—";
    const liq = Number(r.liquidity_usd || 0);
    const liqStr = liq >= 1e6 ? `$${(liq / 1e6).toFixed(1)}M` : liq >= 1e3 ? `$${(liq / 1e3).toFixed(0)}K` : "";
    lines.push(`• *${r.symbol}*  \`${priceStr}\`  ${liqStr ? `_liq: ${liqStr}_` : ""}`);
  }

  lines.push("", `Full list of all ${totalCount} approved tokens: magpie.capital/tokens`);
  lines.push("Use /simulate to preview a loan or /borrow to take one.");

  const kb = new InlineKeyboard()
    .url("View all tokens", "https://www.magpie.capital/tokens")
    .row()
    .text("💰 Borrow", "start:borrow")
    .text("📋 Simulate", "fallback:simulate");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true });
}
