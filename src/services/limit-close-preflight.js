/**
 * Pre-flight liquidity check for limit-close orders.
 *
 * Before accepting an arm (TG or x402-agent), call this to verify
 * that selling the loan's collateral at the user's slippage WOULD
 * clear at current liquidity. Refuses orders that the market clearly
 * cannot sustain at the chosen slippage, returning a suggested
 * slippage that would have worked.
 *
 * Why this is a sanity check, NOT a guarantee:
 *   The trigger fires at a FUTURE price level. Liquidity at that
 *   future moment may be very different from now (deeper because of
 *   hype; thinner because of dumping; gone because of token death).
 *   We're catching the obvious "you typed 1% slippage and your token
 *   trades at 12% impact" case at arm time so the user doesn't
 *   discover it weeks later when their trigger hits.
 *
 *   For thin-liquidity collateral the call should be paired with
 *   the engine's TWAP fallback (Layer 2) and intervention DM (Layer 3)
 *   — those layers handle the runtime side.
 *
 * Security:
 *   - Network failures fall through with allow=true + warning='quote_api_unreachable'.
 *     Don't block users because Jupiter is having a bad day; the
 *     engine's runtime safety floor is the actual guarantee.
 *   - All numeric inputs are coerced to BigInt before arithmetic;
 *     no float drift in the proceeds-vs-owed comparison.
 *   - We never accept caller-supplied "skip preflight" flags. Every
 *     arm goes through this gate. (Operator kill switch is separate.)
 */
import axios from "axios";
import { MAX_PROTOCOL_SLIPPAGE_BPS } from "../lib/slippage-constants.js";

const JUP_QUOTE_API = process.env.JUPITER_QUOTE_API || "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Slippage levels we sweep when the user's setting doesn't clear,
// looking for the lowest level that would have worked. Returned to
// the user as a suggestion so they can re-arm with a realistic value.
const SUGGESTION_SWEEP_BPS = [100, 200, 300, 500, 750, 1000];

// Buffer above (owed + protocol_fee) we require for the order to be
// considered "would clear." 50 bps = 0.5%. Smaller than the smallest
// slippage step so a user setting exactly the floor doesn't get
// rejected for a rounding error.
const PROCEEDS_BUFFER_BPS = 50n;

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//.test(s);
}

/**
 * Fetch one Jupiter quote.
 * Returns { ok, outAmountLamports: BigInt, route, raw } on success.
 * Returns { ok: false, reason } on failure.
 */
