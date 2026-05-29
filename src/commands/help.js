import { InlineKeyboard } from "grammy";
import { isAdmin } from "../services/admin.js";

export async function handleHelp(ctx) {
  const lines = [
    "🪶 *Magpie — Command List*",
    "",
    "*Navigation*",
    "/home — main menu",
    "/help — this page",
    "",
    "*Tokens & Discovery*",
    "/supported — approved tokens with live market data",
    "/risk `<symbol|mint>` — risk profile, liquidity, holders",
    "/price `<symbol|mint>` — live price",
    "/submit `<mint|symbol>` — propose a token for screening",
    "",
    "*Account*",
    "/me — your wallet, tier, stats, referral code",
    "/credit — your 300-850 credit score",
    "/wallet — show your Magpie wallet address",
    "/import — import an existing Solana wallet",
    "/export — export your private key (⚠️ custodial)",
    "/notify — manage notification preferences",
    "",
    "*Stats*",
    "/stats — protocol-wide stats",
    "/simulate `<symbol> <amount>` — what-if loan calculator (when lending returns)",
    "",
    "*Lending (currently paused)*",
    "/deposit, /withdraw, /topup, /borrow, /repay, /partialrepay,",
    "/extend, /reborrow, /lend, /positions, /history",
    "_Will be reactivated when the on-chain protocol returns._",
  ];

  if (isAdmin(ctx.from?.id)) {
    lines.push(
      "",
      "*Admin*",
      "/pause, /resume — toggle features (when lending is back)",
      "/adminstatus — system overview",
      "/enablemint `<mint> <symbol> <decimals> [name]`",
      "/disablemint `<symbol|mint>`",
      "/broadcast `<message>` — DM everyone",
      "/reviewtokens — review auto-screened borderline tokens",
    );
  }

  const kb = new InlineKeyboard()
    .text("🏠 Home", "start:home")
    .text("📋 Supported", "start:supported");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb });
}
