/**
 * /audit — public, honest audit-status answer.
 *
 * Read-only + informational, so it's fine in the community group. Reflects
 * the operator's decision (2026-07-03): Sec3 selected + engaged for the V4
 * audit. HARD RULE: never say the protocol is "audited" — the audit is
 * UNDERWAY, not complete.
 */
export async function handleAudit(ctx) {
  const msg = [
    "🔒 *Magpie — Security Audit*",
    "",
    "We engaged *Sec3* — a Solana-native security firm (formerly Soteria) — to audit *Magpie V4*, our in-vault auto-sell program and the flagship of where the protocol is headed.",
    "",
    "*Status: initial assessment complete; fixes submitted for re-review.* Sec3 delivered their findings — *22 in total (2 high, 3 medium, 8 low, 6 informational, 3 questions)* — and we've *implemented fixes for every one* and sent the updated program back to Sec3 for re-verification. The full report publishes after that re-check. V3 + our credit-oracle program are next in line.",
    "",
    "Straight talk: an audit is an independent, rigorous review — *not a guarantee*. It reduces risk; it doesn't eliminate it. And to be clear, *Magpie is not \"audited\" yet* — the reviewed-and-fixed version ships with the re-audit.",
    "",
    "*What protects you in the meantime:*",
    "• Fully open source — read every line: github.com/magpiecapital",
    "• Short, fixed loan terms + low LTV caps (no margin calls)",
    "• No admin override on your collateral — only borrower-signed repay moves funds",
    "• Continuous internal adversarial security reviews",
    "• A verifiable sub-1% lifetime liquidation rate (see /stats)",
    "",
    "Run /risk for the full risk breakdown. We'll announce here the moment the Sec3 report ships.",
  ].join("\n");
  await ctx.reply(msg, { parse_mode: "Markdown", disable_web_page_preview: true });
}
