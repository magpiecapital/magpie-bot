/**
 * Callbacks for the "Ask the agent why" / "Try again" buttons attached
 * to every transaction error message by errorActionKeyboard().
 *
 * Three actions:
 *   - txerr:ask:<flow>:<kind> — hand the user off to the AI support
 *     agent with the error context preloaded. So they don't have to
 *     re-explain.
 *   - txerr:retry:<flow> — fire-and-forget re-invoke of the original
 *     command (e.g., /repay).
 *   - (fallback:deposit handled by the existing deposit flow)
 *
 * Wired in src/index.js so all error-keyboard buttons just work.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "./users.js";
import { chatWithAgent, isAiSupportEnabled } from "./ai-support.js";

const FLOW_LABEL = {
  repay: "repaying a loan",
  partialrepay: "partial-repaying a loan",
  extend: "extending a loan",
  borrow: "borrowing",
  reborrow: "reborrowing",
  topup: "topping up collateral",
  withdraw: "withdrawing",
};

const KIND_DESCRIPTION = {
  insufficient_sol: "their wallet didn't have enough SOL to cover the loan amount + Solana network fees (~0.003 SOL)",
  blockhash_expired: "they sat on the confirm screen too long (>90s), so the Solana blockhash expired",
  rpc_blip: "Solana RPC had a transient network hiccup",
  signature_failed: "the transaction couldn't be signed correctly (usually transient)",
  state_mismatch: "the on-chain state changed between read and write — usually a race condition",
  anchor_error: "the program returned a named Anchor error",
  tx_error: "an unspecified transaction error occurred",
};

export function registerTxErrorCallbacks(bot) {
  // Ask the agent — route into the AI chat with prefilled context
  bot.callbackQuery(/^txerr:ask:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAiSupportEnabled()) {
      await ctx.reply(
        "The agent isn't available right now. Send your question via /support and the team will reply.",
      );
      return;
    }
    const flow = ctx.match[1];
    const kind = ctx.match[2];
    const user = await upsertUser(ctx.from.id, ctx.from.username);

    const flowLabel = FLOW_LABEL[flow] || flow;
    const kindDesc = KIND_DESCRIPTION[kind] || "an unexpected transaction error";

    // Synthesize a first-turn message TO the agent that gives it
    // context — but display the agent's response to the user as if
    // they just asked their own question.
    const synthMsg = `I just tried ${flowLabel} and it failed. The error was: ${kindDesc}. Can you explain what happened and exactly what I need to do next?`;

    const thinking = await ctx.reply("💭 _Asking the agent…_", { parse_mode: "Markdown" });
    try {
      const result = await chatWithAgent(user.id, synthMsg, {
        username: ctx.from?.username,
        languageCode: ctx.from?.language_code,
      });
      if (!result) {
        await ctx.api.editMessageText(
          ctx.chat.id, thinking.message_id,
          "Agent unavailable. Run /support to message the team.",
        );
        return;
      }
      const kb = new InlineKeyboard()
        .text("💬 Continue chat", "support:chat")
        .text(`🔁 Try /${flow} again`, `txerr:retry:${flow}`);
      await ctx.api.editMessageText(
        ctx.chat.id, thinking.message_id, result.text,
        { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true },
      ).catch(async () => {
        await ctx.api.editMessageText(
          ctx.chat.id, thinking.message_id, result.text,
          { reply_markup: kb, disable_web_page_preview: true },
        );
      });
    } catch (err) {
      console.error("[txerr:ask] error:", err);
      await ctx.api.editMessageText(
        ctx.chat.id, thinking.message_id,
        "Couldn't reach the agent right now. Try /support to message the team.",
      );
    }
  });

  // Retry — fire-and-forget the original command. Telegram routes
  // commands by /name so we just send the command back to ourselves.
  // Simpler: tell the user how to retry. (We can't programmatically
  // re-trigger /borrow etc. without re-doing the full state setup.)
  bot.callbackQuery(/^txerr:retry:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.match[1];
    await ctx.reply(
      [
        `🔁 *Retrying ${flow}*`,
        "",
        `Just run /${flow} again — it'll pick up fresh state. If you topped up SOL or fixed whatever the issue was, it should go through this time.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });
}
