import { InlineKeyboard } from "grammy";
import {
  PublicKey,
  SystemProgram,
  Transaction,
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
import { getDynamicPriorityFee } from "../solana/priority-fee.js";
import { sendWithPriorityAndConfirm } from "../solana/tx-send.js";
import { translateTxError, errorActionKeyboard } from "../services/tx-error-translator.js";
import { parseAmountInput, clampToMax } from "../lib/amount-input.js";

// Reserve for SOL withdraws so the wallet retains gas for at least one more
// outgoing tx after a "max" withdraw. Without this, a "max" SOL withdraw
// leaves the wallet with literally 0 lamports and any subsequent op fails.
const SOL_GAS_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL

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
      // Get the actual on-chain max for this asset BEFORE parsing input.
      // This is the integer source of truth — no display rounding involved.
      const signer = await loadKeypair(state.userId);
      let maxLamports = 0n;
      let decimals = 9;
      try {
        if (state.asset === "SOL") {
          const balance = BigInt(await connection.getBalance(signer.publicKey));
          // Reserve gas so a "max" doesn't strand the wallet
          maxLamports = balance > SOL_GAS_RESERVE_LAMPORTS ? balance - SOL_GAS_RESERVE_LAMPORTS : 0n;
          decimals = 9;
        } else {
          const mint = new PublicKey(state.asset);
          const tokenProgram = await getMintTokenProgram(state.asset);
          const mintInfo = await connection.getParsedAccountInfo(mint);
          decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
          const ata = getAssociatedTokenAddressSync(mint, signer.publicKey, false, tokenProgram);
          const ataInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
          maxLamports = ataInfo ? BigInt(ataInfo.value.amount) : 0n;
        }
      } catch (err) {
        console.error("[withdraw] balance lookup failed:", err.message);
        return ctx.reply(`❌ Couldn't read your ${state.asset === "SOL" ? "SOL" : "token"} balance right now. Try again in a moment.`);
      }

      if (maxLamports <= 0n) {
        pending.delete(ctx.chat.id);
        return ctx.reply(
          state.asset === "SOL"
            ? `❌ No SOL available to withdraw (after gas reserve).`
            : `❌ No tokens available to withdraw.`,
        );
      }

      // Parse the input — keywords like "max"/"all"/"50%" return EXACT integers
      const parsed = parseAmountInput(ctx.message.text, { maxLamports, decimals });
      if (parsed.kind === "invalid") {
        return ctx.reply(`❌ ${parsed.reason}. Try a number like \`0.5\`, or \`max\`/\`all\` to send everything.`, { parse_mode: "Markdown" });
      }

      // Hard clamp — submission can NEVER exceed actual on-chain balance
      const clamp = clampToMax(parsed.lamports, maxLamports);
      if (!clamp.ok) {
        const reqSol = (Number(clamp.lamports) / 10 ** decimals).toFixed(decimals === 9 ? 4 : Math.min(decimals, 6));
        const maxSol = (Number(clamp.max) / 10 ** decimals).toFixed(decimals === 9 ? 4 : Math.min(decimals, 6));
        return ctx.reply(
          [
            `❌ *Amount exceeds your balance*`,
            ``,
            `You asked for: \`${reqSol}\``,
            `You have:     \`${maxSol}\``,
            ``,
            `Try \`max\` (or \`all\`) to send everything, or a smaller amount.`,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
      }

      state.rawAmount = clamp.lamports; // exact integer, never re-derived from a float
      pending.delete(ctx.chat.id);

      try {
        const sig = await doWithdraw({
          ...state,
          rawAmount: clamp.lamports,
          decimals,
        });
        const displayAmount = (Number(clamp.lamports) / 10 ** decimals).toFixed(decimals === 9 ? 4 : Math.min(decimals, 6));
        await ctx.reply(
          `✅ Sent ${displayAmount} ${state.asset === "SOL" ? "SOL" : "tokens"}.\n[View tx](https://solscan.io/tx/${sig})`,
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

async function doWithdraw({ userId, asset, destination, rawAmount, decimals }) {
  // rawAmount is an exact BigInt of base units (lamports for SOL, raw token
  // amount for SPL). It came from clampToMax() against the live on-chain
  // balance, so over-sending is structurally impossible.
  const signer = await loadKeypair(userId);
  const dest = new PublicKey(destination);

  if (asset === "SOL") {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await getDynamicPriorityFee({ label: "tg-withdraw" }) }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: dest,
        lamports: rawAmount,
      }),
    );
    return sendWithPriorityAndConfirm(tx, [signer], {
    label: "tg-withdraw",
    feePayer: signer.publicKey,
    cuLimit: 200_000,
  });
  }

  // SPL token withdraw
  const mint = new PublicKey(asset);
  const tokenProgram = await getMintTokenProgram(asset);

  const fromAta = getAssociatedTokenAddressSync(mint, signer.publicKey, false, tokenProgram);
  const toAta = getAssociatedTokenAddressSync(mint, dest, false, tokenProgram);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await getDynamicPriorityFee({ label: "tg-withdraw" }) }),
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
  return sendWithPriorityAndConfirm(tx, [signer], {
    label: "tg-withdraw",
    feePayer: signer.publicKey,
    cuLimit: 200_000,
  });
}
