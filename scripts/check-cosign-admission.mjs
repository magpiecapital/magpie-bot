#!/usr/bin/env node
/**
 * Guard for cosign admission control.
 *
 * The worst outcome here is NOT "a flood got through" — it is "a slot leaked
 * and real borrows are permanently refused". A counter that climbs and never
 * comes back down would take the borrow path down harder than any flood, so
 * the release paths are tested first and hardest.
 */
import { admitCosign, getCosignAdmissionStats } from "../src/middleware/cosign-admission.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error(`✕ ${name}`); } else console.log(`✓ ${name}`);
};
const reqFrom = (ip) => new Request("https://x/y", { headers: ip ? { "x-forwarded-for": ip } : {} });

// ── release correctness: the failure that would break borrows ──────────────
{
  const before = getCosignAdmissionStats().inflight;
  const a = admitCosign(reqFrom("1.1.1.1"));
  check("admitted under capacity", a.ok === true);
  check("in-flight rises while held", getCosignAdmissionStats().inflight === before + 1);
  a.release();
  check("release() returns the slot", getCosignAdmissionStats().inflight === before);
  a.release(); a.release();
  check("release() is idempotent — a double release cannot corrupt the count",
    getCosignAdmissionStats().inflight === before);
}
{
  // A handler that THROWS must not leak a slot — this is the real-world path.
  const before = getCosignAdmissionStats().inflight;
  const adm = admitCosign(reqFrom("1.1.1.2"));
  try {
    try { throw new Error("handler blew up"); } finally { adm.release(); }
  } catch { /* expected */ }
  check("a throwing handler still releases its slot", getCosignAdmissionStats().inflight === before);
}

// ── fail-open ──────────────────────────────────────────────────────────────
{
  const a = admitCosign({});                     // malformed request object
  check("malformed request fails OPEN (admitted)", a.ok === true);
  a.release();
  const b = admitCosign(reqFrom(null));          // no client IP
  check("unattributable request is admitted, not punished", b.ok === true);
  b.release();
}

// ── the in-flight cap ──────────────────────────────────────────────────────
{
  const held = [];
  for (let i = 0; i < 12; i++) {
    const a = admitCosign(reqFrom(`10.0.0.${i}`));
    if (a.ok) held.push(a);
  }
  check("12 concurrent are admitted", held.length === 12);
  const over = admitCosign(reqFrom("10.0.1.1"));
  check("the 13th concurrent is refused", over.ok === false);
  check("refusal is 503", over.ok === false && over.response.status === 503);
  check("refusal is explicitly RETRYABLE with a retry_after",
    over.ok === false && over.response.body.retryable === true && over.response.body.retry_after_seconds > 0);
  check("refusal states nothing was signed",
    over.ok === false && /not submitted|nothing was signed/i.test(over.response.body.detail));
  held.forEach((h) => h.release());
  check("all slots return after release", getCosignAdmissionStats().inflight === 0);
  const after = admitCosign(reqFrom("10.0.1.2"));
  check("service recovers and admits again once drained", after.ok === true);
  after.release();
}

// ── per-IP rate limiting, and that it cannot starve another borrower ───────
{
  const ip = "203.0.113.5";
  let refused = 0;
  for (let i = 0; i < 20; i++) {
    const a = admitCosign(reqFrom(ip));
    if (a.ok) a.release(); else refused++;
  }
  check("a single IP hammering is eventually rate-limited", refused > 0);
  const other = admitCosign(reqFrom("203.0.113.6"));
  check("a DIFFERENT borrower is unaffected by that abuser", other.ok === true);
  if (other.ok) other.release();
  check("in-flight is back to zero — no leak across the whole run",
    getCosignAdmissionStats().inflight === 0);
}

if (failed) { console.error(`\n[cosign-admission] ${failed} check(s) failed.`); process.exit(1); }
console.log("\n[cosign-admission] OK — bounds a flood, never leaks a slot, always fails open.");
