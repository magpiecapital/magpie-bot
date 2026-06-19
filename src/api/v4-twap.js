/**
 * GET /api/v1/v4/twap?mint=<base58>&decimals=<int>&amount_raw=<int>
 *
 * Sprint Item 4 of 6 (T15 in the V4 hardening sprint —
 * feedback_v4_hardening_sprint_2026_06_17.md). Replaces the site's
 * blunt 0.89 multiplier with a precise endpoint-driven value.
 *
 * BACKGROUND
 * ──────────
 * V4's request_and_fund_loan asserts:
 *   collateral_value <= min(spot, TWAP) * amount / 10^decimals * 1.03
 *
 * The site reads DexScreener spot, which can drift above the on-chain
 * TWAP (TWAP averages multiple samples over 5+ min, so it lags fresh
 * spot moves). V4's pump cap allows spot up to 1.15 * TWAP. To submit a
 * value the program ALWAYS accepts while the borrow is legitimate, the
 * site had been multiplying by 0.89 (~ 1.03/1.15). That under-shoots
 * collateral value by 11%, costing users borrowing power on EVERY V4
 * borrow.
 *
 * This endpoint returns the SAFE collateral_value the site can submit
 * directly. The under-shoot drops from 11% to ~0.3% — a 35x improvement
 * in borrower-facing precision.
 *
 * WHAT WE DO
 * ──────────
 *   1. Read V4 PriceHistory PDA for the mint. Decode all samples within
 *      the last 5 minutes.
 *   2. Compute a simple TWAP = average price_lamports across those
 *      samples (matches the program's algorithm well enough that the
 *      attestation never rejects a legitimate borrow).
 *   3. Fetch live spot via Jupiter (same source the attestor uses).
 *   4. Compute safe_lamports_per_whole_token =
 *        floor(min(spot, twap) * 1.03 * 0.997)
 *      0.997 = 30bps safety buffer for the brief window between this
 *      response and the user signing. Without it, a fast price move
 *      could re-create CollateralValueExceedsAttestation. 30bps is
 *      much tighter than the 1100bps the 0.89 multiplier costs.
 *   5. If amount_raw + decimals are supplied, also return
 *      safe_collateral_value_lamports = floor(
 *        safe_lamports_per_whole_token * amount_raw / 10^decimals
 *      ) which the site submits unchanged.
 *
 * FALLBACK
 * ────────
 * If the V4 PriceHistory has fewer than MIN_SAMPLES_FOR_TWAP samples
 * (which means a V4 borrow would fail anyway with TwapInsufficientHistory),
 * we return `recommendation: "wait_for_warmup"` and the site falls back
 * to the legacy 0.89 multiplier OR shows "Warming oracle…" copy.
 *
 * SECURITY
 * ────────
 * Read-only. No keypair, no tx. Allowlisted to enabled supported_mints.
 * Cheap (1 RPC + 1 Jupiter request, both cached).
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { withFailover } from "../solana/connection.js";

const MIN_SAMPLES_FOR_TWAP = 8;
const TWAP_WINDOW_SECONDS = 300; // V4: MIN_HISTORY_SECONDS = 300
const ATTESTATION_HEADROOM_BPS = 30; // 0.3% — covers signing-window blip
const PROGRAM_ATTESTATION_TOLERANCE = 1.03; // matches program's 3% gate

function isValidPubkey(s) {
  if (!s || typeof s !== "string") return false;
  if (s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export async function handleV4Twap(req, url) {
  if (req.method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const mintStr = url.searchParams.get("mint") || "";
  const decimalsRaw = url.searchParams.get("decimals");
  const amountRaw = url.searchParams.get("amount_raw");
  if (!mintStr) {
    return { status: 400, body: { error: "missing_params", detail: "mint required" } };
  }
  if (!isValidPubkey(mintStr)) {
    return { status: 400, body: { error: "invalid_mint" } };
  }

  // Allowlist — only enabled supported_mints. Same DOS posture as
  // /price/refresh and /v4/feed-health.
  const { rows: [mintRow] } = await query(
    `SELECT mint, decimals, enabled FROM supported_mints WHERE mint = $1`,
    [mintStr],
  );
  if (!mintRow) {
    return { status: 404, body: { error: "mint_not_supported", mint: mintStr } };
  }
  if (!mintRow.enabled) {
    return { status: 409, body: { error: "mint_disabled", mint: mintStr } };
  }

  // Resolve decimals — prefer URL param (matches what site is about
  // to submit) but fall back to supported_mints if absent. The
  // computation below uses BigInt math so we don't lose precision.
  const decimals =
    decimalsRaw && /^\d+$/.test(decimalsRaw)
      ? parseInt(decimalsRaw, 10)
      : Number(mintRow.decimals);

  // Read V4 PriceHistory PDA.
  const { PROGRAM_ID_V4 } = await import("../solana/program.js");
  if (!PROGRAM_ID_V4) {
    return {
      status: 503,
      body: { error: "v4_not_configured", detail: "PROGRAM_ID_V4 env unset" },
    };
  }
  const { lendingPoolPda, priceFeedPda } = await import("../solana/pdas.js");
  if (!process.env.LENDER_PUBKEY) {
    return { status: 503, body: { error: "lender_unconfigured" } };
  }
  const lenderPk = new PublicKey(process.env.LENDER_PUBKEY);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(lenderPk, PROGRAM_ID_V4);
  const [priceFeed] = priceFeedPda(mintPk, pool, PROGRAM_ID_V4);

  // withFailover so a Helius blip doesn't cascade to the site as a
  // borrow failure. Site already handles 'wait_for_warmup' soft-fail;
  // we use the same soft-fail shape on RPC-down instead of HTTP 500.
  // [[feedback_loans_must_never_fail_no_regressions]]
  let info;
  try {
    info = await withFailover((conn) => conn.getAccountInfo(priceFeed, "confirmed"));
  } catch (err) {
    console.error(`[v4-twap] all-RPCs-failed for ${mintStr.slice(0, 12)}: ${err.message?.slice(0, 200)}`);
    return {
      status: 200,
      body: {
        ok: true,
        mint: mintStr,
        recommendation: "wait_for_warmup",
        reason: "rpc_unavailable",
        fallback_multiplier: 0.89,
      },
    };
  }
  if (!info || info.data.length < 120) {
    return {
      status: 200,
      body: {
        ok: true,
        mint: mintStr,
        recommendation: "wait_for_warmup",
        reason: "v4_price_feed_uninitialized_or_empty",
        // Site falls back to the legacy 0.89 multiplier when we
        // return this — keeps the borrow flow functional even when
        // the V4 feed isn't ready.
        fallback_multiplier: 0.89,
      },
    };
  }

  // Decode PriceHistory ring buffer. Layout (V4, mirrors V3):
  //   offset 104  head (u8)
  //   offset 105  count (u8)
  //   offset 112  samples — 32 × { price_lamports (u64), timestamp (i64) }
  const head = info.data.readUInt8(104);
  const count = info.data.readUInt8(105);
  if (count === 0) {
    return {
      status: 200,
      body: {
        ok: true,
        mint: mintStr,
        recommendation: "wait_for_warmup",
        reason: "no_samples_yet",
        fallback_multiplier: 0.89,
      },
    };
  }
  const samples = [];
  const samplesOffset = 112;
  const sampleStride = 16;
  for (let i = 0; i < Math.min(count, 32); i++) {
    // Walk backwards from head so samples[0] is the most recent.
    const idx = (head - 1 - i + 32) % 32;
    const start = samplesOffset + idx * sampleStride;
    if (start + sampleStride > info.data.length) break;
    const priceLamports = info.data.readBigUInt64LE(start);
    const ts = info.data.readBigInt64LE(start + 8);
    samples.push({ priceLamports, ts });
  }

  // Filter to the last TWAP_WINDOW_SECONDS.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const windowStart = now - BigInt(TWAP_WINDOW_SECONDS);
  const inWindow = samples.filter((s) => s.ts >= windowStart);
  const latestSample = samples[0]; // most recent

  if (inWindow.length < MIN_SAMPLES_FOR_TWAP) {
    return {
      status: 200,
      body: {
        ok: true,
        mint: mintStr,
        recommendation: "wait_for_warmup",
        reason: `only_${inWindow.length}_samples_in_window_need_${MIN_SAMPLES_FOR_TWAP}`,
        latest_sample_age_seconds: latestSample ? Number(now - latestSample.ts) : null,
        samples_total: samples.length,
        samples_in_window: inWindow.length,
        fallback_multiplier: 0.89,
      },
    };
  }

  // Simple TWAP — average price_lamports across the window samples.
  // This is conservative against the program's algorithm: the program
  // averages the same set of samples, so our value will match or be
  // within rounding error.
  const sumPrice = inWindow.reduce((acc, s) => acc + s.priceLamports, 0n);
  const twapLamports = sumPrice / BigInt(inWindow.length);

  // Fetch live spot from Jupiter (same source the attestor uses).
  // Note: getPriceInSol returns SOL-per-whole-token; we convert to
  // lamports (×1e9) and floor.
  const { getPriceInSol } = await import("../services/price.js");
  let spotLamports;
  try {
    const spotSol = await getPriceInSol(mintStr);
    if (!Number.isFinite(spotSol) || spotSol <= 0) {
      throw new Error("invalid_spot");
    }
    spotLamports = BigInt(Math.floor(spotSol * 1e9));
  } catch (err) {
    // Spot unavailable — fall back to TWAP-only (still better than the
    // 0.89 multiplier).
    spotLamports = null;
    console.warn(`[v4-twap] spot fetch failed for ${mintStr}: ${err.message?.slice(0, 80)}`);
  }

  // Per-whole-token ceiling = min(spot, twap) × 1.03
  // Per-whole-token safe   = ceiling × (1 - HEADROOM_BPS / 10_000)
  const refLamports = spotLamports !== null
    ? (spotLamports < twapLamports ? spotLamports : twapLamports)
    : twapLamports;

  // BigInt-safe math: scale by 1e6 to preserve the 1.03 multiplier
  // precision, then divide back out.
  //
  //   ceiling = ref × 1.03
  //   safe    = ceiling × (1 − HEADROOM_BPS / 10_000)
  //
  // ATTESTATION_HEADROOM_BPS = 30 → 0.3%, so headroomScaled = 997_000.
  const SCALE = 1_000_000n;
  const tolerance6 = BigInt(Math.floor(PROGRAM_ATTESTATION_TOLERANCE * 1e6)); // 1_030_000
  const ceilingLamports = (refLamports * tolerance6) / SCALE;
  // 10_000 bps = 100 %, so 1bp at the 1e6 scale = 100.
  const headroomScaled = SCALE - BigInt(ATTESTATION_HEADROOM_BPS * 100); // 1_000_000 - 3_000 = 997_000
  const safeLamportsPerWholeToken = (ceilingLamports * headroomScaled) / SCALE;

  // Optionally compute the collateral_value the site should submit
  // (amount_raw × safe / 10^decimals).
  let safeCollateralValueLamports = null;
  let amountRawBig = null;
  if (amountRaw && /^\d+$/.test(amountRaw)) {
    amountRawBig = BigInt(amountRaw);
    const tenPow = 10n ** BigInt(decimals);
    safeCollateralValueLamports = (amountRawBig * safeLamportsPerWholeToken) / tenPow;
  }

  const lamportsToSol = (n) => Number(n) / 1e9;

  return {
    status: 200,
    body: {
      ok: true,
      mint: mintStr,
      decimals,
      recommendation: "use_precise_value",
      // Per-whole-token figures
      twap_lamports_per_whole_token: twapLamports.toString(),
      spot_lamports_per_whole_token: spotLamports !== null ? spotLamports.toString() : null,
      min_of_spot_or_twap_lamports_per_whole_token: refLamports.toString(),
      safe_lamports_per_whole_token: safeLamportsPerWholeToken.toString(),
      // Pretty SOL versions for logging / display
      twap_sol_per_whole_token: lamportsToSol(twapLamports),
      spot_sol_per_whole_token: spotLamports !== null ? lamportsToSol(spotLamports) : null,
      safe_sol_per_whole_token: lamportsToSol(safeLamportsPerWholeToken),
      // Pre-computed submission value when amount_raw was provided
      ...(amountRawBig !== null
        ? {
            amount_raw: amountRawBig.toString(),
            safe_collateral_value_lamports: safeCollateralValueLamports.toString(),
            safe_collateral_value_sol: lamportsToSol(safeCollateralValueLamports),
          }
        : {}),
      diagnostics: {
        samples_total: samples.length,
        samples_in_window: inWindow.length,
        twap_window_seconds: TWAP_WINDOW_SECONDS,
        min_samples_required: MIN_SAMPLES_FOR_TWAP,
        attestation_tolerance: PROGRAM_ATTESTATION_TOLERANCE,
        headroom_bps: ATTESTATION_HEADROOM_BPS,
        approx_under_shoot_pct: ATTESTATION_HEADROOM_BPS / 100, // 0.3%
        legacy_under_shoot_pct: 11, // what 0.89 multiplier cost
      },
      generated_at: new Date().toISOString(),
    },
  };
}
