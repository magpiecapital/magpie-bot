#!/usr/bin/env node
/**
 * Parity guard for Pip's TWO knowledge brains.
 *
 * Pip answers from two separate prose knowledge bases:
 *   - src/services/community-pip.js  (the @MagpieTalk community brain)
 *   - src/services/ai-support.js     (the DM / support brain)
 *
 * They are worded independently on purpose, so a plain diff is useless. But
 * they must agree on the load-bearing FACTS. On 2026-08-17 they didn't: the
 * support brain still carried a stale, pre-final Sec3 audit posture ("second
 * review is back … 18 resolved, 2 returned … resubmitted for the final
 * round") while the community brain had the final 20-resolved / none-open
 * result. A user asking support would have been told an outdated, incorrect,
 * LESS-favorable security status. Nothing failed — both files parse fine.
 *
 * This guard pins the canonical facts. Each rule is either:
 *   present : a fact that MUST appear in every listed brain, or
 *   absent  : a stale/forbidden phrasing that must appear in NONE of them.
 *
 * When a fact legitimately CHANGES (a new audit concludes, a tier LTV moves),
 * the fix is: update BOTH brains and this guard together. That is the whole
 * point — the guard forces the dual-brain update to be conscious, never
 * silent. Keep the fact list small and high-value; do not encode prose that
 * is expected to vary (asset counts, live metrics, dates other than the
 * audit's).
 *
 * Zero dependencies — reads the files as text, imports nothing.
 *
 * Usage: node scripts/check-pip-parity.mjs
 * Exit:  0 the brains agree · 1 a canonical fact drifted
 */
import { readFileSync } from "node:fs";

const BRAINS = {
  community: "src/services/community-pip.js",
  support: "src/services/ai-support.js",
};

// Each brain read once, lowercased for case-tolerant matching.
const text = Object.fromEntries(
  Object.entries(BRAINS).map(([k, f]) => [k, readFileSync(f, "utf8").toLowerCase()]),
);

/**
 * mode "present": every pattern must match in every brain.
 * mode "absent":  no pattern may match in any brain.
 * Patterns are matched case-insensitively (text is pre-lowercased).
 */
const RULES = [
  {
    why: "Sec3 V4 audit — final posture (24 findings · 20 resolved · 4 acknowledged · none open · both Highs resolved)",
    mode: "present",
    patterns: [/24 findings/, /20 resolved/, /4 acknowledged/, /none open/, /both high/],
  },
  {
    why: "Sec3 audit — stale INTERIM phrasing must never reappear in either brain",
    mode: "absent",
    patterns: [
      /18 resolved/,
      /2 returned/,
      /resubmitted for the final round/,
      /second review of our fixes is back/,
      /not "?audited"? until the final re-checked report/,
    ],
  },
  {
    why: "Collectibles honesty invariant — the third class is IN DESIGN / NOT LIVE, in both brains",
    mode: "present",
    patterns: [/in design/, /not live/],
  },
  {
    why: "Collectibles tier LTV ladder — Tier A up to 50% LTV, Tier B up to 40% LTV, in both brains",
    mode: "present",
    patterns: [/up to 50% ltv/, /up to 40% ltv/],
  },
  {
    why: "No margin calls — the core liquidation-model promise, in both brains",
    mode: "present",
    patterns: [/no margin call/],
  },
];

const failures = [];
for (const rule of RULES) {
  for (const [brain, body] of Object.entries(text)) {
    for (const re of rule.patterns) {
      const hit = re.test(body);
      if (rule.mode === "present" && !hit)
        failures.push(`  ✗ [${brain}] MISSING: ${re} — ${rule.why}`);
      if (rule.mode === "absent" && hit)
        failures.push(`  ✗ [${brain}] FORBIDDEN present: ${re} — ${rule.why}`);
    }
  }
}

if (failures.length) {
  console.error(`[pip-parity] FAIL — ${failures.length} canonical-fact problem(s):`);
  console.error(failures.join("\n"));
  console.error(
    "\nFix: bring BOTH brains to the same current fact, then update this guard if the fact itself changed.",
  );
  process.exit(1);
}
console.log(`[pip-parity] OK — ${RULES.length} canonical facts consistent across both brains.`);
