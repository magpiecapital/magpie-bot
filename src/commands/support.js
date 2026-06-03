/**
 * /support — self-service issue triage.
 *
 * Most user issues are deterministic lookups (loan state, tx status)
 * that the bot already knows the answer to. This command lets users
 * self-diagnose without the admin in the loop. Free-form questions
 * route to admin via a ticket queue (admin replies with /reply N <text>).
 *
 * Flow:
 *   /support → menu
 *     ├─ Diagnose a loan → list user's active loans → full state report
 *     ├─ Check a transaction → paste sig → on-chain status
 *     └─ Send a message → free-form → ticket → admin DM
 */
import { InlineKeyboard } from "grammy";
import { PublicKey } from "@solana/web3.js";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { getReadOnlyProgram } from "../solana/program.js";
import { getLiveOwedLamports } from "../services/loans.js";
import { collateralValueLamports } from "../services/price.js";
import { clearPending as clearBorrowPending } from "./borrow.js";
import { clearPending as clearWithdrawPending } from "./withdraw.js";
import { chatWithAgent, isAiSupportEnabled, resetConversation, setBotRef } from "../services/ai-support.js";

const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? Number(process.env.ADMIN_TG_ID) : null;

const pending = new Map(); // chatId → { stage: 'await_tx' | 'await_message' }

export function clearPending(chatId) {
  pending.delete(chatId);
}

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}

function healthEmoji(ratio) {
  if (ratio >= 1.5) return "🟢";
  if (ratio >= 1.2) return "🟡";
  if (ratio >= 1.1) return "🟠";
  return "🔴";
}

