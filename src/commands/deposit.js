import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";

export async function handleDeposit(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  const msg = [
    "💰 *Your deposit address*",
    "",
    `\`${publicKey}\``,
    "",
    "Send any SPL memecoin here to use as collateral.",
    "Also send a small amount of SOL (~0.01) to cover transaction fees.",
    "",
    "Once deposited, use /borrow to take out a SOL loan.",
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "Markdown" });
}
