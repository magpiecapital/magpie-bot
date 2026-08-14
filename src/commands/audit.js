/**
 * /audit — public, honest audit-status answer.
 *
 * Read-only + informational, so it's fine in the community group. Reflects
 * the operator's decision (2026-07-03): Sec3 selected + engaged for the V4
 * audit. FINAL REPORT DELIVERED 2026-08-09 (audited commit 33ebdc5): 24
 * findings — 20 resolved, 4 acknowledged, NONE open. Both High-severity
 * findings resolved.
 *
 * HARD RULE, still: the remediated build deploys at a NEW program ID after
 * sign-off, so the audited code is NOT the live program yet. "V4's assessment
 * is complete" is true; "Magpie is audited" is NOT, and must not be implied.
 */
export async function handleAudit(ctx) {
  const msg = [
    "🔒 *Magpie — Security Audit*",
    "",
    "We've engaged *Sec3* — a Solana-native security firm (formerly Soteria) — to audit *Magpie V4*, our in-vault auto-sell program and the flagship of where the protocol is headed.",
    "",
    "*Status: the Sec3 audit of the V4 pool has concluded* — final report delivered 2026-08-09. Across the engagement: *24 findings* — *20 resolved*, *4 acknowledged* (accepted with documented rationale), and *none left open*. Both *High*-severity findings are resolved. Fixes sit on a dedicated fix branch and deploy at a *new program ID* after sign-off, so the audited build is not the live program yet. V3 + our credit-oracle program are next in line.",
    "",
    "Straight talk: an audit is an independent, rigorous review — *not a guarantee*. It reduces risk; it doesn't eliminate it. And to be precise: *V4's assessment is complete*, but the remediated build hasn't shipped to mainnet yet, so we still don't describe the live protocol as \"audited\". We'll say that when the audited build is the one you're borrowing against.",
    "",
    "*What protects you in the meantime:*",
    "• Fully open source — read every line: github.com/magpiecapital",
    "• Short, fixed loan terms + low LTV caps (no margin calls)",
    "• No admin override on your collateral — only borrower-signed repay moves funds",
    "• Continuous internal adversarial security reviews",
    "• A verifiable sub-1% lifetime liquidation rate (see /stats)",
    "",
    "Run /risk for the full risk breakdown. Sec3 publishes their own report set at github.com/sec3-service/reports — so you can verify our summary against them directly, not just take our word for it.",
  ].join("\n");
  await ctx.reply(msg, { parse_mode: "Markdown", disable_web_page_preview: true });
}
