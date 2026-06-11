import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";

export async function handleDeposit(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  const msg = [
    "*Your Magpie wallet*",
    "",
    `\`${publicKey}\``,
    "",
    "Tap the address above to copy it, then send tokens from Phantom or Solflare.",
    "",
    "*What to send:*",
    "• Any supported memecoin (/supported to see the list)",
    "• ~0.01 SOL for transaction fees",
    "",
    "_Tokens arrive in under 30 seconds. Tap Borrow once they land._",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("Borrow now", "start:borrow")
    .row()
    .text("Supported tokens", "start:supported")
    .text("Home", "start:home");

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
}
