/**
 * Safe ticker → mint resolution.
 *
 * Multiple supported_mints rows can share the same symbol — sometimes
 * legitimately (e.g. an unrelated memecoin shipping with a 3-letter
 * symbol that happens to collide with a forgotten older mint), but
 * sometimes ADVERSARIALLY: an impersonator memecoin named "SPCX" with
 * name "SpaceX" exists alongside the real tokenized-stock SPCX named
 * "SpaceX (xStocks)". A naive `WHERE symbol = $1 LIMIT 1` query can
 * silently route a user's "borrow against my SPCX" intent through the
 * wrong tier ladder and the wrong program.
 *
 * This module is the only place in the codebase that should resolve a
 * ticker to a mint. Every call site that previously ran
 * `SELECT … FROM supported_mints WHERE UPPER(symbol) = UPPER($1)`
 * should call resolveSymbol() and react to the returned shape.
 *
 * Resolution order:
 *   1. is_canonical = TRUE AND enabled = TRUE  → unambiguous, return it
 *   2. Multiple enabled with no canonical      → AMBIGUOUS, caller MUST refuse
 *   3. Exactly one enabled, no canonical flag  → return it (still safe — only one match)
 *   4. No enabled rows                         → not found
 *
 * Callers MUST handle the AMBIGUOUS case explicitly. Pip, /risk, and
 * the AI knowledge tools should prompt the user for the explicit mint
 * pubkey rather than picking arbitrarily.
 */
import { query } from "../db/pool.js";

/**
 * @typedef {Object} SymbolResolution
 * @property {"ok"|"ambiguous"|"not_found"} status
 * @property {Object|null} mint    The chosen row when ok; null otherwise.
 *                                  Shape: { mint, symbol, name, category, decimals, is_canonical, enabled }
 * @property {Array<Object>} candidates  All enabled rows that matched the symbol.
 *                                       Always populated so the caller can list them
 *                                       to the user when status is 'ambiguous'.
 */

/**
 * Resolve a symbol to a single mint row, applying canonical-preference
 * and refusing to pick when ambiguous.
 *
 * @param {string} symbol Case-insensitive symbol.
 * @returns {Promise<SymbolResolution>}
 */
export async function resolveSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return { status: "not_found", mint: null, candidates: [] };
  }
  const trimmed = symbol.trim();
  if (trimmed.length === 0) {
    return { status: "not_found", mint: null, candidates: [] };
  }
  const { rows } = await query(
    `SELECT mint, symbol, name, category, decimals, is_canonical, enabled
       FROM supported_mints
      WHERE UPPER(symbol) = UPPER($1)
        AND enabled = TRUE
      ORDER BY is_canonical DESC, category ASC`,
    [trimmed],
  );
  if (rows.length === 0) {
    return { status: "not_found", mint: null, candidates: [] };
  }
  // Single enabled row — unambiguous.
  if (rows.length === 1) {
    return { status: "ok", mint: rows[0], candidates: rows };
  }
  // Multiple enabled rows. If exactly one is canonical, that wins.
  const canonical = rows.filter((r) => r.is_canonical);
  if (canonical.length === 1) {
    return { status: "ok", mint: canonical[0], candidates: rows };
  }
  // Ambiguous — caller must decide. Surface all candidates.
  return { status: "ambiguous", mint: null, candidates: rows };
}

/**
 * Helper that formats an ambiguous-resolution failure into a user-facing
 * disambiguation message. Use this in commands that quoted a single
 * mint result so the user sees the conflict and can pick by full mint.
 */
export function formatAmbiguousMessage(symbol, candidates) {
  const lines = [
    `"${symbol}" matches multiple enabled tokens. Pick the one you mean by mint pubkey, not by ticker:`,
    "",
  ];
  for (const c of candidates) {
    const mintShort = `${c.mint.slice(0, 8)}…${c.mint.slice(-4)}`;
    lines.push(`  • ${c.category.padEnd(8)}  ${mintShort}  ${c.name || "(no name)"}`);
  }
  return lines.join("\n");
}
