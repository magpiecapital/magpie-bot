/**
 * GET /api/v1/safe-collateral-value?mint=<base58>&decimals=<int>&amount_raw=<int>&program=v1|v3|v4
 *
 * Universal, version-aware ATTESTATION-SAFE collateral value. Returns a
 * `collateral_value` that the on-chain program (V1/V2/V3/V4) is GUARANTEED to
 * accept — i.e. the borrow can never fail with CollateralValueExceedsAttestation
 * (V1 err 6014, V3/V4 err 6018), and the dollar figure shown to the user is the
 * real, attestation-backed value (never an inflated off-chain price).
 *
 * WHY THIS EXISTS (P0, 2026-06-20)
 * ───────────────────────────────
 * Every program version enforces:
 *   collateral_value <= attested_value * 1.03            (MAX_VALUE_TOLERANCE_BPS)
 * where attested_value is derived from the ON-CHAIN price feed:
 *   - V1/V2 (magpie-lending / -v2): a single PriceAttestation account
 *       expected = amount * price_lamports / 10^decimals
 *   - V3/V4 (magpie-lending-v3 / magpie-v4): a PriceHistory TWAP ring buffer
 *       expected = amount * min(spot, TWAP) / 10^decimals
 *
 * The off-chain offer paths price collateral from DIFFERENT sources (the site's
 * approved.priceUsd, the bot's cross-sourced Jupiter price, the scaled-UI
 * multiplier) which can drift ABOVE the attested price. When they exceed
 * attested * 1.03 the borrow is rejected AND the user is quoted an inflated
 * figure. This endpoint reads the on-chain attestation directly and returns the
 * largest value the program will accept (with a small headroom for the brief
 * window before the user signs), so the offer is always attestation-bounded.
 *
 * This generalizes /api/v1/v4/twap (V4-only) to ALL versions. /v4/twap is left
 * untouched for back-compat; new callers should prefer this endpoint.
 *
 * SECURITY: read-only. No keypair, no tx. Allowlisted to enabled
 * supported_mints. The on-chain attestation is the source of truth; this only
 * ever UNDER-quotes relative to it (fail-safe — never over-values collateral).
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { withFailover } from "../solana/connection.js";
import { lendingPoolPda, priceFeedPda } from "../solana/pdas.js";
import {
  PROGRAM_ID as PROGRAM_ID_V1,
  PROGRAM_ID_V2,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
} from "../solana/program.js";

const MIN_SAMPLES_FOR_TWAP = 8;
const TWAP_WINDOW_SECONDS = 300;
const PROGRAM_ATTESTATION_TOLERANCE = 1.03; // matches the program's 3% gate
const MAX_PRICE_STALENESS_SECONDS = 110; // under the program's 120s wall

// ── DRIFT HEADROOM (P0, 2026-06-21) ──────────────────────────────────────────
// The on-chain program rejects when submitted > attested_at_execution × 1.03.
// The off-chain value is computed at QUOTE time; the price can move between
// quote → sign → execute. The submitted value is attested × 1.03 × (1 −
// headroom), so the drift tolerated EQUALS the headroom: a `headroom_bps` buffer
// survives a `headroom_bps/100`% downtick in the signing window. The old fixed
// 30bps (0.3%) tolerated almost no movement → volatile collateral kept failing
// with CollateralValueExceedsAttestation even when the price was perfectly
// correct (e.g. $JOTCHUA). We now size the buffer to the collateral's realistic
// volatility, per asset class. The buffer ONLY ever LOWERS the submitted value
// (strictly safer for the protocol — it can never over-value collateral); the
// cost is a few % of borrowing power, which is the right trade for ZERO
// rejections. Tune via env without a redeploy.
const HEADROOM_MEMECOIN_BPS = Number(process.env.SAFE_HEADROOM_MEMECOIN_BPS) || 500; // 5% — memecoins are volatile
const HEADROOM_RWA_BPS = Number(process.env.SAFE_HEADROOM_RWA_BPS) || 200; // 2% — RWAs/stocks (TWAP-smoothed, can still gap)
const HEADROOM_DEFAULT_BPS = HEADROOM_MEMECOIN_BPS; // unknown category → widest (safest) buffer
// Everything that isn't an RWA/stock/commodity class is treated as memecoin-volatile.
const RWA_CATEGORIES = new Set([
  "rwa", "stock", "etf", "index", "metal", "commodity", "forex", "bond", "equity",
]);

/** Pick the drift headroom (bps) for a collateral category. Fail-safe = widest. */
export function headroomBpsForCategory(category) {
  const c = String(category || "").toLowerCase().trim();
  if (!c) return HEADROOM_DEFAULT_BPS;
  return RWA_CATEGORIES.has(c) ? HEADROOM_RWA_BPS : HEADROOM_MEMECOIN_BPS;
}

