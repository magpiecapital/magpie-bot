/**
 * Translate raw Solana / Anchor transaction errors into user-actionable
 * Markdown messages.
 *
 * Without this, users see things like:
 *
 *   "Transaction simulation failed: Error processing Instruction 4:
 *    custom program error: 0x1. Logs: [...] Transfer: insufficient
 *    lamports 15116739, need 519360343"
 *
 * Which is completely unreadable. This helper recognizes the most
 * common patterns and rewrites them into something a non-developer can
 * actually act on. Falls back to a clean "something went wrong, here's
 * the raw error" message for cases we don't recognize yet.
 *
 * Used by /repay, /partialrepay, /extend, /borrow, /withdraw — anywhere
 * we surface a Solana transaction error directly to the user.
 */

import { InlineKeyboard } from "grammy";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

/**
 * Standard inline keyboard for tx errors. Every error message ends
 * with one of these — the "Ask the agent why" button is the killer:
 * it routes the user to /support → AI chat with the error context
 * preloaded so they don't have to re-explain.
 *
 * @param {object} opts
 * @param {string} [opts.flow] — for the retry button label
 * @param {string} [opts.errorKind] — short kind tag (e.g. "insufficient_sol")
 *   passed to the agent so it has context
 */
export function errorActionKeyboard(opts = {}) {
  const flow = opts.flow || "repay";
  const kind = opts.errorKind || "tx_error";
  return new InlineKeyboard()
    .text("🤖 Ask the agent why", `txerr:ask:${flow}:${kind}`)
    .text("📥 Deposit", "fallback:deposit")
    .row()
    .text(`🔁 Try /${flow} again`, `txerr:retry:${flow}`);
}

/**
 * @param {Error} err — the caught error (usually a SendTransactionError or thrown by anchor)
 * @param {object} ctx — optional context for richer messages
 * @param {bigint|string|number} [ctx.owedLamports] — amount user owes (for repay-flow phrasing)
 * @param {string} [ctx.flow] — "repay" | "partialrepay" | "extend" | "borrow" | "withdraw"
 * @returns {string} Markdown-formatted message ready to send via Telegram
 */
