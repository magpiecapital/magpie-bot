/**
 * Strike-price parser — the ONE source of truth for "what does this
 * user-typed strike mean."
 *
 * Used by:
 *   - TG /takeprofit /stoploss commands (src/commands/limit-close.js)
 *   - Pip propose_takeprofit / propose_stoploss / propose_trailing_stop
 *     tools (src/services/community-pip.js, src/services/ai-support.js)
 *   - Site dashboard arm panel + modify panel (via the
 *     /api/v1/internal/parse-strike helper endpoint)
 *
 * Keeping all three behind ONE parser prevents the surfaces from
 * drifting. A user can type "17,000,000 MC" in TG and "17M mc" on
 * the dashboard and "take profit at seventeen million market cap"
 * to Pip — all three should resolve to the same trigger_value_micro
 * and trigger_kind.
 *
 * Inputs the parser MUST accept (operator-stated 2026-06-14):
 *
 *   Market caps (resolves to trigger_kind="mc_usd"):
 *     "17m mc", "17M MC", "17m market cap", "17M marketcap"
 *     "17,000,000 mc", "17,000,000 MC", "$17m mc", "$17M MC"
 *     "17 million mc", "17 million market cap"
 *     "17m" / "17M" → ambiguous, default to MC for big numbers (>=100k)
 *
 *   USD prices (resolves to trigger_kind="price_usd"):
 *     "$0.005", "0.005 usd", "0.005 dollars"
 *     "5 cents", "$5", "$5.00", "5.0"
 *     "0.0025 sol" → trigger_kind="price_sol", BigInt lamports
 *
 *   Multipliers (resolves to multiplier; caller resolves to price_usd):
 *     "2x", "1.5x", "1.5X"
 *     "0.7x" / "0.5x" for stop-loss
 *     "-30%" / "30% down" / "down 30%"  (SL direction; multiplier = 0.7)
 *     "+50%" / "50% up" / "up 50%"      (TP direction; multiplier = 1.5)
 *
 * Returns a structured result the caller can pass straight to armOrder():
 *   {
 *     ok: true,
 *     kind: "mc_usd" | "price_usd" | "price_sol" | "multiplier",
 *     valueMicro: BigInt | null,    // null when kind="multiplier"
 *     multiplier: number | null,    // only set when kind="multiplier"
 *     impliedDirection: "above" | "below" | null,
 *     normalizedDisplay: string,    // human-readable for echo
 *   }
 *   OR
 *   { ok: false, error: string, examples?: string[] }
 *
 * Numbers DON'T need to be integers. "0.5m mc" = $500k MC. "1.7M MC" works.
 *
 * Whitespace in numbers is tolerated. "1 7 m" → not a number; reject.
 * Underscore separators tolerated. "17_000_000" → 17M.
 *
 * Implementation philosophy: prefer obvious matches with a fallback
 * heuristic for ambiguous cases. NEVER guess silently when the input
 * is ambiguous about direction (e.g. "17m" could be MC or price for a
 * memecoin trading at $0.00005); use the caller-supplied
 * `directionHint` ("above" for TP, "below" for SL) only as a tiebreak,
 * not as authoritative kind detection.
 *
 * The parser is intentionally permissive but ALWAYS deterministic — same
 * input string always parses to the same result.
 */

const MAGNITUDE_WORDS = new Map([
  ["k", 1_000],
  ["thousand", 1_000],
  ["m", 1_000_000],
  ["mil", 1_000_000],
  ["mm", 1_000_000],
  ["million", 1_000_000],
  ["b", 1_000_000_000],
  ["bn", 1_000_000_000],
  ["bil", 1_000_000_000],
  ["billion", 1_000_000_000],
  ["t", 1_000_000_000_000],
  ["tn", 1_000_000_000_000],
  ["trillion", 1_000_000_000_000],
]);

// Synonyms — all collapse to the same canonical kind.
const MC_WORDS = new Set([
  "mc", "mcap", "marketcap", "mktcap",
  "market", "marketcap",
  "market_cap", "mkt_cap", "mc_usd",
]);
const PRICE_USD_WORDS = new Set([
  "price", "usd", "dollars", "dollar", "usdc", "cents", "cent",
  "price_usd",
]);
const PRICE_SOL_WORDS = new Set([
  "sol", "lamports", "lamport", "price_sol",
]);

// "1 7 m" is two tokens; we want one. Normalize commas, underscores,
// and condense whitespace inside a number.
function normalizeInput(s) {
  if (typeof s !== "string") return "";
  return s
    .trim()
    .toLowerCase()
    .replace(/ /g, " ")   // nbsp
    .replace(/\s+/g, " ");
}

