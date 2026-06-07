import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";
import { getSolBalance } from "../services/deposits.js";
import { executePartialRepay, recordPartialRepay, getLiveOwedLamports, checkLoanOwnership } from "../services/loans.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";
import { translateTxError, errorActionKeyboard, renderWalletMismatchMessage } from "../services/tx-error-translator.js";

const pending = new Map();

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handlePartialRepay(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT l.*, sm.symbol
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply("📭 No active loans.");
  }

  const { filtered: scopedRows, otherWalletCount } =
    await scopeLoansToActiveWallet(user.id, rows);

  if (scopedRows.length === 0) {
    return ctx.reply(
      `📭 No active loans on your *current* wallet.` +
      (otherWalletCount > 0
        ? `\n\n${otherWalletCount} loan${otherWalletCount === 1 ? "" : "s"} on other linked wallets — /wallets to switch.`
        : ""),
      { parse_mode: "Markdown" },
    );
  }

  // Live on-chain owed amount per scoped loan, so display matches reality
  const liveAmounts = await Promise.all(scopedRows.map(getLiveOwedLamports));

  const kb = new InlineKeyboard();
  scopedRows.forEach((loan, i) => {
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · owe ${fmtSol(liveAmounts[i])} SOL`,
      `prepay:loan:${loan.id}`,
    ).row();
  });
  kb.text("✕ Cancel", "prepay:cancel");

  const header = "*Partial repay* (collateral stays locked until full payoff)\n\nPick a loan:" +
    (otherWalletCount > 0
      ? `\n_${otherWalletCount} more on other wallets — /wallets to switch._`
      : "");
  await ctx.reply(header, { parse_mode: "Markdown", reply_markup: kb });
}

export function registerPartialRepayCallbacks(bot) {
  bot.callbackQuery(/^prepay:cancel$/, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Partial repay cancelled.");
  });

  bot.callbackQuery(/^prepay:loan:(\d+)$/, async (ctx) => {
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { publicKey } = await ensureWallet(user.id);

    const { rows } = await query(
      `SELECT l.*, sm.symbol
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

    const sol = await getSolBalance(publicKey);
    // Reserve ~0.003 SOL for fees + rent.
    const available = Math.max(0, sol - 3_000_000);
    // Live on-chain amount — DB column may be stale after prior partial repays
    const owed = await getLiveOwedLamports(loan);

    if (available <= 0) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `📭 Not enough SOL in wallet.\n\nDeposit SOL to:\n\`${publicKey}\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    pending.set(ctx.chat.id, { userId: user.id, loan, available, owed });

    const kb = new InlineKeyboard()
      .text("25%", "prepay:pct:25").text("50%", "prepay:pct:50")
      .text("75%", "prepay:pct:75")
      .row().text("✏️ Custom %", "prepay:custom")
      .row().text("✕ Cancel", "prepay:cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
        `Owed: ${fmtSol(owed)} SOL`,
        `Wallet: ${fmtSol(sol)} SOL (usable ~${fmtSol(available)})`,
        "",
        "*How much of the loan to pay down?*",
        "_(partial — must be less than total owed; use /repay for full)_",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  // Custom-percentage input. User taps "Custom %" → bot asks them to
  // type a percentage of the loan to pay down → text-middleware below
  // captures it. Mirrors the % quick-buttons so the input matches what
  // the buttons offer (e.g. 25/50/75 quick-picks + any custom % in
  // between).
  bot.callbackQuery("prepay:custom", async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state) { await ctx.answerCallbackQuery("Session expired"); return; }
    state.stage = "await_custom";
    pending.set(ctx.chat.id, state);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `Loan #${state.loan.loan_id} · ${state.loan.symbol ?? "?"}`,
        `Owed: ${fmtSol(state.owed)} SOL`,
        `Wallet usable: ~${fmtSol(state.available)} SOL`,
        "",
        `Type the *%* of the loan you want to pay down.`,
        `e.g. \`42\` for 42% or \`82.5\` for 82.5%`,
        "",
        `_(must be less than 100% — use /repay to fully close out)_`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // Text-middleware: capture the typed percentage. Uses ctx.next() so
  // other text handlers still get a turn if this session isn't ours.
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state || state.stage !== "await_custom") return next();
    // Accept "42", "42%", "42.5", "42.5%" — strip any % sign + commas.
    const raw = ctx.message.text.trim().replace(/,/g, "").replace(/%$/, "").trim();
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct <= 0) {
      return ctx.reply("Please enter a positive percentage (e.g. `42`).", { parse_mode: "Markdown" });
    }
    if (pct >= 100) {
      return ctx.reply(
        `Partial repay must be less than 100% (it has to leave at least 1 lamport on the loan). ` +
        `Use /repay to fully close the loan.`,
      );
    }
    // BigInt-safe math: multiply by 100 first so 42.5% becomes 4250
    // basis-points, then divide by 10_000. Matches the quick-button
    // math (`owed * pct / 100`) when pct is a whole number.
    const bps = BigInt(Math.round(pct * 100));
    let lamports = (state.owed * bps) / 10_000n;
    // Defensive cap: program requires repay amount < original. Already
    // guaranteed by pct < 100, but defend against rounding.
    const cap = state.owed - 1n;
    if (lamports > cap) lamports = cap;
    if (lamports <= 0n) {
      return ctx.reply("That % rounds to zero — try a larger one.");
    }
    if (lamports > BigInt(state.available)) {
      return ctx.reply(
        `That works out to ${fmtSol(lamports)} SOL, but you only have ~${fmtSol(state.available)} SOL usable in this wallet (after gas reserve). Try a smaller %.`,
      );
    }
    delete state.stage;
    state.customRepayLamports = lamports;
    pending.set(ctx.chat.id, state);
    await submitPartialRepay(ctx, state, lamports);
  });

  bot.callbackQuery(/^prepay:pct:(\d+)$/, async (ctx) => {
    const pct = Number(ctx.match[1]);
    const state = pending.get(ctx.chat.id);
    if (!state) {
      await ctx.answerCallbackQuery("Session expired");
      return;
    }

    // Pay down `pct`% of what's owed — capped at (owed - 1 lamport) and available.
    let repayLamports = (state.owed * BigInt(pct)) / 100n;
    const cap = state.owed - 1n; // program requires amount < original_loan_amount
    if (repayLamports > cap) repayLamports = cap;
    if (repayLamports > BigInt(state.available)) repayLamports = BigInt(state.available);

    if (repayLamports <= 0n) {
      await ctx.answerCallbackQuery("Amount too small");
      return;
    }

    await ctx.answerCallbackQuery();
    await submitPartialRepay(ctx, state, repayLamports);
  });
}

