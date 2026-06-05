/**
 * Parse user-typed SOL/token amounts into exact lamport/raw integers.
 *
 * The class of bug this exists to prevent: user sees their balance rendered
 * as "7.10 SOL" (rounded for display) and types "7.1" expecting to withdraw
 * everything, but actual lamports are 7,099,897,123 — so 7.1 × 1e9 →
 * 7,100,000,000 lamports requested, on-chain rejects InsufficientFunds.
 *
 * Two principles:
 *   1. Recognized keywords ("max", "all", "100%") map to the EXACT integer
 *      balance the caller provides — never round-tripped through a SOL string.
 *   2. Numeric input is parsed in the usual way but the caller is expected
 *      to clamp the result to actual balance at submit time (see clampToMax).
 *
 * Returns { kind: "exact" | "numeric", lamports: BigInt }
 *   - "exact": caller asked for the entire balance via a keyword. Use as-is.
 *   - "numeric": caller typed a specific number. Clamp before submitting.
 */
export function parseAmountInput(input, opts) {
  const { maxLamports, decimals = 9 } = opts;
  if (maxLamports == null) throw new Error("parseAmountInput: maxLamports is required");
  const max = typeof maxLamports === "bigint" ? maxLamports : BigInt(maxLamports);
  const trimmed = String(input ?? "").trim().toLowerCase();
  if (!trimmed) return { kind: "invalid", reason: "empty input" };

  // Keywords that mean "the whole balance" — return EXACT integer.
  if (["max", "all", "everything", "100%", "100"].includes(trimmed)) {
    return { kind: "exact", lamports: max };
  }

  // Percentage: "50%", "25%", etc.
  const pctMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const p = parseFloat(pctMatch[1]);
    if (!Number.isFinite(p) || p <= 0) return { kind: "invalid", reason: "percentage must be > 0" };
    if (p > 100) return { kind: "invalid", reason: "percentage > 100" };
    // BigInt math: (max × pct_bps) / 10000 — no float drift
    const bps = BigInt(Math.round(p * 100));
    return { kind: "exact", lamports: (max * bps) / 10000n };
  }

  // Numeric: "1.5", "0.0001", etc.
  const num = parseFloat(trimmed);
  if (!Number.isFinite(num) || num <= 0) {
    return { kind: "invalid", reason: "not a valid positive number" };
  }
  const lamports = BigInt(Math.floor(num * 10 ** decimals));
  return { kind: "numeric", lamports };
}

/**
 * Final hard clamp before submitting a tx. Even if every check above is
 * bypassed by a future code change, this guarantees the requested amount
 * never exceeds the actual balance.
 *
 * Tolerance is the difference where we silently clamp vs. show an error:
 *   - requested <= max:                          use as-is
 *   - max < requested <= max + tolerance:        silently clamp to max
 *   - requested > max + tolerance:               return { ok: false }
 *
 * Default tolerance: 0.001 SOL (1,000,000 lamports) — well above any
 * realistic 4-decimal display rounding error.
 */
export function clampToMax(lamports, maxLamports, tolerance = 1_000_000n) {
  const req = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  const max = typeof maxLamports === "bigint" ? maxLamports : BigInt(maxLamports);
  if (req <= max) return { ok: true, lamports: req, clamped: false };
  if (req <= max + tolerance) return { ok: true, lamports: max, clamped: true };
  return { ok: false, lamports: req, max, overage: req - max };
}
