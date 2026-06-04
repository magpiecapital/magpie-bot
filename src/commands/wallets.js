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
import { listWallets, setActiveWallet, renameWallet, MAX_WALLETS_PER_USER } from "../services/wallet.js";
import { connection } from "../solana/connection.js";

// Tracks chat sessions waiting for the user to send a wallet's new name.
// Keyed by chat id, value is the walletId being renamed. We clear on
// receipt or on /cancel.
const renameAwaiting = new Map();
// Max label length matches the renameWallet() service-layer trim. Keep
// in sync if that changes.
const MAX_LABEL_LEN = 40;

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
    // Per-wallet row of action buttons. Active wallet only shows
    // [Rename] (no need to "switch to" the active one).
    if (w.isActive) {
      kb.text(`✏️ Rename ${w.label}`, `wallets:rename:${w.id}`).row();
    } else {
      kb
        .text(`Use ${w.label}`, `wallets:switch:${w.id}`)
        .text(`✏️ Rename`, `wallets:rename:${w.id}`)
        .row();
    }
  }

  lines.push("_To add a new wallet, run /import. Your existing wallets stay intact — switch back any time._");
  lines.push("_Tap ✏️ Rename next to any wallet to give it a custom name._");

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

  // Prompt the user for a new label for the chosen wallet. We stash the
  // walletId in the awaiting map and the text-message middleware below
  // picks up the user's next message as the new name.
  bot.callbackQuery(/^wallets:rename:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    renameAwaiting.set(ctx.chat.id, walletId);
    await ctx.reply(
      [
        "✏️ *Rename wallet*",
        "",
        `Send the new name as your next message (max ${MAX_LABEL_LEN} chars).`,
        "",
        "_Send /cancel to abort._",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // Capture the user's reply with the new label.
  bot.on("message:text", async (ctx, next) => {
    if (!renameAwaiting.has(ctx.chat.id)) return next();

    const walletId = renameAwaiting.get(ctx.chat.id);
    const raw = ctx.message.text.trim();

    if (raw === "/cancel" || raw.toLowerCase() === "cancel") {
      renameAwaiting.delete(ctx.chat.id);
      return ctx.reply("Rename cancelled.");
    }
    // Reject if they accidentally typed a slash command — let it fall through
    // so the command actually runs, and abandon the rename.
    if (raw.startsWith("/")) {
      renameAwaiting.delete(ctx.chat.id);
      return next();
    }

    renameAwaiting.delete(ctx.chat.id);

    const newLabel = raw.slice(0, MAX_LABEL_LEN);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    try {
      await renameWallet(user.id, walletId, newLabel);
    } catch (err) {
      return ctx.reply(`Couldn't rename: ${err.message?.slice(0, 100)}`);
    }
    await ctx.reply(`✅ Renamed to *${newLabel}*`, { parse_mode: "Markdown" });
    // Re-render the wallets list so they see the new name + can keep going.
    await handleWallets(ctx);
  });
}
