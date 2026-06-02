/**
 * /magpie — show the official $MAGPIE token contract address + pump.fun link.
 *
 * Single source of truth: the constants below are the only place in the bot
 * that names the $MAGPIE mint. If we ever swap tokens or update the link,
 * change here.
 */
import { InlineKeyboard } from "grammy";

export const MAGPIE_MINT = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";
export const MAGPIE_PUMP_URL = `https://pump.fun/coin/${MAGPIE_MINT}`;

export async function handleMagpie(ctx) {
  const msg = [
    "✨ *$MAGPIE*",
    "",
    "The official protocol token.",
    "",
    "*Contract address:*",
    `\`${MAGPIE_MINT}\``,
    "",
    "Tap the address above to copy it.",
  ].join("\n");

  const kb = new InlineKeyboard()
    .url("Buy on pump.fun", MAGPIE_PUMP_URL)
    .row()
    .url("View on Solscan", `https://solscan.io/token/${MAGPIE_MINT}`);

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}
