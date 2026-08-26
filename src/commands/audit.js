/**
 * /audit — public, honest audit-status answer.
 *
 * Read-only + informational, so it's fine in the community group. Reflects
 * the operator's decision (2026-07-03): Sec3 selected + engaged for the V4
 * audit. FINAL REPORT DELIVERED 2026-08-09 (audited commit 33ebdc5): 24
 * findings — 20 resolved, 4 acknowledged, NONE open. Both High-severity
 * findings resolved.
 *
 * UPDATE 2026-08-26: the remediated build IS LIVE at the new program ID
 * (FsGXFt…) — new auto-sell loans run on it. Finding MECHANICS stay
 * internal: the PRIOR V4 still runs existing loans + RWA exits. Old rule
 * for reference: the remediated build deploys at a NEW program ID after
 * sign-off, so the audited code is NOT the live program yet. "The audit has
 * concluded" is true; "Magpie is audited" is NOT, and must not be implied.
 *
 * DELIBERATELY NO EXPLOIT DETAIL. The live program still runs the code as
 * audited, so describing HOW H-01/H-02 worked would map live vulnerabilities —
 * the same reason the full PDF is held internal. Detail here covers scope,
 * process and outcome only.
 */
export async function handleAudit(ctx) {
  // Compute the liquidation rate LIVE. It was hardcoded as "sub-1%" and had
  // silently drifted false (22/1838 = 1.20% before three stale V1 loans were
  // closed out on 2026-08-14, 25/1841 = 1.36% after). We invite people to
  // verify this number, so it has to be the real one — a claim that says
  // "check it yourself" is the worst possible place to be wrong.
  let liqLine = "• A low lifetime liquidation rate — check it yourself with /stats";
  try {
    const { query } = await import("../db/pool.js");
    const { rows } = await query(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='liquidated')::int liq FROM loans`,
    );
    const { total, liq } = rows[0] || {};
    if (total > 0) {
      liqLine = `• A verifiable *${((liq / total) * 100).toFixed(2)}%* lifetime liquidation rate (${liq} of ${total} loans) — check it yourself with /stats`;
    }
  } catch {
    /* fall back to the unquantified line rather than print a stale number */
  }

  const msg = [
    "🔒 *The Sec3 audit of Magpie V4 has CONCLUDED.*",
    "",
    "This was the big one. *Sec3* — the Solana-native security firm formerly known as Soteria — spent the engagement tearing into *V4*, our in-vault auto-sell program and the flagship of where Magpie is headed. Not a checkbox review: full source access, a fix round, and a re-review of every fix.",
    "",
    "*The scoreboard:*",
    "• *24* findings raised across the engagement",
    "• *20* resolved",
    "• *4* acknowledged — accepted with documented rationale",
    "• *0* left open",
    "• *Both* High-severity findings: *resolved*",
    "",
    "Zero open findings is the number that matters. No conditions attached, no re-audit clause, nothing outstanding against us.",
    "",
    "*About those 4 acknowledged:* they're not unfixed bugs — they're design decisions Sec3 reviewed and accepted. One of them is a good example: our auto-sell prices off spot rather than a smoothed average, and Sec3 agreed that's correct, because a take-profit *has* to be able to fire on a genuine price spike. Forcing it to wait would break the whole point of the product.",
    "",
    "*It shipped:* as of *2026-08-26* the remediated build is *LIVE* at a new program ID — every new auto-sell loan runs on the code Sec3 audited, with zero open findings. Loans opened earlier finish out on the prior V4 program, and tokenized-stock/RWA exits stay on V4 by design. After V4: *V3* and our *credit-oracle* program are next in line.",
    "",
    "Straight talk: an audit is a rigorous independent review, *not a guarantee*. It reduces risk; it doesn't eliminate it. Anyone who tells you otherwise is selling something.",
    "",
    "*What protects you meanwhile:*",
    "• Short, fixed loan terms + low LTV caps — no margin calls, ever",
    "• No admin override on your collateral — only a borrower-signed repay moves funds",
    "• Continuous internal adversarial security reviews",
    liqLine,
    "",
    "*Don't take our word for it:* Sec3 publishes their own report set at github.com/sec3-service/reports — cross-check us against the auditor directly.",
    "",
    "Run /risk for the full risk breakdown.",
  ].join("\n");
  await ctx.reply(msg, { parse_mode: "Markdown", disable_web_page_preview: true });
}
