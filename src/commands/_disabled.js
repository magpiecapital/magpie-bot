/**
 * Shared handler for commands tied to the dead on-chain lending program.
 *
 * The magpie-lending program was closed on 2026-05-07. Until/unless a new
 * on-chain protocol ships, these commands have no live backend.
 *
 * The handler returns a friendly explanation and redirects users to the
 * features that *do* work (screener, risk, supported tokens, credit, etc.).
 *
 * This is intentionally simple — when the protocol comes back, route each
 * command back to its real handler instead.
 */

const MESSAGE = [
  "🔧 *Lending is temporarily paused*",
  "",
  "The Magpie lending protocol is undergoing a redesign. Token discovery and",
  "screening are still running 24/7 — you can keep using these:",
  "",
  "• /supported — browse approved tokens",
  "• /risk `<symbol>` — risk profile + market data",
  "• /price `<symbol>` — live price",
  "• /credit — your credit score",
  "• /me — your account",
  "",
  "We'll notify you when lending resumes.",
].join("\n");

export async function handleDisabledLending(ctx) {
  try {
    await ctx.reply(MESSAGE, { parse_mode: "Markdown" });
  } catch {
    // If Markdown trips (e.g. on an inline callback context), fall back.
    await ctx.reply(MESSAGE.replace(/[*`]/g, ""));
  }
}

/**
 * Inline-callback variant: same message, but answers the callback first
 * so the button doesn't show a "loading" spinner forever.
 */
export async function handleDisabledLendingCallback(ctx) {
  try {
    await ctx.answerCallbackQuery();
  } catch { /* ignore */ }
  return handleDisabledLending(ctx);
}
