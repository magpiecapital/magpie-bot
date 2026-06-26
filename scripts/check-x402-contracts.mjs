#!/usr/bin/env node
/**
 * Static check: pin the cross-service field contracts between the bot
 * (this repo) and the magpie-x402 agent-lending service. These three
 * contracts are NOT enforced by the type system or by `node --check` —
 * they are plain string/shape couplings across two separately-deployed
 * codebases. A silent rename on either side compiles fine here and only
 * breaks at runtime, AFTER an agent has already been charged.
 *
 * WHY THIS GUARD EXISTS — the 5-bug x402 outage (2026-06-24):
 *
 *   On 2026-06-24 a wave of agent borrows failed end-to-end because the
 *   field names the two services exchange drifted apart. Each of these
 *   is a cross-service contract whose drift is invisible to the compiler
 *   but fatal at runtime:
 *
 *   1. COSIGN FIELD NAME — the x402 SDK and the site proxy POST the
 *      partial-signed borrow tx as `{ partialSignedTxBase64 }`. If
 *      cosign-borrow.js stops reading that exact key, EVERY agent (and
 *      site) borrow's final co-sign step 400s "Missing
 *      partialSignedTxBase64" → charged-but-no-loan.
 *
 *   2. BUILD-BORROW SUMMARY FIELDS — handleAgentBuildBorrow returns a
 *      `summary` whose snake_case keys (`loan_id`, `principal_sol`,
 *      `fee_sol`) the x402 service's adapter maps to camelCase + lamports.
 *      Drop/rename any one and the adapter silently emits undefined loan
 *      ids / NaN amounts to the agent.
 *
 *   3. INTERNAL-AUTH ERROR CONTRACT — magpie-x402 PR #83 made the refund
 *      remap trigger ONLY on `401 { error: "unauthorized" }`. That is how
 *      the service distinguishes a genuine misconfig (refund the agent)
 *      from a real rejection (don't). If a dev renames the "unauthorized"
 *      string or changes the 401, the service stops refunding genuine
 *      charged-but-denied cases — the agent pays and gets nothing, with
 *      no refund.
 *
 * Run locally: node scripts/check-x402-contracts.mjs
 * Run in CI:    same — exits non-zero on any violation.
 *
 * Each violation prints `file: reason`. Keep the assertions tolerant of
 * whitespace + quote-style (single/double) variants, but specific enough
 * that a real rename trips them.
 *
 * Extend by adding a check function to CHECKS below. Keep the list
 * narrow — false positives waste developer time on rebuilds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = (rel) => join(REPO_ROOT, rel);

/** Collected violations: each entry is `{ file, reason }`. */
const violations = [];
function fail(file, reason) {
  violations.push({ file, reason });
}

/**
 * Crude comment + string stripper, mirroring check-shared-imports.mjs.
 * We use it where we must assert on REAL code (e.g. the runtime summary
 * object) and must NOT be satisfied by a matching token that only lives
 * in a JSDoc block or a user-facing string.
 *
 * NOTE: stripping string CONTENTS leaves empty quotes `""` in place, so
 * structural assertions that need a string VALUE (e.g. error: "unauthorized")
 * must run against the RAW source, not the stripped copy.
 */
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readSrc(rel) {
  try {
    return readFileSync(SRC(rel), "utf8");
  } catch (e) {
    fail(rel, `cannot read file (${e.code || e.message}). The x402 contract guard expects this file to exist — if it was moved/renamed, update scripts/check-x402-contracts.mjs.`);
    return null;
  }
}

// ── Contract 1: COSIGN FIELD NAME ────────────────────────────────────
// cosign-borrow.js must read `partialSignedTxBase64` off the request
// body. We require the literal token to appear as a body read, i.e.
// `body.partialSignedTxBase64` or `body?.partialSignedTxBase64` (quote /
// whitespace insensitive — it's a plain JS identifier, not a string).
function checkCosignFieldName() {
  const rel = "src/api/cosign-borrow.js";
  const src = readSrc(rel);
  if (src === null) return;
  const code = stripCommentsAndStrings(src);
  // body  .  partialSignedTxBase64    (allow optional-chaining + spacing)
  const bodyReadRe = /\bbody\s*\??\.\s*partialSignedTxBase64\b/;
  if (!bodyReadRe.test(code)) {
    fail(
      rel,
      "must read `body.partialSignedTxBase64` (the exact field the x402 SDK + site proxy POST to /api/v1/cosign-borrow). It is missing — a rename here 400s every agent/site borrow's final co-sign ('Missing partialSignedTxBase64') = charged-but-no-loan. See the 2026-06-24 x402 outage.",
    );
  }
}