function stripFormattingChars(numStr) {
  return numStr.replace(/[,_]/g, "");
}

// Detect "down N%", "up N%", "-N%", "+N%" → returns {ok, multiplier, direction}.
function parsePercentMove(s) {
  // "down 30%"
  let m = s.match(/^down\s+([0-9]+(?:\.[0-9]+)?)\s*%$/);
  if (m) return { ok: true, multiplier: 1 - Number(m[1]) / 100, direction: "below" };
  // "up 50%"
  m = s.match(/^up\s+([0-9]+(?:\.[0-9]+)?)\s*%$/);
  if (m) return { ok: true, multiplier: 1 + Number(m[1]) / 100, direction: "above" };
  // "-30%" or "30% down"
  m = s.match(/^[-]\s*([0-9]+(?:\.[0-9]+)?)\s*%$/);
  if (m) return { ok: true, multiplier: 1 - Number(m[1]) / 100, direction: "below" };
  m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*%\s*down$/);
  if (m) return { ok: true, multiplier: 1 - Number(m[1]) / 100, direction: "below" };
  // "+50%" or "50% up"
  m = s.match(/^[+]\s*([0-9]+(?:\.[0-9]+)?)\s*%$/);
  if (m) return { ok: true, multiplier: 1 + Number(m[1]) / 100, direction: "above" };
  m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*%\s*up$/);
  if (m) return { ok: true, multiplier: 1 + Number(m[1]) / 100, direction: "above" };
  return null;
}

