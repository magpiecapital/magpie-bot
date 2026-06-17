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
 * Render the user-facing message for a wallet-mismatch preflight reject.
 * Called by /repay, /partialrepay, /extend, /topup, /reborrow when the
 * current wallet doesn't match the loan's on-chain borrower.
 *
 * The flow-specific verb in the headline keeps the copy grounded in what
 * the user was actually trying to do.
 */
export function renderWalletMismatchMessage(ownership, flow = "act on") {
  const flowVerbs = {
    repay: "repaid",
    partialrepay: "partial-repaid",
    extend: "extended",
    topup: "topped up",
    reborrow: "re-borrowed",
  };
  const verb = flowVerbs[flow] || "modified";
  const shortB = `${ownership.borrowerWallet.slice(0, 8)}…${ownership.borrowerWallet.slice(-8)}`;
  const shortC = `${ownership.currentWallet.slice(0, 8)}…${ownership.currentWallet.slice(-8)}`;
  return [
    "⚠️ *This loan was opened by a different wallet*",
    "",
    `Loan #${ownership.loanId} can only be ${verb} by the wallet that originally took it out — Solana enforces this at the program level.`,
    "",
    `*Original borrower:* \`${shortB}\``,
    `*Your active wallet:* \`${shortC}\``,
    "",
    "*The fix is one tap:*",
    "",
    "Run /wallets and switch back to the wallet that opened this loan. Your wallets are all stored — switching doesn't move funds, it just changes which one signs.",
    "",
    `Then retry /${flow}.`,
    "",
    "_If the original wallet isn't in your /wallets list (e.g., you imported it elsewhere and lost the key), hit /support and we'll talk through your options._",
  ].join("\n");
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

  // Pattern 1a: SPL Token InsufficientFunds (custom error 0x1 thrown by
  // Token-2022 or legacy Token program). Distinct from a lamports
  // shortage — this means the borrower's COLLATERAL TOKEN balance is
  // insufficient for the transfer. Translating this as "Not enough SOL"
  // (the old behavior) told users to /deposit SOL when they actually
  // needed more of the collateral token. Caught 2026-06-15 during V4
  // testing: user successfully borrowed on V1 with X tokens, then
  // tried V4 with the same amount but the V1 vault already held them.
  const tokenInsufficient =
    /Error: insufficient funds/i.test(blob) ||
    /Program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) failed: custom program error: 0x1/.test(blob);
  if (tokenInsufficient && !/insufficient lamports/i.test(blob)) {
    if (flow === "borrow" || flow === "reborrow") {
      const cmd = flow === "reborrow" ? "/reborrow" : "/borrow";
      return [
        "⚠️ *Not enough of the collateral token in your wallet*",
        "",
        "The borrow tried to lock more of this token than you currently hold. Your SOL balance is fine — it's the collateral side that's short.",
        "",
        "*Common cause:* you already used some of this token for another loan, so the rest is locked in that loan's vault.",
        "",
        "*Two ways to fix:*",
        "1. Try the borrow again with a smaller collateral amount that fits what's in your wallet",
        `2. /repay the existing loan first to release the collateral, then ${cmd} again`,
      ].join("\n");
    }
    if (flow === "topup") {
      return [
        "⚠️ *Not enough of the collateral token in your wallet*",
        "",
        "The top-up tried to add more tokens than you currently hold. Your SOL balance is fine — it's the collateral side that's short.",
        "",
        "Send more of the collateral token to your Magpie wallet via /deposit, then /topup again.",
      ].join("\n");
    }
    // Generic SPL InsufficientFunds for other flows
    return [
      "⚠️ *Not enough tokens in your wallet for this transaction*",
      "",
      "The transaction tried to move more tokens than you currently hold. Your SOL balance is fine — it's a specific SPL token that's short.",
      "",
      "_Tap *Ask the agent* below for a walkthrough._",
    ].join("\n");
  }

  // Pattern 1b-pre: V4 program-specific Anchor errors. V4 returns
  // Anchor codes in the 6000–6027 range (hex 0x1770–0x178b). The naive
  // `/custom program error: 0x1/` test below matches ANY hex starting
  // with 0x1 — including 0x1780 (TwapInsufficientHistory = 6016) —
  // which used to render as "Not enough SOL for gas + ATA rent" even
  // when the wallet had plenty of SOL. Operator hit this 2026-06-17 PM
  // borrowing $BP on V4 (TWAP window hadn't filled). Route each known
  // V4 code to its OWN user-actionable message BEFORE falling through
  // to the lamports path.
  const anchorCodeMatch = blob.match(/Error (?:Number|Code): (\d{4,5})|Error Number: (\d{4,5})/);
  const anchorCode = anchorCodeMatch ? Number(anchorCodeMatch[1] || anchorCodeMatch[2]) : null;
  if (anchorCode === 6016 || /TwapInsufficientHistory/i.test(blob)) {
    return [
      "⚠️ *Price oracle still warming up*",
      "",
      "The lending program needs about 5 minutes of price history to lend safely on this token. The oracle hasn't filled its 5-minute TWAP window yet — usually because the token was just enabled or the network has been quiet.",
      "",
      "*What to do:* wait ~5 minutes and try /borrow again. The oracle pushes a price sample every ~30s.",
      "",
      "_This isn't a wallet issue — your balance is fine._",
    ].join("\n");
  }
  if (anchorCode === 6017 || /PriceImpactPumpDetected/i.test(blob)) {
    return [
      "⚠️ *Spot price moved too far above the 5-min TWAP*",
      "",
      "The lending program refuses to lend when the latest attested price is more than 15% above the trailing 5-minute average — pump protection (applies to both V3 and V4 borrows).",
      "",
      "*What to do:* wait 1-2 minutes for the TWAP to catch up, then /borrow again. Collateral size doesn't change this check — only price stability does.",
      "",
      "_This isn't a wallet issue — your balance is fine._",
    ].join("\n");
  }
  if (anchorCode === 6013 || /StalePriceAttestation/i.test(blob)) {
    return [
      "⚠️ *Price attestation expired*",
      "",
      "The on-chain price feed for this token is older than 2 minutes. The bot's attestor should refresh it on the next tick.",
      "",
      "Try /borrow again in ~30 seconds.",
    ].join("\n");
  }
  if (anchorCode === 6014 || /CollateralValueExceedsAttestation/i.test(blob)) {
    return [
      "⚠️ *Borrow value too high vs. on-chain TWAP*",
      "",
      "The borrow amount exceeds what the TWAP-attested collateral price allows. Try a slightly smaller %.",
    ].join("\n");
  }

  // Pattern 1b: insufficient lamports — true SOL shortage from the
  // Solana runtime. The pattern `insufficient lamports X, need Y` is
  // emitted by the system program when an account-creation rent or
  // transfer exceeds the payer's native balance.
  //
  // The `0x1\b` boundary is load-bearing: without it, the regex matches
  // V4 error 0x1780 (TwapInsufficientHistory = 6016) and every other
  // 0x1NNN code, producing the "Not enough SOL" mis-translation that
  // operator hit 2026-06-17 PM. The boundary requires a non-hex char
  // (or end-of-string) immediately after the "1".
  const insufficientMatch = blob.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
  if (insufficientMatch || /custom program error: 0x1(?![0-9a-fA-F])/.test(blob)) {
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

  // Pattern 6: explicit anchor errors with names — recognize the
  // common ones and give a specific, actionable explanation.
  const anchorMatch = blob.match(/AnchorError.*?(?:Error Code:|error code:)\s*([A-Za-z][A-Za-z0-9_]+)/i)
    || blob.match(/Error Code:\s*([A-Za-z][A-Za-z0-9_]+)/i);
  if (anchorMatch) {
    const code = anchorMatch[1];
    // Specific friendly explanations for known Anchor + Magpie program errors
    const knownErrors = {
      // Anchor framework: has_one constraint failed. In Magpie this almost
      // always means the wallet signing doesn't match the borrower stored
      // in the loan PDA — i.e., user changed wallets after borrowing.
      ConstraintHasOne: [
        "⚠️ *This wallet didn't take out the loan*",
        "",
        "The loan you're trying to act on was opened by a different wallet than the one currently signing. Solana enforces this at the program level.",
        "",
        "*The fix is one tap:*",
        "Run /wallets and switch back to the wallet that opened this loan. Your wallets are all preserved — switching just changes which one signs.",
        "",
        "Then retry the action.",
        "",
        "_If the original wallet isn't in your /wallets list, hit /support and we'll help you figure out the recovery path._",
      ].join("\n"),
      ConstraintSeeds: [
        "⚠️ *Account mismatch*",
        "",
        "The transaction tried to reference an account that doesn't match what the program expects. Usually means stale data — refresh the bot menu and try again.",
        "",
        "If it keeps happening, /support and we'll dig in.",
      ].join("\n"),
      AccountNotInitialized: [
        "⚠️ *Account doesn't exist yet*",
        "",
        "The on-chain account this transaction needs hasn't been created. For a first-time deposit this is usually automatic — for other flows it may mean the program state isn't where the bot thinks it is.",
        "",
        "Retry the action. If it persists, /support.",
      ].join("\n"),
      LoanNotActive: [
        "⚠️ *Loan is no longer active*",
        "",
        "This loan has already been closed (repaid, extended, or liquidated). It's no longer borrowable / repayable.",
        "",
        "Check /positions for your CURRENT active loans, or /history for past ones.",
      ].join("\n"),
      LoanExpired: [
        "⚠️ *Loan is past its due date*",
        "",
        "The deadline passed. Any moment now a keeper will auto-liquidate it. You may not be able to extend or partial-repay anymore — your only option is to /repay in full IMMEDIATELY, before the liquidation tx lands.",
        "",
        "If liquidation already happened, your collateral has been claimed but you keep the borrowed SOL. Check /history for the final state.",
      ].join("\n"),
      InsufficientCollateral: [
        "⚠️ *Not enough collateral for this action*",
        "",
        "The collateral value relative to debt doesn't satisfy the requirement. Likely the token price moved against you between when you confirmed and when the tx landed.",
        "",
        "Try again at the current price — the bot will quote fresh numbers.",
      ].join("\n"),
      MintNotEnabled: [
        "⚠️ *This token is currently paused as collateral*",
        "",
        "The token-health watcher disabled this mint (liquidity dropped, holder concentration spiked, or another safety signal). Existing loans stay active; new borrows are blocked until the token recovers.",
        "",
        "Check /supported for currently-enabled collateral tokens.",
      ].join("\n"),
      BorrowingPaused: [
        "⚠️ *Protocol borrowing is paused*",
        "",
        "Admin paused new borrows (maintenance, emergency, etc.). Existing loans are unaffected.",
        "",
        "Try /repay or /extend if you have an active loan. New borrows will resume once admin /resume.",
      ].join("\n"),
    };
    if (knownErrors[code]) return knownErrors[code];
    // Unknown anchor error — generic fallback with the code surfaced
    return [
      `⚠️ *Transaction rejected: ${code}*`,
      "",
      "The program declined this transaction. This is a specific on-chain rule failure — common ones include past-due loans, disabled tokens, and limit issues.",
      "",
      `Tap *Ask the agent why* below — they have the full list of error codes and can usually identify exactly what triggered \`${code}\`.`,
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
