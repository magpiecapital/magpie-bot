import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getOrCreateCode, attribute } from "../services/referrals.js";
import { getPrefs } from "../services/prefs.js";

export async function handleStart(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return ctx.reply("Could not identify user.");

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  // Ensure prefs row + referral code exist on first /start.
  await getPrefs(user.id);
  await getOrCreateCode(user.id);

  // If launched via `t.me/botname?start=CODE`, attribute the new user.
  // grammY exposes the argument as ctx.match.
  const refArg = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (refArg) {
    const referrer = await attribute(user.id, refArg);
    if (referrer) {
      await ctx.api
        .sendMessage(
          referrer.telegram_id,
          `🎉 *New referral*\n\n@${tgUser.username ?? "someone"} just joined BagBank using your code.`,
          { parse_mode: "Markdown" },
        )
        .catch(() => {});
    }
  }

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
    "*Get started*",
    "/supported — see what collateral is accepted",
    "/simulate — preview a loan with live prices",
    "/borrow — take out a SOL loan",
    "/me — your wallet, tier, and referral code",
    "/help — full command list",
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "Markdown" });
}
