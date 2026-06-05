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
import {
  listWallets, setActiveWallet, renameWallet, removeWallet,
  CannotRemoveActiveWalletError, WalletHasActiveLoansError,
  MAX_WALLETS_PER_USER,
} from "../services/wallet.js";
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
    "_Tap any wallet below to see its details and switch to it. The ✅ marks the one signing your transactions right now._",
    "",
  ];

  // EVERY wallet gets a button (including the active one). Tapping any
  // wallet opens a detail card with full address + balance + actions.
  // This keeps the list consistent regardless of which one is active
  // and ensures no wallet is "hidden" without a button — critical for
  // accounts with many wallets.
  const kb = new InlineKeyboard();
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const bal = balances[i];
    const balStr = bal == null ? "?" : `${bal.toFixed(2)} SOL`;
    // Body line per wallet
    const flag = w.isActive ? "✅" : "⚪️";
    lines.push(`${flag} *${w.label}* — \`${shortPubkey(w.publicKey)}\` · ${balStr}`);
    // One button per wallet, label includes balance for at-a-glance scan
    const btnLabel = w.isActive
      ? `✅ ${w.label} · ${balStr}`
      : `${w.label} · ${balStr}`;
    kb.text(btnLabel, `wallets:view:${w.id}`).row();
  }
  lines.push("");

  // Secondary actions row at the bottom — small, demoted, doesn't compete
  // with the per-wallet buttons. Hide the Import button if user is at
  // the per-account cap so we don't lead them into an error.
  const atCap = wallets.length >= MAX_WALLETS_PER_USER;
  if (atCap) {
    kb.text("✏️ Rename a wallet", "wallets:rename_picker").row();
  } else {
    kb
      .text("➕ Import wallet", "wallets:import")
      .text("✏️ Rename", "wallets:rename_picker")
      .row();
  }

  lines.push(
    atCap
      ? `_You're at the ${MAX_WALLETS_PER_USER}-wallet cap. Reach out via /support if you need a slot freed._`
      : "_Tap ➕ Import wallet to add another. Your existing wallets stay intact — switch back any time._",
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb }).catch(async () => {
    // Markdown fallback for edge cases (e.g. pubkeys with reserved chars)
    await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), { reply_markup: kb });
  });
}

/**
 * Render the wallet DETAIL view for a single wallet. Called when the user
 * taps a wallet button on the main /wallets list. Shows full address,
 * source, balance, active status, and contextual actions (switch, rename,
 * back to list).
 */
async function renderWalletDetail(ctx, walletId) {
  const user = await upsertUser(ctx.from.id, ctx.from.username);
  const wallets = await listWallets(user.id);
  // Postgres BIGSERIAL ids come back as strings; the callback regex
  // captures a numeric substring. Compare via String() to be safe.
  const w = wallets.find((x) => String(x.id) === String(walletId));
  if (!w) return ctx.reply("That wallet isn't in your account anymore. Try /wallets again.");

  let balanceSol = null;
  try {
    const lamports = await connection.getBalance(new PublicKey(w.publicKey), "confirmed");
    balanceSol = (lamports / 1e9).toFixed(4);
  } catch { /* best-effort */ }

  const lines = [
    `*${w.label}*`,
    "",
    `Address: \`${w.publicKey}\``,
    `Source: ${w.source === "custodial" ? "Magpie-generated" : "Imported"}`,
    `Balance: ${balanceSol == null ? "_balance unavailable_" : `${balanceSol} SOL`}`,
    "",
    w.isActive
      ? "Status: ✅ *Currently active* — all your transactions sign from this wallet right now."
      : "Status: ⚪️ Not active",
  ];

  const kb = new InlineKeyboard();
  if (!w.isActive) {
    kb.text(`🔁 Switch to ${w.label}`, `wallets:confirm_switch:${w.id}`).row();
  }
  kb.text("✏️ Rename this wallet", `wallets:rename:${w.id}`).row();
  // Remove is only offered for non-active wallets. The service layer
  // also blocks removal if the wallet has active loans tied to it,
  // surfaced via the confirm step below.
  if (!w.isActive) {
    kb.text("🗑 Remove from account", `wallets:confirm_remove:${w.id}`).row();
  }
  kb.text("← Back to wallets", "wallets:back");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb })
    .catch(async () => {
      await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), { reply_markup: kb });
    });
}