function timeLeft(due) {
  const ms = new Date(due).getTime() - Date.now();
  if (ms <= 0) return `⚠️ ${Math.floor(-ms / 3_600_000)}h PAST DUE`;
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h left`;
  return `${hours}h left`;
}

export async function handleSupport(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  await upsertUser(tgUser.id, tgUser.username);

  const aiOn = isAiSupportEnabled();
  const kb = new InlineKeyboard();
  if (aiOn) {
    kb.text("💬 Chat with the agent", "support:chat").row();
  }
  kb.text("🔍 Diagnose a loan", "support:loan").row()
    .text("💸 Check a transaction", "support:tx").row()
    .text("🎫 Open a ticket (admin reply)", "support:msg").row()
    .text("✕ Cancel", "support:cancel");

  const lines = ["🛟 *Magpie Support*", ""];
  if (aiOn) {
    lines.push(
      "What's going on? Pick *Chat with the agent* for anything — I can look up your loans, check transactions, answer protocol questions, and escalate to the team if needed.",
      "",
      "Or jump straight to a specific tool below:",
    );
  } else {
    lines.push("What can I help with?");
  }
  lines.push(
    "",
    "• *Diagnose a loan* — pull the live state of any of your loans",
    "• *Check a transaction* — paste a sig, I tell you if it confirmed",
    "• *Open a ticket* — leave a message, team replies via this bot",
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb });
}

async function diagnoseLoan(ctx, loan) {
  const program = getReadOnlyProgram();
  let onChain;
  try {
    onChain = await program.account.loan.fetch(new PublicKey(loan.loan_pda));
  } catch {
    return ctx.editMessageText(
      `❌ Couldn't read this loan from the chain right now. Try again in a moment.`,
    );
  }

  const status =
    "repaid" in onChain.status ? "repaid"
    : "liquidated" in onChain.status ? "liquidated"
    : "active";

  const owed = BigInt(onChain.repayAmount.toString());
  const original = BigInt(loan.loan_amount_lamports || 0);
  const paidOff = original > 0n ? (Number(original - owed) / Number(original) * 100).toFixed(1) : "0";

  // Health
  let healthLine = "";
  if (status === "active") {
    try {
      const { rows: [m] } = await query(
        `SELECT decimals FROM supported_mints WHERE mint = $1`,
        [loan.collateral_mint],
      );
      if (m) {
        const collateralLamports = await collateralValueLamports(
          loan.collateral_mint,
          loan.collateral_amount,
          m.decimals,
        );
        const ratio = Number(owed) > 0 ? collateralLamports / Number(owed) : 0;
        healthLine = `${healthEmoji(ratio)} Health: ${ratio.toFixed(2)}x (collateral now ${fmtSol(collateralLamports)} SOL)`;
      }
    } catch { /* skip health if RPC fails */ }
  }

  const lines = [
    `🔍 *Loan #${loan.loan_id} · ${loan.symbol ?? "?"}*`,
    "",
    `Status: ${status === "active" ? "🟢 Active" : status === "repaid" ? "✅ Repaid" : "⚠️ Liquidated"}`,
  ];

  if (status === "active") {
    lines.push(
      `Owed: \`${fmtSol(owed)} SOL\`  ${original > owed ? `(${paidOff}% paid off, original was ${fmtSol(original)} SOL)` : ""}`,
      `Collateral: ${loan.collateral_amount}`,
      `LTV tier: ${loan.ltv_percentage}% · ${loan.duration_days}d term`,
      `Due: ${timeLeft(loan.due_timestamp)}`,
    );
    if (healthLine) lines.push("", healthLine);

    // Smart diagnostic
    lines.push("");
    if (paidOff && Number(paidOff) > 90) {
      lines.push(`✨ You've paid down ${paidOff}% of the original. Just \`${fmtSol(owed)} SOL\` more to fully close out.`);
    } else if (new Date(loan.due_timestamp).getTime() < Date.now()) {
      lines.push("⚠️ *This loan is past due.* Repay or it may be liquidated by a keeper.");
    } else {
      lines.push("✅ No issues detected. Loan is healthy and on track.");
    }
  } else if (status === "repaid") {
    lines.push(
      `Final repaid: \`${fmtSol(original)} SOL\``,
      "",
      "✅ This loan is closed. Your collateral was returned to your wallet.",
    );
  } else {
    lines.push(
      "Collateral was seized after the loan went past due.",
      "Your credit score took a hit — repay future loans on time to recover.",
    );
  }

  const kb = new InlineKeyboard();
  if (status === "active") {
    kb.text("💰 Repay", `repay:loan:${loan.id}`).row();
    kb.text("⏱ Extend", `extend:loan:${loan.id}`).text("➕ Add collateral", `topup:loan:${loan.id}`).row();
  }
  kb.text("🛟 Back to support", "support:back");

  await ctx.editMessageText(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

async function diagnoseTx(ctx, sig) {
  if (!sig || !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) {
    return ctx.reply(
      "That doesn't look like a valid Solana transaction signature. Try /support again and paste the full signature (a long base58 string).",
    );
  }

  let status;
  try {
    const res = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    status = res?.value?.[0];
  } catch (err) {
    return ctx.reply(`Couldn't reach Solana RPC right now: ${err.message?.slice(0, 100)}`);
  }

  const lines = [
    `🔍 *Transaction \`${sig.slice(0, 8)}…\`*`,
    "",
  ];

  if (!status) {
    lines.push(
      "Status: ❓ *Not found on chain*",
      "",
      "This usually means the tx was never submitted, expired (blockhash > 90s old), or dropped from the mempool. Try running the action again.",
    );
  } else if (status.err) {
    lines.push(
      "Status: ❌ *Failed on-chain*",
      "",
      `Error: \`${JSON.stringify(status.err).slice(0, 200)}\``,
      "",
      "The tx landed but reverted. The action did not complete. Try again — if it keeps failing, send a message via /support.",
    );
  } else {
    const conf = status.confirmationStatus || "unknown";
    lines.push(
      `Status: ${conf === "finalized" ? "✅ *Finalized*" : conf === "confirmed" ? "✅ *Confirmed*" : "⏳ *Processing*"}`,
      `Slot: \`${status.slot}\``,
      "",
      conf === "finalized" || conf === "confirmed"
        ? "✅ Your tx succeeded. If the page that submitted it showed a timeout error, ignore that — the tx actually landed."
        : "The tx is in flight. Wait ~10 seconds and check again.",
    );
  }

  lines.push("", `[View on Solscan](https://solscan.io/tx/${sig})`);

  const kb = new InlineKeyboard().text("🛟 Back to support", "support:back");
  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}

export function registerSupportCallbacks(bot) {
  // Give ai-support a handle to the bot so it can DM admin on
  // repeated failures (rate-limit alerts, auth errors, etc.).
  setBotRef(bot);

  bot.callbackQuery("support:cancel", async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Support session cancelled. Use /support anytime.");
  });

  bot.callbackQuery("support:back", async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.answerCallbackQuery();
    await handleSupport(ctx);
  });

  bot.callbackQuery("support:loan", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { rows } = await query(
      `SELECT l.*, sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.user_id = $1
        ORDER BY l.status = 'active' DESC, l.due_timestamp DESC
        LIMIT 10`,
      [user.id],
    );
    if (rows.length === 0) {
      const kb = new InlineKeyboard().text("🛟 Back", "support:back");
      return ctx.editMessageText(
        "You don't have any loans on record. Use /borrow to take one out.",
        { reply_markup: kb },
      );
    }
    // Live owed amounts in parallel so the picker shows accurate balances
    const liveAmounts = await Promise.all(
      rows.map(async (loan) => {
        if (loan.status !== "active") return BigInt(loan.original_loan_amount_lamports);
        return getLiveOwedLamports(loan);
      }),
    );
    const kb = new InlineKeyboard();
    rows.forEach((loan, i) => {
      const tag = loan.status === "active" ? "🟢" : loan.status === "repaid" ? "✅" : "⚠️";
      kb.text(
        `${tag} #${loan.loan_id} · ${loan.symbol ?? "?"} · ${fmtSol(liveAmounts[i])} SOL`,
        `support:diag:${loan.id}`,
      ).row();
    });
    kb.text("🛟 Back", "support:back");
    await ctx.editMessageText("Pick a loan to diagnose:", { reply_markup: kb });
  });

  bot.callbackQuery(/^support:diag:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const { rows } = await query(
      `SELECT l.*, sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.id = $1 AND l.user_id = $2`,
      [loanDbId, user.id],
    );
    if (!rows[0]) {
      return ctx.editMessageText("Loan not found.");
    }
    await diagnoseLoan(ctx, rows[0]);
  });

  bot.callbackQuery("support:tx", async (ctx) => {
    await ctx.answerCallbackQuery();
    clearBorrowPending(ctx.chat.id);
    clearWithdrawPending(ctx.chat.id);
    pending.set(ctx.chat.id, { stage: "await_tx" });
    await ctx.editMessageText(
      "Paste the Solana transaction signature you want to check.\n\nIt's the long base58 string you'd see on Solscan.",
    );
  });

  bot.callbackQuery("support:msg", async (ctx) => {
    await ctx.answerCallbackQuery();
    clearBorrowPending(ctx.chat.id);
    clearWithdrawPending(ctx.chat.id);
    pending.set(ctx.chat.id, { stage: "await_message" });
    await ctx.editMessageText(
      [
        "✍️ *Send a message to the Magpie team*",
        "",
        "Type your question or issue below. Include any context like loan #s, tx signatures, or wallet addresses so we can help fast.",
        "",
        "We'll reply via this bot.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // ── AI CHAT ──────────────────────────────────────────────────
  // Multi-turn conversational support. User stays in 'ai_chat'
  // stage until they explicitly end via the End/Ticket button.
  bot.callbackQuery("support:chat", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAiSupportEnabled()) {
      return ctx.editMessageText("AI chat is currently disabled. Use the ticket flow instead.");
    }
    clearBorrowPending(ctx.chat.id);
    clearWithdrawPending(ctx.chat.id);
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await resetConversation(user.id); // fresh session
    pending.set(ctx.chat.id, { stage: "ai_chat", userId: user.id });
    const kb = new InlineKeyboard()
      .text("🔄 Reset", "support:chat:reset")
      .text("✕ End", "support:chat:end")
      .text("🎫 Ticket", "support:chat:ticket");
    await ctx.editMessageText(
      [
        "💬 *Magpie support agent · live*",
        "",
        "I can look up your loans, check transactions, answer protocol questions, and route anything I can't handle to the team.",
        "",
        "What's going on?",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery("support:chat:end", async (ctx) => {
    await ctx.answerCallbackQuery("Chat ended");
    const state = pending.get(ctx.chat.id);
    if (state?.userId) await resetConversation(state.userId);
    pending.delete(ctx.chat.id);
    await ctx.editMessageText("Chat ended. Use /support anytime.");
  });

  bot.callbackQuery("support:chat:reset", async (ctx) => {
    await ctx.answerCallbackQuery("Memory cleared");
    const state = pending.get(ctx.chat.id);
    if (state?.userId) await resetConversation(state.userId);
    // Stay in ai_chat stage — user wants a fresh conversation, not exit
    const kb = new InlineKeyboard()
      .text("🔄 Reset", "support:chat:reset")
      .text("✕ End", "support:chat:end")
      .text("🎫 Ticket", "support:chat:ticket");
    await ctx.editMessageText(
      [
        "💬 *Magpie support agent · fresh session*",
        "",
        "Memory cleared. What can I help with?",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery("support:chat:ticket", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = pending.get(ctx.chat.id);
    if (state?.userId) await resetConversation(state.userId);
    pending.set(ctx.chat.id, { stage: "await_message" });
    await ctx.editMessageText(
      "Type the message you want sent to the team. Include any details that help.",
    );
  });

  // Text middleware — only acts when the user is actively in a support
  // input stage. Registered EARLY in src/index.js so it doesn't get
  // hijacked by other flows (same defense as /import).
  bot.on("message:text", async (ctx, next) => {
    const state = pending.get(ctx.chat.id);
    if (!state) return next();
    if (state.stage !== "await_tx" && state.stage !== "await_message" && state.stage !== "ai_chat") {
      return next();
    }

    if (state.stage === "ai_chat") {
      // Multi-turn: don't delete state. Send a thinking indicator that
      // we edit when the response comes back.
      const userMsg = ctx.message.text.trim();
      const thinking = await ctx.reply("💭 _Thinking…_", { parse_mode: "Markdown" });
      try {
        const result = await chatWithAgent(state.userId, userMsg);
        if (!result) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            thinking.message_id,
            "AI chat isn't configured right now. Tap *Open a ticket* via /support.",
            { parse_mode: "Markdown" },
          );
          return;
        }
        const kb = new InlineKeyboard()
          .text("✕ End chat", "support:chat:end")
          .text("🎫 Escalate to ticket", "support:chat:ticket");
        // If the AI escalated to a ticket, DM admin with context
        if (result.escalated_ticket_id && ADMIN_TG_ID) {
          try {
            const fromTag = ctx.from.username ? `@${ctx.from.username}` : `tg://${ctx.from.id}`;
            await ctx.api.sendMessage(
              ADMIN_TG_ID,
              [
                `🎫 *AI-escalated ticket #${result.escalated_ticket_id}*`,
                "",
                `From: ${fromTag}`,
                "",
                `Last user message: "${userMsg.slice(0, 300)}"`,
                "",
                `Tools the agent used: ${result.used_tools?.join(", ") || "(none)"}`,
                "",
                `Reply: \`/reply ${result.escalated_ticket_id} <your message>\``,
              ].join("\n"),
              { parse_mode: "Markdown" },
            );
          } catch { /* non-critical */ }
        }
        await ctx.api.editMessageText(
          ctx.chat.id,
          thinking.message_id,
          result.text,
          { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true },
        ).catch(async () => {
          // If Markdown parse fails, retry as plaintext (some AI responses
          // contain unbalanced characters Telegram chokes on)
          await ctx.api.editMessageText(
            ctx.chat.id, thinking.message_id, result.text,
            { reply_markup: kb, disable_web_page_preview: true },
          );
        });
      } catch (err) {
        console.error("[support:ai_chat] error:", err);
        await ctx.api.editMessageText(
          ctx.chat.id, thinking.message_id,
          "Something broke in the chat. Try /support again or open a ticket.",
        );
        pending.delete(ctx.chat.id);
      }
      return;
    }

    // tx / message stages are single-shot
    pending.delete(ctx.chat.id);

    if (state.stage === "await_tx") {
      const sig = ctx.message.text.trim();
      return diagnoseTx(ctx, sig);
    }

    if (state.stage === "await_message") {
      const message = ctx.message.text.trim();
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      const { rows: [t] } = await query(
        `INSERT INTO support_tickets (user_id, message, status)
         VALUES ($1, $2, 'open')
         RETURNING id`,
        [user.id, message],
      );

      await ctx.reply(
        `✅ Ticket *#${t.id}* opened. The team will reply via this bot — usually within a few hours.`,
        { parse_mode: "Markdown" },
      );

      // DM admin with the ticket + a one-line reply hint
      if (ADMIN_TG_ID) {
        try {
          const fromTag = ctx.from.username ? `@${ctx.from.username}` : `tg://${ctx.from.id}`;
          await ctx.api.sendMessage(
            ADMIN_TG_ID,
            [
              `🎫 *Support ticket #${t.id}*`,
              "",
              `From: ${fromTag}`,
              "",
              message,
              "",
              `Reply: \`/reply ${t.id} <your message>\``,
            ].join("\n"),
            { parse_mode: "Markdown" },
          );
        } catch { /* non-critical */ }
      }
    }
  });
}
