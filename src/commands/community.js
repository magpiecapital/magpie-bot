import { InlineKeyboard } from "grammy";

const COMMUNITY_URL = "https://t.me/magpietalk";
const COMMUNITY_HANDLE = "@magpietalk";

export async function handleCommunity(ctx) {
  const msg = [
    "💬 *Magpie Community Group*",
    "",
    `Join other Magpie users in our public group chat: ${COMMUNITY_HANDLE}`,
    "",
    "*Two Telegram surfaces — don't mix them up*",
    "",
    "1️⃣ *This bot* (@magpie\\_capital\\_bot)",
    "   • Your *private* 1:1 wallet — only you can see it",
    "   • Borrow, repay, withdraw, manage loans",
    "",
    "2️⃣ *The community group* (@magpietalk)",
    "   • *Public* chat — moderated, optional",
    "   • Discussion, questions, announcements",
    "   • Open to anyone, no wallet required",
    "",
    "⚠️ *Anyone else is a scammer*",
    "We will *never* DM you first. There is no \"Magpie Support\" DM account. We do not give out airdrops. If a stranger DMs you offering to help with your wallet — block and report them.",
  ].join("\n");

  const kb = new InlineKeyboard()
    .url("💬 Join @magpietalk", COMMUNITY_URL);

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}