async function fetchQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
  if (!isHttpUrl(JUP_QUOTE_API)) {
    return { ok: false, reason: "jupiter_url_invalid" };
  }
  const url = `${JUP_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}` +
              `&amount=${amountRaw}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  let res;
  try {
    res = await axios.get(url, { timeout: 4_000 });
  } catch (err) {
    return { ok: false, reason: "quote_api_unreachable", detail: err.message?.slice(0, 100) };
  }
  const data = res?.data;
  if (!data || !data.outAmount || data.outAmount === "0") {
    return { ok: false, reason: "no_route" };
  }
  let outAmountLamports;
  try { outAmountLamports = BigInt(data.outAmount); }
  catch { return { ok: false, reason: "non_numeric_out_amount" }; }
  return { ok: true, outAmountLamports, raw: data };
}

/**
 * Run the pre-flight check.
 *
 * Inputs (all required):
 *   collateralMint              — string base58
 *   collateralAmountRaw         — string of decimal raw units
 *   sellDestination             — 'sol' | 'usdc'
 *   slippageBps                 — integer 10..1000
 *   loanOwedLamports            — BigInt or string
 *   protocolFeeBps              — integer (default 100)
 *
 * Output:
 *   {
 *     ok: true,
 *     proceedsLamports: <string>,
 *     quotedAtIso: <string>,
 *   }
 *  OR
 *   {
 *     ok: false,
 *     reason: <code>,
 *     detail?: <string>,
 *     suggestedSlippageBps?: <integer>,    // when reason='slippage_too_low'
 *     wouldClearAt?: <string>,             // human label
 *   }
 *  OR (network failure → fail-open)
 *   { ok: true, advisory: { reason, detail } }
 */
export async function runArmPreflight({
  collateralMint,
  collateralAmountRaw,
  sellDestination,
  slippageBps,
  loanOwedLamports,
  protocolFeeBps,
}) {
  // ── Shape coercion / validation ──────────────────────────────
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(collateralMint || ""))) {
    return { ok: false, reason: "invalid_collateral_mint" };
  }
  if (!/^\d{1,30}$/.test(String(collateralAmountRaw || ""))) {
    return { ok: false, reason: "invalid_collateral_amount" };
  }
  const amountBI = BigInt(collateralAmountRaw);
  if (amountBI <= 0n) return { ok: false, reason: "zero_collateral_amount" };
  const dst = sellDestination === "usdc" ? USDC_MINT : SOL_MINT;
  // 2026-06-13: preflight previously refused slippage > 1000 bps but
  // arm-core's effectiveCap defaults to DEFAULT_CAP_FLOOR_BPS = 2500
  // (the MAX_PROTOCOL_SLIPPAGE_BPS) so EVERY default-cap arm hit this
  // refusal — caught by the RWA dry-run on 2026-06-13. Aligning the
  // ceiling with the protocol-wide constant so the two layers agree.
  // The actual fill-quality protection is the no_route / slippage_too_low
  // checks below — those still flag a route that won't clear.
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > MAX_PROTOCOL_SLIPPAGE_BPS) {
    return { ok: false, reason: "invalid_slippage" };
  }
  let owedBI;
  try { owedBI = BigInt(loanOwedLamports); }
  catch { return { ok: false, reason: "invalid_loan_owed" }; }
  if (owedBI <= 0n) return { ok: false, reason: "zero_loan_owed" };
  const feeBps = Number.isInteger(protocolFeeBps) ? protocolFeeBps : 100;
  if (feeBps < 0 || feeBps > 1000) {
    return { ok: false, reason: "invalid_protocol_fee_bps" };
  }

  // ── 1. Quote at user's slippage ──────────────────────────────
  const primary = await fetchQuote({
    inputMint: collateralMint,
    outputMint: dst,
    amountRaw: collateralAmountRaw,
    slippageBps,
  });

  // Network / API failure — fail OPEN so a quote-API outage doesn't
  // block legitimate arms. The engine's runtime proceeds check is
  // the actual safety; this is just a friendlier pre-flight.
  if (!primary.ok && primary.reason === "quote_api_unreachable") {
    return {
      ok: true,
      advisory: { reason: "quote_api_unreachable", detail: primary.detail },
    };
  }

  if (!primary.ok && primary.reason === "no_route") {
    return { ok: false, reason: "no_route_for_collateral",
             detail: "Jupiter cannot route a swap for this collateral right now." };
  }

  if (!primary.ok) {
    return { ok: false, reason: primary.reason, detail: primary.detail };
  }

  // ── 2. Will proceeds cover (loan + fee + buffer)? ──────────────
  // Compute the minimum-out the user would actually receive after
  // slippage, then deduct the protocol fee, then compare to owed.
  // We require strict gt with a small buffer so a price-feed wobble
  // between arm and fire doesn't flip a marginal pass into a fail.
  const slippageDenom = 10_000n;
  const minOutLamports = (primary.outAmountLamports * (slippageDenom - BigInt(slippageBps))) / slippageDenom;
  const feeOnMinOut = (minOutLamports * BigInt(feeBps)) / slippageDenom;
  const proceedsAfterFee = minOutLamports - feeOnMinOut;
  const requiredWithBuffer = owedBI + (owedBI * PROCEEDS_BUFFER_BPS) / slippageDenom;

  if (proceedsAfterFee >= requiredWithBuffer) {
    return {
      ok: true,
      proceedsLamports: primary.outAmountLamports.toString(),
      minOutLamports: minOutLamports.toString(),
      proceedsAfterFeeLamports: proceedsAfterFee.toString(),
      requiredLamports: requiredWithBuffer.toString(),
      quotedAtIso: new Date().toISOString(),
    };
  }

  // ── 3. Sweep for a suggested slippage that WOULD clear ──────────
  // Walk up the sweep table. First level that clears is our suggestion.
  // We never suggest above 1000 (10%); above that we report
  // "liquidity_insufficient" — the user should sell smaller pieces
  // or rethink the order entirely.
  let suggestedBps = null;
  for (const trySlip of SUGGESTION_SWEEP_BPS) {
    if (trySlip <= slippageBps) continue; // already tried lower or equal
    const q = await fetchQuote({
      inputMint: collateralMint,
      outputMint: dst,
      amountRaw: collateralAmountRaw,
      slippageBps: trySlip,
    });
    if (!q.ok) continue;
    const minOut = (q.outAmountLamports * (slippageDenom - BigInt(trySlip))) / slippageDenom;
    const fee = (minOut * BigInt(feeBps)) / slippageDenom;
    const after = minOut - fee;
    if (after >= requiredWithBuffer) {
      suggestedBps = trySlip;
      break;
    }
  }

  if (suggestedBps === null) {
    return {
      ok: false,
      reason: "liquidity_insufficient",
      detail: "Even at 10% slippage, current Jupiter routes won't cover the loan + fee. " +
              "Consider a smaller collateral position, lowering your trigger, or waiting for deeper liquidity.",
    };
  }

  return {
    ok: false,
    reason: "slippage_too_low",
    detail: `At current liquidity, ${slippageBps / 100}% slippage won't clear. ` +
            `A setting of ${suggestedBps / 100}% would clear right now. Liquidity may improve by the time your trigger hits, but we recommend re-arming with at least ${suggestedBps / 100}%.`,
    suggestedSlippageBps: suggestedBps,
    yourSlippageBps: slippageBps,
  };
}