const SCALE = 1_000_000n;
const TOLERANCE6 = BigInt(Math.floor(PROGRAM_ATTESTATION_TOLERANCE * 1e6)); // 1_030_000

const VERSIONS = {
  v1: { programId: PROGRAM_ID_V1, kind: "single" },
  v2: { programId: PROGRAM_ID_V2, kind: "single" },
  v3: { programId: PROGRAM_ID_V3, kind: "history" },
  v4: { programId: PROGRAM_ID_V4, kind: "history" },
};

function isValidPubkey(s) {
  if (!s || typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

const lamportsToSol = (n) => Number(n) / 1e9;

/** Apply the program tolerance + a category-sized drift headroom to a per-token ref price. */
function safePerTokenLamports(refLamports, headroomBps) {
  const ceiling = (refLamports * TOLERANCE6) / SCALE; // ref × 1.03 (the program's hard ceiling)
  // headroomScaled = 1 − headroom_bps/10000, in 1e6 fixed point. 500bps → 950_000 (×0.95).
  const hb = Number.isFinite(headroomBps) && headroomBps >= 0 ? Math.round(headroomBps) : HEADROOM_DEFAULT_BPS;
  const headroomScaled = SCALE - BigInt(hb * 100);
  return (ceiling * headroomScaled) / SCALE;
}

/** Decode V1/V2 PriceAttestation → { priceLamports, timestamp }. */
function decodeSingleAttestation(data) {
  // Layout: disc(8) mint(32) pool(32) authority(32) price_lamports(u64)@104 timestamp(i64)@112
  if (!data || data.length < 120) return null;
  return {
    priceLamports: data.readBigUInt64LE(104),
    timestamp: data.readBigInt64LE(112),
  };
}

/**
 * Compute the attestation-safe collateral_value for a mint on a given program
 * version. Returns a response body (200-shaped) — `recommendation` is
 * 'use_precise_value' on success or 'wait_for_warmup' when the feed isn't ready
 * (caller should fall back to the conservative legacy multiplier and retry).
 */
export async function computeSafeCollateralValue({ mintStr, decimals, amountRaw, version, category }) {
  const headroomBps = headroomBpsForCategory(category);
  const cfg = VERSIONS[version];
  if (!cfg) return { ok: false, status: 400, body: { error: "invalid_program", detail: "program must be v1|v2|v3|v4" } };
  if (!cfg.programId) {
    return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: `${version}_not_configured`, fallback_multiplier: 0.89 } };
  }
  if (!process.env.LENDER_PUBKEY) {
    return { ok: false, status: 503, body: { error: "lender_unconfigured" } };
  }

  const lenderPk = new PublicKey(process.env.LENDER_PUBKEY);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(lenderPk, cfg.programId);
  const [priceFeed] = priceFeedPda(mintPk, pool, cfg.programId);
  const nowSec = Math.floor(Date.now() / 1000);

  let info;
  try {
    info = await withFailover((conn) => conn.getAccountInfo(priceFeed, "confirmed"));
  } catch (err) {
    console.error(`[safe-value] all-RPCs-failed ${version} ${mintStr.slice(0, 12)}: ${err.message?.slice(0, 160)}`);
    return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: "rpc_unavailable", fallback_multiplier: 0.89 } };
  }

  let refLamports = null;
  const diagnostics = { version, kind: cfg.kind };

  if (cfg.kind === "single") {
    // ── V1/V2: single PriceAttestation ──
    const att = decodeSingleAttestation(info?.data);
    if (!att || att.priceLamports <= 0n) {
      return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: "v1_attestation_uninitialized_or_empty", fallback_multiplier: 0.89 } };
    }
    const ageSec = nowSec - Number(att.timestamp);
    if (ageSec > MAX_PRICE_STALENESS_SECONDS) {
      return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: "stale_attestation", attestation_age_seconds: ageSec, fallback_multiplier: 0.89 } };
    }
    // The program values V1/V2 collateral at the attested price ONLY (no spot
    // comparison) — so the attested price IS the reference ceiling.
    refLamports = att.priceLamports;
    diagnostics.attested_age_seconds = ageSec;
  } else {
    // ── V3/V4: PriceHistory TWAP ring buffer ──
    if (!info || info.data.length < 120) {
      return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: "price_history_uninitialized_or_empty", fallback_multiplier: 0.89 } };
    }
    const head = info.data.readUInt8(104);
    const count = info.data.readUInt8(105);
    if (count === 0) {
      return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: "no_samples_yet", fallback_multiplier: 0.89 } };
    }
    const samples = [];
    const samplesOffset = 112;
    const stride = 16;
    for (let i = 0; i < Math.min(count, 32); i++) {
      const idx = (head - 1 - i + 32) % 32;
      const start = samplesOffset + idx * stride;
      if (start + stride > info.data.length) break;
      samples.push({ priceLamports: info.data.readBigUInt64LE(start), ts: info.data.readBigInt64LE(start + 8) });
    }
    const nowBig = BigInt(nowSec);
    const windowStart = nowBig - BigInt(TWAP_WINDOW_SECONDS);
    const inWindow = samples.filter((s) => s.ts >= windowStart);
    if (inWindow.length < MIN_SAMPLES_FOR_TWAP) {
      return { ok: true, status: 200, body: { ok: true, mint: mintStr, recommendation: "wait_for_warmup", reason: `only_${inWindow.length}_samples_in_window_need_${MIN_SAMPLES_FOR_TWAP}`, samples_in_window: inWindow.length, fallback_multiplier: 0.89 } };
    }
    const twapLamports = inWindow.reduce((a, s) => a + s.priceLamports, 0n) / BigInt(inWindow.length);

    // Spot from the same source the attestor uses; min(spot, twap) mirrors the
    // program's valuation. Spot failure → TWAP-only (still attestation-safe).
    const { getPriceInSol } = await import("../services/price.js");
    let spotLamports = null;
    try {
      const spotSol = await getPriceInSol(mintStr);
      if (Number.isFinite(spotSol) && spotSol > 0) spotLamports = BigInt(Math.floor(spotSol * 1e9));
    } catch (err) {
      console.warn(`[safe-value] spot fetch failed ${mintStr.slice(0, 12)}: ${err.message?.slice(0, 80)}`);
    }
    refLamports = spotLamports !== null ? (spotLamports < twapLamports ? spotLamports : twapLamports) : twapLamports;
    diagnostics.twap_lamports = twapLamports.toString();
    diagnostics.spot_lamports = spotLamports !== null ? spotLamports.toString() : null;
    diagnostics.samples_in_window = inWindow.length;
  }

  const safePerToken = safePerTokenLamports(refLamports, headroomBps);

  let safeCollateralValueLamports = null;
  if (amountRaw && /^\d+$/.test(amountRaw)) {
    const tenPow = 10n ** BigInt(decimals);
    safeCollateralValueLamports = (BigInt(amountRaw) * safePerToken) / tenPow;
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      mint: mintStr,
      decimals,
      program_version: version,
      recommendation: "use_precise_value",
      ref_lamports_per_whole_token: refLamports.toString(),
      safe_lamports_per_whole_token: safePerToken.toString(),
      safe_sol_per_whole_token: lamportsToSol(safePerToken),
      ...(safeCollateralValueLamports !== null
        ? {
            amount_raw: String(amountRaw),
            safe_collateral_value_lamports: safeCollateralValueLamports.toString(),
            safe_collateral_value_sol: lamportsToSol(safeCollateralValueLamports),
          }
        : {}),
      diagnostics: { ...diagnostics, attestation_tolerance: PROGRAM_ATTESTATION_TOLERANCE, headroom_bps: headroomBps, category: category || null, drift_tolerance_pct: headroomBps / 100 },
      generated_at: new Date().toISOString(),
    },
  };
}

