import { InlineKeyboard } from "grammy";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { upsertUser } from "../services/users.js";
import { ensureWallet, loadKeypair } from "../services/wallet.js";
import { getSupportedBalances, getSolBalance } from "../services/deposits.js";
import { connection } from "../solana/connection.js";
import { translateTxError, errorActionKeyboard } from "../services/tx-error-translator.js";

const pending = new Map();

/**
 * Clear any in-progress withdraw state for a chat. The withdraw flow's
 * message:text middleware is the "greediest" of the bot — it claims any
 * text message as long as a state exists, which can hijack a user's
 * pasted private key during /import. Sibling commands call this to
 * defensively reset before starting their own paste-capture flow.
 */
export function clearPending(chatId) {
  pending.delete(chatId);
}

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

async function getMintTokenProgram(mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`Mint ${mint} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

export async function handleWithdraw(ctx) {
  const user = await upsertUser(ctx.from.id, ctx.from.username);
  const { publicKey } = await ensureWallet(user.id);

  const [sol, balances] = await Promise.all([
    getSolBalance(publicKey),
    getSupportedBalances(publicKey),
  ]);

  const kb = new InlineKeyboard();
  if (sol > 0) {
    kb.text(`SOL (${fmtSol(sol)})`, "wd:asset:SOL").row();
  }
  for (const b of balances) {
    kb.text(
      `${b.symbol} (${b.humanAmount.toLocaleString()})`,
      `wd:asset:${b.mint}`,
    ).row();
  }
  if (kb.inline_keyboard.length === 0) {
    return ctx.reply("📭 Nothing to withdraw.");
  }
  kb.text("✕ Cancel", "wd:cancel");

  await ctx.reply("*Pick an asset to withdraw:*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

export function registerWithdrawCallbacks(bot) {
  bot.callbackQuery(/^wd:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Withdraw cancelled.");
  });

  bot.callbackQuery(/^wd:asset:(.+)$/, async (ctx) => {
    const asset = ctx.match[1];
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    pending.set(ctx.chat.id, { userId: user.id, asset, stage: "await_destination" });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Reply with the *destination address* (Solana pubkey).\nThen reply with the *amount* to send.`,
      { parse_mode: "Markdown" },
    );
  });

  // Two-step message listener: destination → amount.
  // Only claim the message if we're actively expecting input — otherwise
  // call next() so a leftover state doesn't hijack messages meant for
  // other flows (e.g. /import paste).
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || (state.stage !== "await_destination" && state.stage !== "await_amount")) {
      return next();
    }

    if (state.stage === "await_destination") {
      try {
        state.destination = new PublicKey(ctx.message.text.trim()).toBase58();
      } catch {
        return ctx.reply("❌ Invalid Solana address. Try again or /withdraw to restart.");
      }
      state.stage = "await_amount";
      pending.set(ctx.chat.id, state);
      return ctx.reply(`Destination: \`${state.destination}\`\n\nReply with the amount.`, {
        parse_mode: "Markdown",
      });
    }

    if (state.stage === "await_amount") {
      const amount = Number(ctx.message.text.trim());
      if (!Number.isFinite(amount) || amount <= 0) {
        return ctx.reply("❌ Invalid amount.");
      }
      state.amount = amount;
      pending.delete(ctx.chat.id);

      try {
        const sig = await doWithdraw(state);
        await ctx.reply(
          `✅ Sent ${amount} ${state.asset === "SOL" ? "SOL" : "tokens"}.\n[View tx](https://solscan.io/tx/${sig})`,
          { parse_mode: "Markdown", disable_web_page_preview: true },
        );
      } catch (err) {
        console.error("Withdraw failed:", err);
        const friendly = translateTxError(err, { flow: "withdraw" });
        await ctx.reply(friendly, {
          parse_mode: "Markdown",
          reply_markup: errorActionKeyboard({ flow: "withdraw", errorKind: "tx_error" }),
        });
      }
      return;
    }
  });
}

async function doWithdraw({ userId, asset, destination, amount }) {
  const signer = await loadKeypair(userId);
  const dest = new PublicKey(destination);

  if (asset === "SOL") {
    const lamports = BigInt(Math.floor(amount * 1e9));
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: dest,
        lamports,
      }),
    );
    return sendAndConfirmTransaction(connection, tx, [signer]);
  }

  // SPL token withdraw
  const mint = new PublicKey(asset);
  const tokenProgram = await getMintTokenProgram(asset);
  const mintInfo = await connection.getParsedAccountInfo(mint);
  const decimals = mintInfo.value.data.parsed.info.decimals;
  const rawAmount = BigInt(Math.floor(amount * 10 ** decimals));

  const fromAta = getAssociatedTokenAddressSync(mint, signer.publicKey, false, tokenProgram);
  const toAta = getAssociatedTokenAddressSync(mint, dest, false, tokenProgram);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      toAta,
      dest,
      mint,
      tokenProgram,
    ),
    createTransferCheckedInstruction(
      fromAta,
      mint,
      toAta,
      signer.publicKey,
      rawAmount,
      decimals,
      [],
      tokenProgram,
    ),
  );
  return sendAndConfirmTransaction(connection, tx, [signer]);
}
