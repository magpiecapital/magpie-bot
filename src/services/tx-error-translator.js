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

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
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
      const lines = [
        "⚠️ *Not enough SOL to repay this loan*",
        "",
        ctx.owedLamports != null ? `You owe: \`${fmtSol(ctx.owedLamports)} SOL\` (plus ~0.003 SOL for fees)` : null,
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        short != null ? `Short by: *\`${fmtSol(short)} SOL\`*` : null,
        "",
        "*What to do:*",
        "• Send more SOL to your Magpie wallet via /deposit, then /repay",
        "• /partialrepay to pay part of it now and reduce liquidation risk",
        "• /topup to add more collateral instead of paying SOL",
        "• /extend to push the due date out for a small fee",
      ].filter(Boolean);
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
    if (flow === "borrow") {
      return [
        "⚠️ *Not enough SOL for gas + ATA rent*",
        "",
        "Borrows need ~0.01 SOL in your wallet for transaction fees and ATA rent — even though the loan itself is paid TO you.",
        "",
        have != null ? `Your wallet has: \`${fmtSol(have)} SOL\`` : null,
        "",
        "Send ~0.01 SOL to your Magpie wallet via /deposit, then /borrow again.",
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
