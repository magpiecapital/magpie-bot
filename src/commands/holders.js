/**
 * /holders — $MAGPIE holder dashboard inside Telegram.
 *
 * Holders earn a share of every loan fee (currently 10%; MGP-001 proposes
 * 70%) distributed AUTOMATICALLY on a randomized cadence as SOL directly
 * to their wallet. No claim button — the bot sends SOL during the
 * snapshot itself.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import {
  getHolderInfoByWallet,
  getHolderPoolState,
  HOLDER_REWARD_BPS,
} from "../services/magpie-holder-rewards.js";

const MAGPIE_PUMP_URL = "https://pump.fun/coin/9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}

function fmtMagpie(rawAmount) {
  const n = Number(rawAmount) / 1e6;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export async function handleHolders(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const wallet = await ensureWallet(user.id);

  const [info, pool] = await Promise.all([
    getHolderInfoByWallet(wallet.publicKey),
    getHolderPoolState(),
  ]);

  const pct = (HOLDER_REWARD_BPS / 100).toFixed(0);
  const lines = [
    "*$MAGPIE Holder Rewards*",
    "",
    `*${pct}% of every loan fee* is auto-distributed to $MAGPIE holders. SOL hits your wallet directly — no claim, no signing.`,
    "",
    "*Your Magpie wallet:*",
    `\`${wallet.publicKey}\``,
    "",
    `Balance: *${fmtMagpie(info.balance_raw)} MAGPIE*`,
    "",
    "*Your rewards:*",
    `• Lifetime received: \`${fmtSol(info.paid_lamports)} SOL\``,
    `• Distributions received: ${info.distributions_count}`,
  ];

  if (info.estimated_next_payout_lamports > 0n) {
    lines.push(
      `• Est. next payout: \`~${fmtSol(info.estimated_next_payout_lamports)} SOL\` (based on current pool)`,
    );
  }
  lines.push(
    "",
    "*Current pool (accruing):*",
    `\`${fmtSol(pool.accrued_lamports)} SOL\` waiting for the next snapshot.`,
    "",
    "_Snapshots happen periodically. Hold $MAGPIE consistently — the longer you're in, the more snapshots you'll catch._",
  );

  if (!info.has_balance) {
    lines.push(
      "",
      "_Hold $MAGPIE in this wallet to start earning. SOL is sent automatically each week — no action needed on your end._",
    );
  }
  if (info.pending_lamports > 0n) {
    lines.push(
      "",
      `*Pending payout:* \`${fmtSol(info.pending_lamports)} SOL\` from a previous distribution will be retried automatically.`,
    );
  }

  const kb = new InlineKeyboard();
  if (!info.has_balance) {
    kb.url("Buy $MAGPIE on pump.fun", MAGPIE_PUMP_URL).row();
  }
  kb.text("Home", "start:home");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}

export function registerHoldersCallbacks(_bot) {
  // No callbacks anymore — distribution is fully automatic.
  // Function kept for backwards compatibility with index.js registration.
}
