/**
 * POST /api/v1/price/refresh
 *
 * Pre-attests a mint's on-chain price feed so the borrow tx the site
 * is ABOUT to build doesn't get rejected by Phantom's wallet-side
 * simulation with StalePriceAttestation.
 *
 * Why this endpoint exists:
 *   The site builds the borrow tx, then asks the wallet to sign.
 *   The wallet (Phantom on mobile + desktop) simulates the tx via
 *   its own RPC before showing the sign prompt. If the on-chain
 *   price feed is older than the contract's 120s wall, simulation
 *   fails and the user sees "Transaction rejected: StalePriceAttestation"
 *   — they never get to sign and our existing JIT attestation in
 *   cosign-borrow (which runs AFTER the user signs) never fires.
 *
 *   The background price-attestor runs every 30s but only for mints
 *   backing active loans + protected mints. Any other supported mint
 *   relies on JIT — and JIT is too late for the wallet simulation.
 *
 *   This endpoint is what closes the gap: site calls it BEFORE
 *   buildBorrowTransaction, we attest synchronously, return when
 *   the on-chain feed is fresh, site proceeds.
 *
 * Public route (no API key) — the site needs to call it from any
 * user's browser. Security is in the handler itself:
 *   - Only attests mints that are in supported_mints AND enabled
 *     (refuses random caller-supplied mints — no DOS surface for
 *     the lender keypair to keep paying tx fees on whatever a
 *     stranger asks).
 *   - Rate-limited per (mint, IP-fingerprint) — the global rate-limit
 *     middleware already covers gross abuse; this just keeps a single
 *     attacker from spamming attestations on the same mint to drain
 *     lender SOL.
 *   - Skips the attest entirely if the feed is already fresh
 *     (age < 30s) — saves an RPC + tx fee on the happy path where the
 *     background attestor just ran.
 *   - Hard cap on attestation time (15s) — if it doesn't land by
 *     then, return a clear "try again" signal rather than hanging
 *     the borrow flow.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const FRESH_THRESHOLD_SEC = 30;
const HARD_TIMEOUT_MS = 15_000;

// Per-mint cooldown — if we just attested mint X 5 seconds ago, a
// second refresh call doesn't need another tx. In-process, cleared
// on bot restart, sufficient for the "two-button-mash" case.
const lastAttestAt = new Map();
const COOLDOWN_MS = 8_000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function isValidPubkey(s) {
  if (typeof s !== "string") return false;
  if (s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export async function handlePriceRefresh(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  let body;
  try { body = await readJsonBody(req); }
  catch { return { status: 400, body: { error: "invalid_json" } }; }

  const mintStr = String(body?.mint ?? "");
  if (!isValidPubkey(mintStr)) {
    return { status: 400, body: { error: "invalid_mint" } };
  }

  // Allowlist: mint must be in supported_mints AND enabled. We never
  // attest arbitrary caller-supplied mints — that's a free way to
  // drain the lender keypair via tx fees on garbage mints.
  const { rows: [mintRow] } = await query(
    `SELECT mint, decimals, enabled, protected, category
       FROM supported_mints WHERE mint = $1`,
    [mintStr],
  );
  if (!mintRow) {
    return { status: 404, body: { error: "mint_not_supported" } };
  }
  if (!mintRow.enabled) {
    return { status: 409, body: { error: "mint_disabled" } };
  }

  // Per-mint cooldown — multiple users (or one user with two tabs) all
  // hitting refresh on the same mint within 8s reuse the same fresh
  // attestation. The freshness check below makes the same call cheap
  // anyway, but the cooldown saves RPCs.
  const lastAt = lastAttestAt.get(mintStr);
  if (lastAt && Date.now() - lastAt < COOLDOWN_MS) {
    return {
      status: 200,
      body: { ok: true, mint: mintStr, skipped: true, reason: "in_cooldown" },
    };
  }

  // 2026-06-15: V4 borrows hit V4's distinct price_feed PDA, which has
  // its own freshness requirement. The previous refresh path only
  // touched the category-default program (V1 for memecoin, V3 for RWA),
  // so V4 feeds went stale → site-side simulation failed with
  // StalePriceAttestation before the user could even sign. Refresh
  // BOTH the category-default AND the V4 feed (when V4 is configured).
  // Cost: 1 extra tx (~0.000005 SOL) per refresh — cheap insurance.
  let { PROGRAM_ID_V4 } = await import("../solana/program.js");
  const refreshV4 = !!PROGRAM_ID_V4;

  let ageSec = null;
  let ageSecV4 = null;
  try {
    const { getPriceFeedAgeSeconds } = await import("../services/price-attestor.js");
    ageSec = await getPriceFeedAgeSeconds(mintStr);
    if (refreshV4) {
      try {
        ageSecV4 = await getPriceFeedAgeSeconds(mintStr, PROGRAM_ID_V4);
      } catch (e) {
        console.warn(`[price/refresh] V4 age read failed for ${mintStr}:`, e.message?.slice(0, 100));
      }
    }
  } catch (err) {
    console.warn(`[price/refresh] age read failed for ${mintStr}:`, err.message?.slice(0, 100));
  }

  const defaultFresh = ageSec !== null && ageSec <= FRESH_THRESHOLD_SEC;
  const v4Fresh = !refreshV4 || (ageSecV4 !== null && ageSecV4 <= FRESH_THRESHOLD_SEC);

  if (defaultFresh && v4Fresh) {
    return {
      status: 200,
      body: {
        ok: true, mint: mintStr, attested: false,
        feed_age_seconds: ageSec, feed_age_seconds_v4: ageSecV4,
        reason: "already_fresh",
      },
    };
  }

  // Run the attestation with a hard timeout. If it hangs longer than
  // HARD_TIMEOUT_MS, surface a clear error so the borrow UI can show
  // "try again" rather than spinning forever.
  let attestPromise;
  try {
    const mod = await import("../services/price-attestor.js");
    const attestFor = async (programIdOverride) => {
      try {
        return await mod.attestPrice(mintStr, Number(mintRow.decimals), undefined, programIdOverride);
      } catch (err) {
        if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(err.message || "")) {
          await mod.initializePriceFeed(mintStr, programIdOverride);
          return await mod.attestPrice(mintStr, Number(mintRow.decimals), undefined, programIdOverride);
        }
        throw err;
      }
    };
    attestPromise = (async () => {
      // Attest the category-default feed FIRST so legacy borrows are
      // covered even if V4 has a transient issue.
      const defaultResult = defaultFresh ? null : await attestFor(null);
      const v4Result = !refreshV4 || v4Fresh ? null : await attestFor(PROGRAM_ID_V4);
      return { defaultResult, v4Result };
    })();
  } catch (err) {
    return {
      status: 502,
      body: { error: "attest_setup_failed", detail: err.message?.slice(0, 200) },
    };
  }

  let result;
  try {
    result = await Promise.race([
      attestPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("attestation_timeout")), HARD_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    // Even on timeout, record the attempt timestamp so retries within the
    // cooldown don't start another tx that might also time out.
    lastAttestAt.set(mintStr, Date.now());
    const isTimeout = err.message === "attestation_timeout";
    return {
      status: isTimeout ? 504 : 502,
      body: {
        error: isTimeout ? "attestation_timeout" : "attest_failed",
        detail: err.message?.slice(0, 200),
        hint: "wait a couple of seconds and try again",
      },
    };
  }

  lastAttestAt.set(mintStr, Date.now());

  return {
    status: 200,
    body: {
      ok: true,
      mint: mintStr,
      attested: !!(result.defaultResult || result.v4Result),
      signature: result.defaultResult?.signature ?? null,
      signature_v4: result.v4Result?.signature ?? null,
      price_sol: result.defaultResult?.priceSol ?? result.v4Result?.priceSol ?? null,
      previous_age_seconds: ageSec,
      previous_age_seconds_v4: ageSecV4,
    },
  };
}