export function translateTxError(err, ctx = {}) {
  const raw = (err?.message || "").toString();
  const logs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
  const blob = raw + "\n" + logs;
  const flow = ctx.flow || "repay";

  // Pattern 1: insufficient lamports — by far the most common
  const insufficientMatch = blob.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
  if (insufficientMatch || /custom program error: 0x1/.test(blob)) {
    const have = insufficientMatch ? BigInt(insufficientMatch[1]) : null;
    const need = insufficientMatch ? BigInt(insufficientMatch[2]) : null;
    const short = (have != null && need != null) ? need - have : null;

    if (flow === "repay") {
      // Build a clear math breakdown so the user understands WHY they
      // need more SOL than just the loan amount. The Solana network
      // itself charges tiny fees for every tx + small "rent" for
      // creating any new on-chain account.
      const lines = [
        "⚠️ *Your wallet doesn't have enough SOL*",
        "",
        "Repaying a loan needs the *loan amount + Solana network fees*. Here's the math:",
        "",
      ];
      if (ctx.owedLamports != null) {
        lines.push(`Loan owed:      \`${fmtSol(ctx.owedLamports)} SOL\``);
        lines.push(`Network fees:   \`~0.003 SOL\` _(Solana charges for every tx)_`);
        if (need != null) {
          lines.push(`*Need total:*   \`${fmtSol(need)} SOL\``);
        } else if (ctx.owedLamports != null) {
          const totalNeeded = BigInt(ctx.owedLamports.toString()) + 3_000_000n;
          lines.push(`*Need total:*   \`${fmtSol(totalNeeded)} SOL\``);
        }
        lines.push("");
      }
      if (have != null) lines.push(`Your wallet:    \`${fmtSol(have)} SOL\``);
      if (short != null) {
        lines.push(`*You're short:* *\`${fmtSol(short)} SOL\`*`);
      }
      lines.push(
        "",
        "*Three ways to fix this:*",
        short != null
          ? `1. *Send ~\`${fmtSol(short + 1_000_000n)} SOL\`* to your Magpie wallet (run /deposit for your address), then retry /repay`
          : "1. *Send more SOL* to your Magpie wallet (run /deposit for your address), then retry /repay",
        "2. */partialrepay* — pay only what you can right now, reduce liquidation risk",
        "3. */topup* — add more collateral instead of paying SOL (free besides ~0.001 SOL gas)",
        "4. */extend* — push the due date out for a small fee",
        "",
        "_Confused? Tap *Ask the agent* below — they'll walk you through it._",
      );
      return lines.join("\n");
    }
    if (flow === "partialrepay") {
      const lines = [
        "⚠️ *Not enough SOL for that partial repay amount*",
        "",
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        need != null ? `This would need: \`${fmtSol(need)} SOL\` (incl. fees)` : null,
        short != null ? `Short by: *\`${fmtSol(short)} SOL\`*` : null,
        "",
        "*What to do:*",
        "• Try a smaller amount with /partialrepay",
        "• Send more SOL via /deposit",
        "• /topup if you'd rather add collateral than pay down",
      ].filter(Boolean);
      return lines.join("\n");
    }
    if (flow === "extend") {
      const lines = [
        "⚠️ *Not enough SOL to extend this loan*",
        "",
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        need != null ? `Extend fee needs: \`${fmtSol(need)} SOL\`` : null,
        short != null ? `Short by: *\`${fmtSol(short)} SOL\`*` : null,
        "",
        "Send a bit more SOL via /deposit, then /extend again.",
      ].filter(Boolean);
      return lines.join("\n");
    }
    if (flow === "borrow" || flow === "reborrow") {
      const cmd = flow === "reborrow" ? "/reborrow" : "/borrow";
      return [
        "⚠️ *Not enough SOL for gas + ATA rent*",
        "",
        `Borrows need ~0.01 SOL in your wallet for transaction fees and ATA rent — even though the loan itself is paid TO you.`,
        "",
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        "",
        `Send ~0.01 SOL to your Magpie wallet via /deposit, then ${cmd} again.`,
      ].filter(Boolean).join("\n");
    }
    if (flow === "topup") {
      return [
        "⚠️ *Not enough SOL for tx fees*",
        "",
        "Top-ups are free besides Solana network fees (~0.001 SOL).",
        "",
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        "",
        "Send a bit of SOL via /deposit, then /topup again.",
      ].filter(Boolean).join("\n");
    }
    if (flow === "withdraw") {
      return [
        "⚠️ *Not enough SOL to send that out*",
        "",
        "You're trying to withdraw more than the wallet holds (after fees).",
        "",
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        need != null ? `Tried to send: \`${fmtSol(need)} SOL\`` : null,
        "",
        "Try a smaller amount, or leave ~0.001 SOL behind for fees.",
      ].filter(Boolean).join("\n");
    }
    // Generic insufficient-lamports message
    return [
      "⚠️ *Not enough SOL in your wallet for this transaction*",
      "",
      have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
      short != null ? `Short by: *\`${fmtSol(short)} SOL\`*` : null,
      "",
      "Send more SOL via /deposit and try again.",
    ].filter(Boolean).join("\n");
  }

  // Pattern 2: blockhash expired
  if (/blockhash not found|block hash not found|BlockhashNotFound/i.test(blob)) {
    return [
      "⚠️ *Transaction expired*",
      "",
      "You took too long to confirm — Solana blockhashes expire in ~90 seconds.",
      "",
      `Just run /${flow} again. The retry uses a fresh blockhash.`,
    ].join("\n");
  }

  // Pattern 3: signature verification / wrong signer
  if (/Signature verification failed|missing signer|InvalidAccountData/i.test(blob)) {
    return [
      "⚠️ *Signing issue*",
      "",
      "The transaction couldn't be signed correctly. This is usually transient.",
      "",
      `Retry /${flow}. If it keeps failing, /support → Chat with agent.`,
    ].join("\n");
  }

  // Pattern 4: account already in use / already closed / state mismatch
  if (/AccountAlreadyInUse|AccountNotInitialized|account discriminator|already closed/i.test(blob)) {
    return [
      "⚠️ *Account state mismatch*",
      "",
      "Looks like the on-chain state changed between when we read it and when we tried to update it.",
      "",
      `Retry /${flow}. If it persists, /support and the team will look.`,
    ].join("\n");
  }

  // Pattern 5: network / RPC
  if (/fetch failed|ECONNRESET|ETIMEDOUT|getaddrinfo|network error|429|503/i.test(raw)) {
    return [
      "⚠️ *Network hiccup*",
      "",
      "RPC had a brief issue — usually transient.",
      "",
      `Retry /${flow} in 15-30 seconds.`,
    ].join("\n");
  }

  // Pattern 6: explicit anchor errors with names
  const anchorMatch = blob.match(/AnchorError.*?(?:Error Code:|error code:)\s*([A-Za-z][A-Za-z0-9_]+)/i);
  if (anchorMatch) {
    return [
      `⚠️ *Transaction rejected: ${anchorMatch[1]}*`,
      "",
      "The program declined this transaction. Common causes: loan is past due, token is disabled, or limits exceeded.",
      "",
      `Run /support → Chat with agent and ask why \`${anchorMatch[1]}\` was raised — the agent can usually explain.`,
    ].join("\n");
  }

  // Fallback: cleaned-up raw error
  return [
    `❌ *${flow[0].toUpperCase() + flow.slice(1)} failed*`,
    "",
    `\`${raw.slice(0, 200)}\``,
    "",
    `Retry /${flow}. If it keeps failing, /support → Chat with agent and paste the error.`,
  ].join("\n");
}