/** Map a program id (PublicKey or base58) to its version key, or null. */
export function versionForProgramId(programId) {
  if (!programId) return null;
  const s = programId.toBase58 ? programId.toBase58() : String(programId);
  for (const [v, cfg] of Object.entries(VERSIONS)) {
    if (cfg.programId && cfg.programId.toBase58() === s) return v;
  }
  return null;
}

/**
 * Cap an off-chain-computed collateral value (lamports) to the on-chain
 * attestation for the loan's program version, so a borrow can NEVER reject
 * with CollateralValueExceedsAttestation. Returns min(value, safe). On any
 * failure (RPC down, feed warming, unknown program) it returns the value
 * UNCHANGED — the multiplier clamp, cosign pre-flight sim, and the on-chain
 * program remain as the lower defense layers, so this never blocks a borrow.
 *
 * Used by every BOT borrow builder (TG /borrow, x402 agent) so they submit a
 * value the program accepts up front, instead of failing the on-chain check.
 */
export async function capCollateralValueToAttestation(valueLamports, { mintStr, decimals, amountRaw, programId, category }) {
  const version = versionForProgramId(programId);
  if (!version) return valueLamports;
  let cat = category;
  if (cat === undefined || cat === null) {
    // Look up the collateral category so the drift headroom is sized correctly
    // (memecoin vs RWA). Fail-safe: on lookup failure cat stays undefined →
    // computeSafeCollateralValue applies the widest (memecoin) headroom.
    try {
      const { rows: [r] } = await query(`SELECT category FROM supported_mints WHERE mint = $1`, [mintStr]);
      cat = r?.category;
    } catch { /* keep undefined → widest headroom */ }
  }
  try {
    const res = await computeSafeCollateralValue({ mintStr, decimals, amountRaw, version, category: cat });
    if (res?.body?.recommendation === "use_precise_value" && res.body.safe_collateral_value_lamports) {
      const safe = Number(res.body.safe_collateral_value_lamports);
      if (Number.isFinite(safe) && safe > 0 && safe < Number(valueLamports)) {
        console.warn(
          `[safe-value] capped collateral_value ${valueLamports} → ${safe} for ` +
            `${String(mintStr).slice(0, 8)}… (${version}) to stay under the on-chain attestation`,
        );
        return safe;
      }
    }
  } catch (err) {
    console.warn(`[safe-value] cap failed for ${String(mintStr).slice(0, 8)}… (${version}): ${err.message?.slice(0, 120)}`);
  }
  return valueLamports;
}

/** HTTP handler. */
export async function handleSafeCollateralValue(req, url) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  const mintStr = url.searchParams.get("mint") || "";
  const decimalsRaw = url.searchParams.get("decimals");
  const amountRaw = url.searchParams.get("amount_raw");
  const version = (url.searchParams.get("program") || "").toLowerCase();

  if (!isValidPubkey(mintStr)) return { status: 400, body: { error: "invalid_or_missing_mint" } };
  if (!VERSIONS[version]) return { status: 400, body: { error: "invalid_program", detail: "program must be v1|v2|v3|v4" } };

  const { rows: [mintRow] } = await query(
    `SELECT decimals, enabled, category FROM supported_mints WHERE mint = $1`,
    [mintStr],
  );
  if (!mintRow) return { status: 404, body: { error: "mint_not_supported", mint: mintStr } };
  if (!mintRow.enabled) return { status: 409, body: { error: "mint_disabled", mint: mintStr } };

  const decimals = decimalsRaw && /^\d+$/.test(decimalsRaw) ? parseInt(decimalsRaw, 10) : Number(mintRow.decimals);
  const res = await computeSafeCollateralValue({ mintStr, decimals, amountRaw, version, category: mintRow.category });
  return { status: res.status, body: res.body };
}
