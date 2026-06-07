import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";
import { getTokenBalance } from "../services/deposits.js";
import { executeAddCollateral, recordAddCollateral, checkLoanOwnership } from "../services/loans.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";
import { translateTxError, errorActionKeyboard, renderWalletMismatchMessage } from "../services/tx-error-translator.js";

const pending = new Map();

function fmtAmount(raw, decimals) {
  return Number(BigInt(raw)) / Math.pow(10, decimals);
}

export async function handleTopup(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT l.*, sm.symbol, sm.decimals
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply("📭 No active loans. Use /borrow to open one.");
  }

  // Scope to active wallet (multi-wallet users were seeing loans they
  // couldn't sign for).
  const { filtered: scopedRows, otherWalletCount } =
    await scopeLoansToActiveWallet(user.id, rows);

  if (scopedRows.length === 0) {
    return ctx.reply(
      `📭 No active loans on your *current* wallet.\n\n` +
      (otherWalletCount > 0
        ? `You have *${otherWalletCount}* loan${otherWalletCount === 1 ? "" : "s"} on other linked wallets. Use /wallets to switch first.`
        : `Use /borrow to open one.`),
      { parse_mode: "Markdown" },
    );
  }

  const kb = new InlineKeyboard();
  for (const loan of scopedRows) {
    const human = fmtAmount(loan.collateral_amount, loan.decimals ?? 9);
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · ${human.toLocaleString()}`,
      `topup:loan:${loan.id}`,
    ).row();
  }
  kb.text("✕ Cancel", "topup:cancel");

  const header = `*Add collateral* (improves health ratio, no fee)\n\nPick a loan:` +
    (otherWalletCount > 0
      ? `\n_Showing loans on your active wallet. ${otherWalletCount} more on other wallets — /wallets to switch._`
      : "");
  await ctx.reply(header, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerTopupCallbacks(bot) {
  bot.callbackQuery(/^topup:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Top-up cancelled.");
  });

  bot.callbackQuery(/^topup:loan:(\d+)$/, async (ctx) => {
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { publicKey } = await ensureWallet(user.id);

    const { rows } = await query(
      `SELECT l.*, sm.symbol, sm.decimals
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.id = $1 AND l.user_id = $2 AND l.status = 'active'`,
      [loanDbId, user.id],
    );
    const loan = rows[0];
    if (!loan) {
      await ctx.answerCallbackQuery("Loan not found");
      return;
    }

    const balance = await getTokenBalance(publicKey, loan.collateral_mint);
    if (!balance || BigInt(balance.rawAmount) === 0n) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `📭 No ${loan.symbol ?? "tokens"} in your wallet to add as collateral.\n\nDeposit to:\n\`${publicKey}\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    pending.set(ctx.chat.id, { userId: user.id, loan, balance });

    const kb = new InlineKeyboard()
      .text("25%", "topup:pct:25").text("50%", "topup:pct:50")
      .text("75%", "topup:pct:75").text("100%", "topup:pct:100")
      .row().text(`✏️ Custom ${loan.symbol ?? ""} amount`.trim(), "topup:custom")
      .row().text("✕ Cancel", "topup:cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
        `Current collateral: ${fmtAmount(loan.collateral_amount, loan.decimals ?? 9).toLocaleString()}`,
        `Wallet balance: ${balance.humanAmount.toLocaleString()} ${loan.symbol ?? ""}`,
        "",
        "*How much to add?*",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  // Custom amount entry — user taps "Custom amount" → types a token
  // amount (e.g. 1500 BONK). Same text-middleware pattern /borrow uses.
  bot.callbackQuery("topup:custom", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state) { await ctx.answerCallbackQuery("Session expired"); return; }
    state.stage = "await_custom";
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Loan #${state.loan.loan_id} · ${state.loan.symbol ?? "?"}`,
        `Wallet balance: ${state.balance.humanAmount.toLocaleString()} ${state.loan.symbol ?? ""}`,
        "",
        `Type the amount of ${state.loan.symbol ?? "tokens"} to add as collateral:`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || state.stage !== "await_custom") return next();
    const raw = ctx.message.text.trim().replace(/,/g, "");
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.reply("Please enter a positive number.");
    }
    if (amount > state.balance.humanAmount) {
      return ctx.reply(
        `That's more than your wallet balance of ${state.balance.humanAmount.toLocaleString()} ${state.loan.symbol ?? ""}. Try a smaller amount.`,
      );
    }
    const decimals = state.loan.decimals ?? 9;
    const rawBig = BigInt(Math.floor(amount * Math.pow(10, decimals)));
    if (rawBig === 0n) {
      return ctx.reply("Amount rounds to zero at the token's decimals — try a larger amount.");
    }
    delete state.stage;
    pending.set(ctx.chat.id, state);
    await submitTopup(ctx, state, rawBig);
  });

  bot.callbackQuery(/^topup:pct:(\d+)$/, async (ctx) => {
    const pct = Number(ctx.match[1]);
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired, run /topup again");
      return;
    }

    const rawBig = (BigInt(state.balance.rawAmount) * BigInt(pct)) / 100n;
    if (rawBig === 0n) {
      await ctx.answerCallbackQuery("Amount too small");
      return;
    }

    await ctx.answerCallbackQuery();
    await submitTopup(ctx, state, rawBig);
  });
}

/**
 * Shared execute path — used by both the pct quick-buttons and the
 * custom-amount entry. Centralizing the financial-critical code so the
 * two entry paths can't diverge. Caller must clamp to wallet balance.
 */
async function submitTopup(ctx, state, rawBig) {
  if (rawBig <= 0n) return ctx.reply("Amount too small.");

  // Re-clamp defensively against wallet balance.
  const balanceRaw = BigInt(state.balance.rawAmount);
  if (rawBig > balanceRaw) rawBig = balanceRaw;
  if (rawBig <= 0n) return ctx.reply("Amount too small.");

  // Pre-flight wallet ownership check.
  const ownership = await checkLoanOwnership(state.userId, state.loan);
  if (!ownership.ok && ownership.reason === "wallet_mismatch") {
    pending.delete(ctx.chat.id);
    return ctx.reply(
      renderWalletMismatchMessage(ownership, "topup"),
      { parse_mode: "Markdown" },
    );
  }

  await ctx.reply("⏳ Adding collateral on-chain...");

  try {
    const result = await executeAddCollateral({
      userId: state.userId,
      loanDbRow: state.loan,
      extraRawAmount: rawBig,
    });
    await recordAddCollateral(state.loan.id, rawBig);
    pending.delete(ctx.chat.id);

    const addedHuman = Number(rawBig) / Math.pow(10, state.loan.decimals ?? 9);
    await ctx.reply(
      [
        "✅ *Collateral added*",
        "",
        `Added: ${addedHuman.toLocaleString()} ${state.loan.symbol ?? ""}`,
        `Loan #${state.loan.loan_id} health improved.`,
        "",
        `[View tx](https://solscan.io/tx/${result.signature})`,
        "",
        "Use /positions to check status.",
      ].join("\n"),
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  } catch (err) {
    console.error("Top-up failed:", err);
    const friendly = translateTxError(err, { flow: "topup" });
    await ctx.reply(friendly, {
      parse_mode: "Markdown",
      reply_markup: errorActionKeyboard({ flow: "topup", errorKind: "tx_error" }),
    });
  }
}
