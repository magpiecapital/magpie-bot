/**
 * Shared auth helpers — used by every endpoint that compares a presented
 * shared-secret against an env-configured value.
 *
 * Critical security property: comparisons are constant-time, so an attacker
 * cannot measure response-time deltas to learn the secret byte-by-byte. A
 * plain `presented !== expected` short-circuits on the first mismatch and
 * leaks the prefix length of the correct value via timing.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Returns true iff `a` and `b` are the same
 * non-empty string. False for any null/undefined/mismatched-length input.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}
