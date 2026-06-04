/**
 * /wallets — list all of the user's wallets + toggle the active one.
 *
 * Users can hold N wallets (their Magpie custodial wallet plus any
 * they've imported). One is "active" at a time and signs every tx.
 * This command shows the full list with the active one flagged, and
 * lets them switch with a single tap.
 */
import { PublicKey } from "@solana/web3.js";
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { listWallets, setActiveWallet, MAX_WALLETS_PER_USER } from "../services/wallet.js";
import { connection } from "../solana/connection.js";

function shortPubkey(pk) {
  if (!pk) return "?";
  return `${pk.slice(0, 6)}…${pk.slice(-6)}`;
}

async function fetchBalances(pubkeys) {
  // Best-effort: fetch SOL balance for each wallet so the list shows
  // useful info. If any single one fails we just show "?" for that row.
  return Promise.all(
    pubkeys.map(async (pk) => {
      try {
        const lamports = await connection.getBalance(new PublicKey(pk));
        return lamports / 1e9;
      } catch {
        return null;
      }
    }),
  );
}

export async function handleWallets(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const wallets = await listWallets(user.id);
  if (wallets.length === 0) {
    return ctx.reply("You don't have any wallets yet. Run /start to set one up.");
  }

  const balances = await fetchBalances(wallets.map((w) => w.publicKey));

  const lines = [
    `💼 *Your wallets* (${wallets.length}/${MAX_WALLETS_PER_USER})`,
    "",
    "_The wallet marked ✅ is signing all your transactions right now. Tap any other wallet below to switch — your loans stay tied to whichever wallet opened them._",
    "",
  ];

  const kb = new InlineKeyboard();
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const bal = balances[i];
    const balStr = bal == null ? "balance unavailable" : `${bal.toFixed(4)} SOL`;
    const flag = w.isActive ? "✅ *Active*" : "⚪️";
    lines.push(`${flag} *${w.label}* — \`${shortPubkey(w.publicKey)}\``);
    lines.push(`   _${w.source === "custodial" ? "Magpie-generated" : "Imported"} · ${balStr}_`);
    lines.push("");
    if (!w.isActive) {
      kb.text(`Use ${w.label} (${shortPubkey(w.publicKey)})`, `wallets:switch:${w.id}`).row();
    }
  }

  lines.push("_To add a new wallet, run /import. Your existing wallets stay intact — switch back any time._");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb }).catch(async () => {
    // Markdown fallback for edge cases (e.g. pubkeys with reserved chars)
    await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), { reply_markup: kb });
  });
}

export function registerWalletsCallbacks(bot) {
  bot.callbackQuery(/^wallets:switch:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    try {
      await setActiveWallet(user.id, walletId);
    } catch (err) {
      return ctx.reply(`Couldn't switch: ${err.message?.slice(0, 100)}`);
    }
    // Re-render the list to show the new active state
    await handleWallets(ctx);
  });
}
