/**
 * /audit — public, honest audit-status answer.
 *
 * Read-only + informational, so it's fine in the community group. Reflects
 * the operator's decision (2026-07-03): Sec3 selected + engaged for the V4
 * audit. HARD RULE: never say the protocol is "audited" — Sec3's assessment
 * is complete and the remediated fixes are in RE-REVIEW, not yet published.
 */
export async function handleAudit(ctx) {
  const msg = [
    "🔒 *Magpie — Security Audit*",
    "",
    "We've engaged *Sec3* — a Solana-native security firm (formerly Soteria) — to audit *Magpie V4*, our in-vault auto-sell program and the flagship of where the protocol is headed.",
    "",
    "*Status: Sec3's assessment of V4 is complete* — they delivered their findings, we've remediated every one on a dedicated open-source fix branch, and the fixes are back with Sec3 for *re-review*. The final report publishes after their re-check. V3 + our credit-oracle program are next in line.",
    "",
    "Straight talk: an audit is an independent, rigorous review — *not a guarantee*. It reduces risk; it doesn't eliminate it. And to be clear, *Magpie is not \"audited\" yet* — we won't claim that until Sec3 publishes the final, re-checked report.",
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