/**
 * Shared execute path — used by both the pct quick-buttons and the
 * custom-SOL-amount entry. Single code path = single failure surface;
 * any caller-side validation should clamp `repayLamports` before
 * calling this. This function re-validates the wallet-ownership
 * pre-flight then runs the on-chain partial repay.
 */
async function submitPartialRepay(ctx, state, repayLamports) {
  if (repayLamports <= 0n) {
    return ctx.reply("Amount too small.");
  }
  // Defensive: even though callers should have clamped already,
  // we re-clamp here so a bug upstream can't accidentally pay MORE
  // than owed - 1 (would fail the on-chain check anyway, but a
  // clean ctx.reply is friendlier).
  const cap = state.owed - 1n;
  if (repayLamports > cap) repayLamports = cap;
  if (repayLamports > BigInt(state.available)) repayLamports = BigInt(state.available);
  if (repayLamports <= 0n) {
    return ctx.reply("Amount too small after gas reserve.");
  }

  // Wallet-ownership pre-flight — same as the pct path used to do inline.
  const ownership = await checkLoanOwnership(state.userId, state.loan);
  if (!ownership.ok && ownership.reason === "wallet_mismatch") {
    pending.delete(ctx.chat.id);
    return ctx.reply(
      renderWalletMismatchMessage(ownership, "partialrepay"),
      { parse_mode: "Markdown" },
    );
  }

  await ctx.reply("⏳ Submitting partial repay on-chain...");

  try {
    const result = await executePartialRepay({
      userId: state.userId,
      loanDbRow: state.loan,
      repayLamports,
    });
    await recordPartialRepay(state.loan.id, repayLamports);
    pending.delete(ctx.chat.id);

    const remaining = state.owed - repayLamports;
    await ctx.reply(
      [
        "✅ *Partial repay submitted*",
        "",
        `Paid: ${fmtSol(repayLamports)} SOL`,
        `Remaining: ${fmtSol(remaining)} SOL`,
        "Collateral remains locked until full payoff.",
        "",
        `[View tx](https://solscan.io/tx/${result.signature})`,
      ].join("\n"),
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  } catch (err) {
    console.error("Partial repay failed:", err);
    const friendly = translateTxError(err, { flow: "partialrepay" });
    await ctx.reply(friendly, {
      parse_mode: "Markdown",
      reply_markup: errorActionKeyboard({ flow: "partialrepay", errorKind: "tx_error" }),
    });
  }
}