// "2x", "1.5x", "0.7x" — multiplier.
function parseMultiplier(s) {
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*x$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Extracts the leading number from a token, returning {num, rest}.
// Accepts $0.005, 17,000,000, 17_000_000, etc.
function extractLeadingNumber(s) {
  const m = s.match(/^\$?\s*([0-9][0-9_,]*(?:\.[0-9]+)?)\s*(.*)$/);
  if (!m) return null;
  const raw = stripFormattingChars(m[1]);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return { num: n, rest: m[2].trim() };
}

// Resolves trailing magnitude word (m, mm, million, b, billion, k, etc.)
// into a multiplier. Eats one word from `rest`. Returns {factor, rest}.
function extractMagnitudeWord(rest) {
  if (!rest) return { factor: 1, rest: "" };
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { factor: 1, rest: "" };
  const head = tokens[0].toLowerCase().replace(/[.,!?]$/, "");
  if (MAGNITUDE_WORDS.has(head)) {
    return { factor: MAGNITUDE_WORDS.get(head), rest: tokens.slice(1).join(" ") };
  }
  return { factor: 1, rest };
}

// Resolves a trailing kind word (mc, usd, sol) to a canonical kind.
// Eats one or two words. Returns {kind, rest}.
function extractKindWord(rest) {
  if (!rest) return { kind: null, rest: "" };
  const lower = rest.toLowerCase();
  // Multi-word: "market cap", "marketcap"
  const mcMatch = lower.match(/^(market\s*cap|market_cap)\b\s*(.*)/);
  if (mcMatch) return { kind: "mc_usd", rest: mcMatch[2].trim() };
  const tokens = lower.split(/\s+/).filter(Boolean);
  const head = tokens[0]?.replace(/[.,!?]$/, "");
  if (!head) return { kind: null, rest: "" };
  if (MC_WORDS.has(head)) return { kind: "mc_usd", rest: tokens.slice(1).join(" ") };
  if (PRICE_USD_WORDS.has(head)) return { kind: "price_usd", rest: tokens.slice(1).join(" ") };
  if (PRICE_SOL_WORDS.has(head)) return { kind: "price_sol", rest: tokens.slice(1).join(" ") };
  return { kind: null, rest };
}

function fmtDisplayMc(usd) {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B MC`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M MC`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K MC`;
  return `$${usd.toFixed(2)} MC`;
}
function fmtDisplayUsd(usd) {
  if (usd >= 1) return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(8).replace(/0+$/, "0")}`;
}

// MIN/MAX trigger value bounds — must match limit-close-arm-core.js.
const MIN_MICRO = 1n;
const MAX_MICRO = 1_000_000_000_000_000n;

function toMicro(num) {
  const micro = BigInt(Math.round(num * 1e6));
  if (micro < MIN_MICRO) return null;
  if (micro > MAX_MICRO) return null;
  return micro;
}

/**
 * Parse a strike-price input string into a structured arm-ready result.
 *
 * Optional opts.directionHint ("above" for TP, "below" for SL) is used
 * ONLY as a tiebreak when the input is genuinely ambiguous. The parser
 * never silently overrides an explicit direction word.
 *
 * Optional opts.bareNumberDefaultKind controls the kind assigned to a
 * bare number (no magnitude word, no kind word). Default: "price_usd"
 * for sub-100 numbers, "mc_usd" for 100k+ numbers — matches how users
 * mentally bucket "$0.005" vs "17000000".
 */
export function parseStrike(raw, opts = {}) {
  const norm = normalizeInput(raw);
  if (!norm) {
    return {
      ok: false,
      error: "Empty target. Try `17m mc` or `$0.005` or `2x`.",
    };
  }

  // 1. Percent-move forms first (most explicit).
  const pct = parsePercentMove(norm);
  if (pct) {
    return {
      ok: true,
      kind: "multiplier",
      valueMicro: null,
      multiplier: pct.multiplier,
      impliedDirection: pct.direction,
      normalizedDisplay: `${pct.multiplier > 1 ? "+" : ""}${((pct.multiplier - 1) * 100).toFixed(1)}% (${pct.direction === "above" ? "TP" : "SL"})`,
    };
  }

  // 2. Multiplier ("2x", "0.7x")
  const mult = parseMultiplier(norm);
  if (mult != null) {
    const dir = mult >= 1 ? "above" : "below";
    return {
      ok: true,
      kind: "multiplier",
      valueMicro: null,
      multiplier: mult,
      impliedDirection: dir,
      normalizedDisplay: `${mult}x (${dir === "above" ? "TP" : "SL"})`,
    };
  }

  // 3. Standard form: <number> [<magnitude word>] [<kind word>]
  const numHead = extractLeadingNumber(norm);
  if (!numHead) {
    return {
      ok: false,
      error: `Couldn't parse target "${raw}". Try \`17m mc\` (market cap), \`$0.005\` (price), or \`2x\` (multiplier).`,
      examples: ["17m mc", "$0.005", "2x", "down 30%"],
    };
  }
  const { num, rest: afterNum } = numHead;

  // 4. Magnitude word — multiplies the number.
  const { factor, rest: afterFactor } = extractMagnitudeWord(afterNum);
  const adjustedNum = num * factor;

  // 5. Kind word — explicit "mc", "usd", "sol".
  const { kind: explicitKind, rest: afterKind } = extractKindWord(afterFactor);
  if (afterKind && afterKind.length > 0) {
    return {
      ok: false,
      error: `Trailing text after target: "${afterKind}". Try \`17m mc\` (just the value).`,
    };
  }

  let kind = explicitKind;
  if (!kind) {
    // Bare number: infer based on size + bareNumberDefaultKind.
    // - Big numbers (>= 100k effective) → MC by default
    // - Small numbers (< 100k) with no explicit kind → USD price
    // Operator can override per-surface via opts.bareNumberDefaultKind.
    const defaultKind = opts.bareNumberDefaultKind
      || (adjustedNum >= 100_000 ? "mc_usd" : "price_usd");
    kind = defaultKind;
  }

  if (adjustedNum <= 0) {
    return { ok: false, error: `Target must be positive.` };
  }

  if (kind === "price_sol") {
    // SOL price stored in lamports (1e9 precision).
    const lamports = BigInt(Math.round(adjustedNum * 1e9));
    if (lamports < MIN_MICRO || lamports > MAX_MICRO) {
      return { ok: false, error: `Target out of range.` };
    }
    return {
      ok: true,
      kind: "price_sol",
      valueMicro: lamports,
      multiplier: null,
      impliedDirection: null,
      normalizedDisplay: `${adjustedNum.toFixed(6)} SOL`,
    };
  }

  // mc_usd and price_usd both stored as micros at 1e6 precision.
  const micro = toMicro(adjustedNum);
  if (!micro) {
    return { ok: false, error: `Target out of range.` };
  }
  return {
    ok: true,
    kind,
    valueMicro: micro,
    multiplier: null,
    impliedDirection: null,
    normalizedDisplay: kind === "mc_usd" ? fmtDisplayMc(adjustedNum) : fmtDisplayUsd(adjustedNum),
  };
}

/**
 * Convenience: parse a strike and emit a one-line user-facing echo
 * confirming what we understood. Surfaces ambiguous parses with hints.
 */
export function describeStrike(raw, opts = {}) {
  const r = parseStrike(raw, opts);
  if (!r.ok) return r.error;
  return `Got it: ${r.normalizedDisplay}`;
}