// ── Contract 2: BUILD-BORROW SUMMARY FIELDS ──────────────────────────
// handleAgentBuildBorrow must emit a `summary: { ... }` object carrying
// the snake_case keys loan_id / principal_sol / fee_sol that the x402
// adapter maps to camelCase + lamports. We locate the runtime summary
// object (NOT the JSDoc) by stripping comments/strings first, then
// asserting all three keys appear as object keys inside it.
function checkBuildBorrowSummaryFields() {
  const rel = "src/api/agent.js";
  const src = readSrc(rel);
  if (src === null) return;
  const code = stripCommentsAndStrings(src);

  // Anchor on the build-borrow handler so we don't accidentally match a
  // `summary:` object belonging to some other handler in the same file.
  const handlerIdx = code.indexOf("handleAgentBuildBorrow");
  if (handlerIdx === -1) {
    fail(
      rel,
      "could not find `handleAgentBuildBorrow` — the x402 build-borrow contract guard cannot verify its summary fields. If the handler was renamed, update scripts/check-x402-contracts.mjs.",
    );
    return;
  }
  const afterHandler = code.slice(handlerIdx);

  // Find a `summary:` object literal in the handler and capture its body
  // up to the matching close brace via a brace counter (regex can't match
  // balanced braces). Find the `summary:` token, then walk braces.
  const summaryKeyIdx = afterHandler.search(/\bsummary\s*:\s*\{/);
  if (summaryKeyIdx === -1) {
    fail(
      rel,
      "handleAgentBuildBorrow no longer constructs a `summary: { ... }` object — the x402 adapter reads this object. Restore it (with loan_id / principal_sol / fee_sol) or the agent receives no loan metadata.",
    );
    return;
  }
  const braceOpen = afterHandler.indexOf("{", summaryKeyIdx);
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < afterHandler.length; i++) {
    const c = afterHandler[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const summaryBody = end === -1 ? afterHandler.slice(braceOpen) : afterHandler.slice(braceOpen, end + 1);

  const requiredKeys = ["loan_id", "principal_sol", "fee_sol"];
  const missing = requiredKeys.filter((k) => {
    // key as an object property: `loan_id:` (whitespace tolerant).
    const keyRe = new RegExp(`\\b${k}\\s*:`);
    return !keyRe.test(summaryBody);
  });
  if (missing.length > 0) {
    fail(
      rel,
      `handleAgentBuildBorrow summary is missing required key(s): ${missing.join(", ")}. The x402 service's adapter maps these snake_case keys to camelCase + lamports; dropping/renaming any emits undefined loan ids or NaN amounts to the paying agent. See the 2026-06-24 x402 outage.`,
    );
  }
}

// ── Contract 3: INTERNAL-AUTH ERROR CONTRACT ─────────────────────────
// magpie-x402 PR #83 refunds the agent ONLY when the bot returns
// 401 { error: "unauthorized" } on an INTERNAL_API_TOKEN mismatch.
// Each agent endpoint must keep returning exactly that on the
// constantTimeEqual(presented, INTERNAL_API_TOKEN) failure branch.
//
// The four files use slightly different return SHAPES:
//   agent.js / agent-repay.js : return { status: 401, body: { error: "unauthorized" } }
//   agent-manage.js           : return { error: { status: 401, body: { error: "unauthorized" } } }
//   agent-intents.js          : return { ok:false, status: 401, error: "unauthorized" }
// We don't pin the wrapper shape — we pin the invariant: the auth-mismatch
// return must contain BOTH a 401 AND `error: "unauthorized"` (quote-style
// + whitespace tolerant). We locate the mismatch branch via the
// constantTimeEqual(... INTERNAL_API_TOKEN ...) guard and inspect the
// `return` statement that immediately follows it.
function checkInternalAuthErrorContract() {
  const files = [
    "src/api/agent.js",
    "src/api/agent-repay.js",
    "src/api/agent-manage.js",
    "src/api/agent-intents.js",
  ];
  for (const rel of files) {
    const src = readSrc(rel);
    if (src === null) continue;
    const code = stripCommentsAndStrings(src);

    // Locate the auth-mismatch guard. Allow either argument order inside
    // constantTimeEqual(...) and arbitrary spacing.
    const guardRe = /if\s*\(\s*!\s*constantTimeEqual\s*\([^)]*INTERNAL_API_TOKEN[^)]*\)\s*\)\s*\{/;
    const m = guardRe.exec(code);
    if (!m) {
      fail(
        rel,
        "could not find the `if (!constantTimeEqual(..., INTERNAL_API_TOKEN))` auth-mismatch guard. The x402 refund remap (PR #83) keys on the 401 { error: \"unauthorized\" } this branch returns — the guard cannot verify it. If the auth check was refactored, update scripts/check-x402-contracts.mjs.",
      );
      continue;
    }

    // Walk from the guard's open brace to its matching close brace; that
    // block contains the auth-mismatch return.
    const openIdx = code.indexOf("{", m.index);
    let depth = 0;
    let blockEnd = -1;
    for (let i = openIdx; i < code.length; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          blockEnd = i;
          break;
        }
      }
    }
    const block = blockEnd === -1 ? code.slice(openIdx) : code.slice(openIdx, blockEnd + 1);

    // Invariant 1: the block must return a 401.
    const has401 = /\bstatus\s*:\s*401\b/.test(block);
    // Invariant 2: the block must carry `error: "unauthorized"`. Comments
    // are already stripped, but string CONTENTS were blanked by the
    // stripper — so assert the string value against the RAW source,
    // scoped to the SAME block by line range.
    // Recover the raw block by matching the same brace span on the raw src.
    const rawOpenIdx = src.indexOf("constantTimeEqual");
    // Re-find raw guard precisely: search raw for the same guard text head.
    const rawGuardRe = /if\s*\(\s*!\s*constantTimeEqual\s*\([^)]*INTERNAL_API_TOKEN[^)]*\)\s*\)\s*\{/;
    const rawM = rawGuardRe.exec(src);
    let rawBlock = "";
    if (rawM) {
      const rOpen = src.indexOf("{", rawM.index);
      let rDepth = 0;
      let rEnd = -1;
      for (let i = rOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") rDepth++;
        else if (c === "}") {
          rDepth--;
          if (rDepth === 0) {
            rEnd = i;
            break;
          }
        }
      }
      rawBlock = rEnd === -1 ? src.slice(rOpen) : src.slice(rOpen, rEnd + 1);
    } else {
      void rawOpenIdx;
      rawBlock = src; // fallback: search whole file (still scoped by token below)
    }
    // error : "unauthorized"  (single or double quotes, any spacing)
    const hasUnauthorized = /\berror\s*:\s*(["'])unauthorized\1/.test(rawBlock);

    if (!has401 || !hasUnauthorized) {
      const parts = [];
      if (!has401) parts.push("a 401 status");
      if (!hasUnauthorized) parts.push('error: "unauthorized"');
      fail(
        rel,
        `the INTERNAL_API_TOKEN auth-mismatch branch must return ${parts.join(" and ")}. magpie-x402 PR #83 refunds genuine misconfigs ONLY on 401 { error: "unauthorized" }; changing this string/status makes the x402 service stop refunding charged-but-denied agents. See the 2026-06-24 x402 outage.`,
      );
    }
  }
}

const CHECKS = [
  checkCosignFieldName,
  checkBuildBorrowSummaryFields,
  checkInternalAuthErrorContract,
];

for (const check of CHECKS) check();

if (violations.length > 0) {
  console.error(
    `\nx402 cross-service contract check FAILED — ${violations.length} violation(s).\n` +
      `These contracts pin the bot<->magpie-x402 field couplings whose drift caused the 5-bug x402 outage on 2026-06-24 (refund remap = magpie-x402 PR #83). A break here charges agents but delivers no loan / no refund.\n`,
  );
  for (const v of violations) {
    console.error(`${v.file}: ${v.reason}`);
  }
  process.exit(1);
}

console.log("x402 cross-service contract check passed");
