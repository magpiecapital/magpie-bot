import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";

export async function handleStart(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  const msg = [
    "🏦 *Welcome to BagBank*",
    "",
    "_Where your memecoin bags unlock SOL._",
    "",
    "Your custodial wallet is ready:",
    `\`${publicKey}\``,
    "",
    "Send memecoins here to use as collateral.",
    "",
    "*Commands*",
    "/deposit — show your deposit address",
    "/positions — view your active loans",
    "/borrow — take out a SOL loan",
    "/repay — repay an active loan",
    "/price — check a token's loan value",
    "/withdraw — withdraw SOL or tokens",
    "/export — export your private key (⚠️ custodial)",
    "/help — show this again",
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "Markdown" });
}