export function registerWalletsCallbacks(bot) {
  // Tap a wallet on the main /wallets list → opens detail view.
  bot.callbackQuery(/^wallets:view:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    await renderWalletDetail(ctx, walletId);
  });

  // From the detail view, tap "Switch to X" → confirm via a small prompt
  // before flipping the active wallet. Two-step is intentional: it gives
  // the user a moment to verify they tapped the right one and avoids
  // accidental switches that would surface as cryptic ConstraintHasOne
  // errors on their next loan action.
  bot.callbackQuery(/^wallets:confirm_switch:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const wallets = await listWallets(user.id);
    // Postgres BIGSERIAL ids come back as strings; the callback regex
  // captures a numeric substring. Compare via String() to be safe.
  const w = wallets.find((x) => String(x.id) === String(walletId));
    if (!w) return ctx.reply("That wallet isn't in your account anymore. Try /wallets again.");
    if (w.isActive) {
      try { await ctx.editMessageText(`${w.label} is already your active wallet.`); } catch {}
      return;
    }
    const lines = [
      `*Switch active wallet?*`,
      "",
      `You're about to switch your active wallet to:`,
      `*${w.label}*`,
      `\`${w.publicKey}\``,
      "",
      `All your *new* transactions will sign from this wallet. Existing loans stay tied to the wallet that opened them — you can switch back any time.`,
    ];
    const kb = new InlineKeyboard()
      .text(`Yes, switch to ${w.label}`, `wallets:do_switch:${w.id}`)
      .row()
      .text("Cancel", `wallets:view:${w.id}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb })
      .catch(async () => {
        await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), { reply_markup: kb });
      });
  });

  // Final step — actually performs the switch and re-renders the wallets list.
  bot.callbackQuery(/^wallets:do_switch:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Switched");
    const walletId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    try {
      await setActiveWallet(user.id, walletId);
    } catch (err) {
      return ctx.reply(`Couldn't switch: ${err.message?.slice(0, 100)}`);
    }
    await handleWallets(ctx);
  });

  // Back-to-list button from the wallet detail view.
  bot.callbackQuery("wallets:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleWallets(ctx);
  });

  // Confirm step before removing a wallet — irreversible action gets
  // a hard prompt. The service layer's safety guards (can't remove
  // active wallet, can't remove wallet with active loans) are still
  // the ultimate gate, but we surface a friendly confirm here first.
  bot.callbackQuery(/^wallets:confirm_remove:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const wallets = await listWallets(user.id);
    const w = wallets.find((x) => String(x.id) === String(walletId));
    if (!w) return ctx.reply("That wallet isn't in your account anymore. Try /wallets again.");
    if (w.isActive) {
      return ctx.reply("Can't remove the active wallet. Switch to a different wallet first, then remove this one.");
    }
    const lines = [
      "🗑 *Remove this wallet from your account?*",
      "",
      `*${w.label}*`,
      `\`${w.publicKey}\``,
      "",
      "What this does:",
      "• Frees up a slot under the 10-wallet cap so you can /import a different wallet.",
      "• Removes the bot's stored access — you'll lose bot signing for this wallet.",
      "• Does *not* affect on-chain funds. The wallet still exists; the bot just stops using it.",
      "• If you have the wallet's private key elsewhere, you can /import it back any time.",
      "",
      "Blocked automatically if this wallet has any active on-chain loans tied to it.",
    ];
    const kb = new InlineKeyboard()
      .text(`Yes, remove ${w.label}`, `wallets:do_remove:${w.id}`)
      .row()
      .text("Cancel", `wallets:view:${w.id}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb })
      .catch(async () => {
        // Markdown fallback for edge-case pubkeys
        await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), { reply_markup: kb });
      });
  });

  // Execute the removal after confirm.
  bot.callbackQuery(/^wallets:do_remove:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    try {
      await removeWallet(user.id, walletId);
    } catch (err) {
      if (err instanceof CannotRemoveActiveWalletError) {
        return ctx.reply("⚠️ Can't remove the active wallet. Switch to a different wallet first via /wallets.");
      }
      if (err instanceof WalletHasActiveLoansError) {
        return ctx.reply(
          [
            "⚠️ *Can't remove — active loans on this wallet*",
            "",
            `This wallet is the on-chain borrower on ${err.loanPdas.length} active loan(s). Removing it would orphan them — the bot wouldn't be able to sign repayments.`,
            "",
            "*To proceed*, either:",
            "1. /repay or /partialrepay the loans first, then come back and remove the wallet",
            "2. Keep this wallet so you can repay when ready",
            "",
            "_If you absolutely need to free a slot now and accept losing access to those loans, reach out via /support and we can do it manually with full diagnosis._",
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      }
      console.error("[wallets] remove failed:", err.message);
      return ctx.reply(`Couldn't remove that wallet right now: ${err.message?.slice(0, 100)}. Try again in a moment.`);
    }
    await ctx.reply(`✅ Wallet removed. You now have a free slot to /import a different wallet.`);
    // Re-render the list so they see the updated state immediately.
    await handleWallets(ctx);
  });

  // Legacy callback retained: some older messages (post-import success,
  // AI agent shortcuts, etc.) still emit wallets:switch:{id}. Route those
  // to the detail view so the user can confirm rather than insta-switching.
  bot.callbackQuery(/^wallets:switch:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = Number(ctx.match[1]);
    await renderWalletDetail(ctx, walletId);
  });

  // Step 1 of rename — show a picker so the user chooses WHICH wallet
  // to rename. Cleaner than per-row rename buttons cluttering the main list.
  bot.callbackQuery("wallets:rename_picker", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const wallets = await listWallets(user.id);
    if (wallets.length === 0) return ctx.reply("You have no wallets yet — run /start to set one up.");

    const lines = [
      "✏️ *Rename a wallet*",
      "",
      "Pick which wallet to rename:",
    ];
    const kb = new InlineKeyboard();
    for (const w of wallets) {
      kb.text(`${w.label} (${shortPubkey(w.publicKey)})`, `wallets:rename:${w.id}`).row();
    }
    kb.text("Cancel", "wallets:rename_cancel");

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb });
  });

  bot.callbackQuery("wallets:rename_cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    try { await ctx.editMessageText("Rename cancelled."); } catch { /* non-critical */ }
  });

  // Shortcut into /import directly from the /wallets screen so users
  // don't have to remember the command name.
  bot.callbackQuery("wallets:import", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { handleImport } = await import("./import-wallet.js");
    await handleImport(ctx);
  });

  // Step 2 of rename — user picked a wallet from the picker. Prompt
  // them for the new label. The text-message middleware below picks up
  // their reply as the new name.
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
