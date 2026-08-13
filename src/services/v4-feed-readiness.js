/**
 * V4 feed readiness — architectural fix for the cold-start error class.
 *
 * Problem this solves
 * -------------------
 * Every bot redeploy resets V4 price feed warmup. Each V4 mint needs
 * MIN_SAMPLES_FOR_TWAP=8 samples within a TWAP_WINDOW_SECONDS=300s
 * window before borrows can succeed. The normal price-attestor cycles
 * each mint roughly every 35s, so a cold mint needs ~5 minutes to
 * reach 8 samples. During that window, any user trying to borrow that
 * mint hits AccountNotInitialized / no_samples_yet, and we shipped
 * four patches today trying to "block" the user from doing so
 * (PRs #176, #177, #182, #183).
 *
 * This is the architectural fix that eliminates the class:
 *   1. Identify PRIORITY MINTS: every mint borrowed in the last 7
 *      days + every enabled tokenized-stock mint. Typically ~60 mints.
 *   2. Burst-attest them on boot: concurrency 8, 4s spacing per mint
 *      per round, 8 rounds. Total: ~3.5 minutes to warm all priority
 *      mints, vs ~5 minutes for a SINGLE mint at normal cadence.
 *   3. Track readiness in shared module state.
 *   4. Health endpoint reports {ready, warm, total, eta_seconds}.
 *   5. Site blocks the borrow CTA based on the health signal.
 *
 * Net effect: users physically cannot click borrow on a cold mint.
 * They see a "Markets warming up — Xs" countdown instead. By the time
 * the countdown clears, the on-chain feed is actually ready.
 *
 * Operator-mandated 2026-06-19 PM per
 * [[feedback_v4_loan_lifecycle_zero_errors_mandate]] +
 * [[feedback_root_cause_not_symptom_patches]] —
 * the single class-eliminating PR after four symptom patches.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { withFailover } from "../solana/connection.js";

const MIN_SAMPLES_FOR_TWAP = 8;
const TWAP_WINDOW_SECONDS = 300;

const WARMUP_CONCURRENCY = Number(process.env.V4_WARMUP_CONCURRENCY) || 8;
const WARMUP_BATCH_SPACING_MS = Number(process.env.V4_WARMUP_BATCH_SPACING_MS) || 4_000;
const PRIORITY_MINT_LOOKBACK_DAYS = Number(process.env.V4_WARMUP_LOOKBACK_DAYS) || 7;
const READINESS_THRESHOLD_PCT = Number(process.env.V4_READINESS_THRESHOLD_PCT) || 80;

// Per-mint on-demand warmup — how long a mint stays "hot" after a user
// shows interest. Re-requested mints stay in the burst queue; mints
// unrequested for this window drop back to the normal attestor cadence
// to keep SOL spend bounded.
const ON_DEMAND_HOT_WINDOW_MS = Number(process.env.V4_ON_DEMAND_HOT_WINDOW_MS) || 5 * 60_000;
const ON_DEMAND_LOOP_SPACING_MS = Number(process.env.V4_ON_DEMAND_LOOP_SPACING_MS) || 3_000;

// FAST COLD-START BURST — the piece that guarantees first-attempt borrow
// success on a genuinely cold token. The normal on-demand loop drips one
// attestation per mint per 3s, so a 0→8-sample warmup takes ~30–45s. If
// a user expands a row and clicks Borrow faster than that, they'd hit the
// opaque "Signing…" hang. The burst queue attests a not-yet-ready mint
// aggressively (every ~1.5s, prioritized ahead of the round-robin) until
// it crosses the TWAP threshold — cutting cold-start to ~12–15s. Bounded:
// at most BURST_MAX_CONCURRENT mints bursting at once, each for at most
// BURST_MAX_ATTEMPTS attestations, then it falls back to the normal
// on-demand cadence. Cost per cold borrow ≈ a few thousand lamports —
// negligible, and only spent when a real user is mid-borrow on a cold mint.
// See [[feedback_first_attempt_loan_success_cost_effective]].
const BURST_SPACING_MS = Number(process.env.V4_BURST_SPACING_MS) || 1_500;
const BURST_MAX_CONCURRENT = Number(process.env.V4_BURST_MAX_CONCURRENT) || 8;
const BURST_MAX_ATTEMPTS = Number(process.env.V4_BURST_MAX_ATTEMPTS) || 14;
// Target a small buffer above the minimum so a sample aging out mid-borrow
// doesn't drop the feed back below threshold.
const BURST_TARGET_SAMPLES = MIN_SAMPLES_FOR_TWAP + 1;

// CONTINUOUS ALL-MINTS LOOP — the architecture that makes EVERY enabled
// V4 mint stay warm 24/7. Operator-mandated 2026-06-19 PM:
// "every single token... needs to pass every single sample and execute."
//
// Math:
//   174 mints (currently) × every CONTINUOUS_BATCH_SPACING_MS / CONTINUOUS_CONCURRENCY
//   = 174 / 16 = 11 batches × 3000ms = ~33s per full cycle of all mints
//   → each mint attested every ~33s, which is well within the 300s TWAP
//     window, guaranteeing ≥8 samples per mint at steady state.
//
// SOL cost: ~5.3 attestations/sec × 5000 lamports × 86400s/day ≈ 2.3 SOL/day.
// Pre-authorized by operator (see feedback_every_mint_must_pass_every_sample).
//
// To bound spend further, the loop SKIPS mints that already have a healthy
// sample buffer (current + 2 samples beyond MIN_SAMPLES_FOR_TWAP). The
// loop only spends SOL on mints that actually need an attestation.
// Falsy-zero bug fix: `Number("0") || 16` evaluates to 16, so setting
// V4_CONTINUOUS_CONCURRENCY=0 to throttle the loop didn't actually disable
// it. Explicit-undefined check lets the operator set 0 to fully pause the
// continuous sweep when Jupiter is in a 429 storm.
const CONTINUOUS_CONCURRENCY =
  process.env.V4_CONTINUOUS_CONCURRENCY != null && process.env.V4_CONTINUOUS_CONCURRENCY !== ""
    ? Number(process.env.V4_CONTINUOUS_CONCURRENCY)
    : 16;
const CONTINUOUS_BATCH_SPACING_MS = Number(process.env.V4_CONTINUOUS_SPACING_MS) || 3_000;
const CONTINUOUS_BUFFER_SAMPLES = Number(process.env.V4_CONTINUOUS_BUFFER_SAMPLES) || 2; // skip if mint has ≥ (MIN + buffer) samples
const CONTINUOUS_LIST_REFRESH_INTERVAL_MS = 10 * 60_000; // re-read supported_mints every 10min in case new mints added

// Shared module state — read by /api/v1/health.
const state = {
  startedAt: null,
  completedAt: null,
  priorityMints: [],         // Array<{ mint, symbol, category }>
  warmMints: new Set(),      // mint string — currently warm (sample-in-window check)
  inFlight: new Set(),       // currently being attested
  lastError: null,
  lastErrorAt: null,
  // On-demand state. Site calls requestMintWarm() for any mint a user
  // is showing interest in (rendering CTA, clicking borrow). Each
  // requested mint is tracked with its last-requested timestamp and
  // gets aggressive attestation until it goes cold (unrequested >
  // ON_DEMAND_HOT_WINDOW_MS).
  onDemand: new Map(),       // mint → { lastRequestedAt, requestedCount, decimals }
  // Fast cold-start burst queue. mint → { decimals, category, attempts,
  // addedAt }. Populated by requestMintWarm when a requested mint is not
  // yet ready; drained by burstLoop (aggressive ~1.5s attestation) the
  // instant it crosses the TWAP threshold or exhausts BURST_MAX_ATTEMPTS.
  burst: new Map(),
  // Continuous all-mints loop state — list of every enabled V4 mint
  // + round-robin cursor + last-refresh time + counters.
  continuousList: [],        // Array<{ mint, decimals, symbol, category }>
  continuousCursor: 0,
  continuousListRefreshedAt: 0,
  continuousAttestations: 0, // lifetime counter for /v4-status visibility
  continuousSkipped: 0,      // skipped because already healthy
  continuousErrors: 0,
};

/**
 * Public snapshot for health endpoint consumers. Cheap — no I/O.
 */
export function getFeedReadinessSnapshot() {
  const total = state.priorityMints.length;
  const warm = state.warmMints.size;
  const percentWarm = total > 0 ? Math.round((warm / total) * 100) : 100;
  const ready = total === 0 || percentWarm >= READINESS_THRESHOLD_PCT;

  // ETA — naive but useful for UI countdown. Assumes ~4s per remaining
  // sample slot at current concurrency.
  let etaSeconds = null;
  if (!ready && state.startedAt) {
    const remaining = total - warm;
    const perCycle = WARMUP_CONCURRENCY;
    const cycles = Math.ceil(remaining / perCycle);
    etaSeconds = Math.max(5, cycles * 4);
  }

  return {
    ready,
    warm_count: warm,
    total_count: total,
    percent_warm: percentWarm,
    threshold_pct: READINESS_THRESHOLD_PCT,
    // Continuous all-mints loop telemetry — operator-facing
    // visibility into what the continuous attestor is doing.
    continuous: {
      mint_count: state.continuousList.length,
      cursor: state.continuousCursor,
      list_refreshed_at: state.continuousListRefreshedAt
        ? new Date(state.continuousListRefreshedAt).toISOString()
        : null,
      attestations_total: state.continuousAttestations,
      skipped_total: state.continuousSkipped,
      errors_total: state.continuousErrors,
    },
    in_flight: state.inFlight.size,
    burst_queue: state.burst.size,
    on_demand_tracked: state.onDemand.size,
    started_at: state.startedAt,
    completed_at: state.completedAt,
    eta_seconds: etaSeconds,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
  };
}

async function listPriorityMints() {
  // Priority = (a) every mint borrowed in lookback window + (b) every
  // enabled stock. Stocks are always priority because the operator's
  // tokenized-stock product is the strategic differentiator.
  const { rows: recent } = await query(
    `SELECT DISTINCT l.collateral_mint AS mint
       FROM loans l
      WHERE l.start_timestamp > NOW() - INTERVAL '${PRIORITY_MINT_LOOKBACK_DAYS} days'
        AND l.collateral_mint IS NOT NULL`,
  );
  const { rows: stocks } = await query(
    `SELECT mint, symbol, category
       FROM supported_mints
      WHERE enabled = true AND category = 'stock'`,
  );
  // Materialize with metadata.
  const mintSet = new Set([
    ...recent.map((r) => r.mint),
    ...stocks.map((r) => r.mint),
  ]);
  if (mintSet.size === 0) return [];

  const { rows: enriched } = await query(
    `SELECT mint, symbol, category, decimals
       FROM supported_mints
      WHERE enabled = true AND mint = ANY($1::text[])`,
    [Array.from(mintSet)],
  );
  return enriched;
}

async function feedIsWarm(mintStr, lenderPk, programIdV4) {
  const { lendingPoolPda, priceFeedPda } = await import("../solana/pdas.js");
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(lenderPk, programIdV4);
  const [pf] = priceFeedPda(mintPk, pool, programIdV4);

  let info;
  try {
    info = await withFailover((conn) => conn.getAccountInfo(pf, "confirmed"));
  } catch {
    return false;
  }
  if (!info || info.data.length < 120) return false;

  // PriceHistory layout: offset 104=head, 105=count, 112=samples.
  // 32 × { price_lamports: u64, ts: i64 } = 16 bytes each.
  const head = info.data.readUInt8(104);
  const count = info.data.readUInt8(105);
  if (count < MIN_SAMPLES_FOR_TWAP) return false;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const windowStart = now - BigInt(TWAP_WINDOW_SECONDS);
  let inWindow = 0;
  for (let i = 0; i < Math.min(count, 32); i++) {
    const idx = (head - 1 - i + 32) % 32;
    const start = 112 + idx * 16;
    if (start + 16 > info.data.length) break;
    const ts = info.data.readBigInt64LE(start + 8);
    if (ts >= windowStart) inWindow++;
    if (inWindow >= MIN_SAMPLES_FOR_TWAP) return true;
  }
  return false;
}

async function ensureMintWarm(mint, lenderPk, programIdV4) {
  if (state.warmMints.has(mint.mint)) return { mint: mint.mint, action: "already_warm" };
  if (state.inFlight.has(mint.mint)) return { mint: mint.mint, action: "in_flight_skip" };
  state.inFlight.add(mint.mint);
  try {
    // Quick read first — maybe already warm from on-chain ring buffer
    // (samples persist across bot restarts within the 5-min window).
    if (await feedIsWarm(mint.mint, lenderPk, programIdV4)) {
      state.warmMints.add(mint.mint);
      return { mint: mint.mint, action: "already_warm_onchain" };
    }
    // Not warm — fire one attestation. Subsequent burst rounds add
    // more samples. We don't try to add 8 samples in this call; the
    // burst loop does that across rounds.
    const { attestPrice, initializePriceFeed } = await import("./price-attestor.js");
    try {
      await attestPrice(mint.mint, Number(mint.decimals), undefined, programIdV4);
    } catch (err) {
      if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(err.message || "")) {
        await initializePriceFeed(mint.mint, programIdV4);
        await attestPrice(mint.mint, Number(mint.decimals), undefined, programIdV4);
      } else {
        throw err;
      }
    }
    // Re-check warmth — might have crossed threshold with this sample.
    if (await feedIsWarm(mint.mint, lenderPk, programIdV4)) {
      state.warmMints.add(mint.mint);
      return { mint: mint.mint, action: "now_warm" };
    }
    return { mint: mint.mint, action: "attested_still_cold" };
  } catch (err) {
    state.lastError = err.message?.slice(0, 200);
    state.lastErrorAt = new Date().toISOString();
    return { mint: mint.mint, action: "error", error: state.lastError };
  } finally {
    state.inFlight.delete(mint.mint);
  }
}

async function warmupLoop(lenderPk, programIdV4) {
  const remaining = state.priorityMints.filter((m) => !state.warmMints.has(m.mint));
  if (remaining.length === 0) {
    state.completedAt = new Date().toISOString();
    console.log(`[v4-readiness] warmup complete — all ${state.priorityMints.length} priority mints warm`);
    return;
  }

  // Round-robin in batches of WARMUP_CONCURRENCY.
  const batch = remaining.slice(0, WARMUP_CONCURRENCY);
  await Promise.all(batch.map((m) => ensureMintWarm(m, lenderPk, programIdV4)));

  // Recurse after spacing — gives previous batch's tx confirmations
  // time to settle.
  setTimeout(() => {
    warmupLoop(lenderPk, programIdV4).catch((e) =>
      console.warn("[v4-readiness] loop tick threw:", e.message?.slice(0, 120)),
    );
  }, WARMUP_BATCH_SPACING_MS);
}

export async function startFeedReadinessWarmup() {
  if (process.env.V4_WARMUP_DISABLED === "true") {
    console.log("[v4-readiness] disabled via env");
    return;
  }
  const { PROGRAM_ID_V4 } = await import("../solana/program.js");
  if (!PROGRAM_ID_V4) {
    console.log("[v4-readiness] PROGRAM_ID_V4 unset — skipping");
    return;
  }
  if (!process.env.LENDER_PUBKEY) {
    console.log("[v4-readiness] LENDER_PUBKEY unset — skipping");
    return;
  }
  const lenderPk = new PublicKey(process.env.LENDER_PUBKEY);

  try {
    state.priorityMints = await listPriorityMints();
  } catch (err) {
    console.error("[v4-readiness] failed to list priority mints:", err.message?.slice(0, 200));
    return;
  }

  state.startedAt = new Date().toISOString();
  console.log(`[v4-readiness] starting warmup — ${state.priorityMints.length} priority mints (concurrency ${WARMUP_CONCURRENCY}, ${WARMUP_BATCH_SPACING_MS}ms spacing)`);

  warmupLoop(lenderPk, PROGRAM_ID_V4).catch((e) =>
    console.warn("[v4-readiness] initial loop threw:", e.message?.slice(0, 120)),
  );

  // Per-mint on-demand loop. Runs continuously in the background and
  // aggressively warms any mint a user has shown interest in within
  // the last ON_DEMAND_HOT_WINDOW_MS. Solves the "user picks a non-
  // priority mint" gap operator-mandated 2026-06-19 PM after the
  // global readiness gate was insufficient.
  onDemandLoop(lenderPk, PROGRAM_ID_V4).catch((e) =>
    console.warn("[v4-readiness] on-demand loop threw:", e.message?.slice(0, 120)),
  );

  // FAST COLD-START BURST LOOP — drains the burst queue every ~1.5s so a
  // freshly-requested cold mint warms in ~12–15s (first-attempt borrow
  // success). Idle when the queue is empty; see
  // feedback_first_attempt_loan_success_cost_effective.
  burstLoop(lenderPk, PROGRAM_ID_V4).catch((e) =>
    console.warn("[v4-readiness] burst loop threw:", e.message?.slice(0, 120)),
  );

  // CONTINUOUS ALL-MINTS LOOP — every enabled V4 mint stays warm 24/7.
  // Operator-mandated 2026-06-19 PM (feedback_every_mint_must_pass_every_sample).
  // This is THE architectural layer that makes the protocol non-negotiable
  // for any approved token. Round-robin attests every enabled mint at
  // CONTINUOUS_CONCURRENCY × CONTINUOUS_BATCH_SPACING_MS cadence.
  // Skip-if-buffered logic keeps SOL spend bounded.
  continuousAllMintsLoop(lenderPk, PROGRAM_ID_V4).catch((e) =>
    console.warn("[v4-readiness] continuous loop threw:", e.message?.slice(0, 120)),
  );
}

/**
 * Read-only per-mint readiness check. Returns the current sample-in-
 * window count without firing attestation. Cheap; site can poll.
 *
 * Used by the /api/v1/v4/feed-ready endpoint and as the source of
 * truth in requestMintWarm.
 */
export async function checkMintReadiness(mintStr) {
  const { PROGRAM_ID_V4 } = await import("../solana/program.js");
  if (!PROGRAM_ID_V4 || !process.env.LENDER_PUBKEY) {
    return { ready: false, reason: "v4_not_configured", samples_in_window: 0 };
  }
  const lenderPk = new PublicKey(process.env.LENDER_PUBKEY);
  const { lendingPoolPda, priceFeedPda } = await import("../solana/pdas.js");
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(lenderPk, PROGRAM_ID_V4);
  const [pf] = priceFeedPda(mintPk, pool, PROGRAM_ID_V4);

  let info;
  try {
    info = await withFailover((conn) => conn.getAccountInfo(pf, "confirmed"));
  } catch {
    return { ready: false, reason: "rpc_unavailable", samples_in_window: 0 };
  }
  if (!info || info.data.length < 120) {
    return { ready: false, reason: "uninitialized", samples_in_window: 0 };
  }
  const head = info.data.readUInt8(104);
  const count = info.data.readUInt8(105);
  if (count < MIN_SAMPLES_FOR_TWAP) {
    return { ready: false, reason: "no_samples_yet", samples_in_window: count };
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const windowStart = now - BigInt(TWAP_WINDOW_SECONDS);
  let inWindow = 0;
  for (let i = 0; i < Math.min(count, 32); i++) {
    const idx = (head - 1 - i + 32) % 32;
    const start = 112 + idx * 16;
    if (start + 16 > info.data.length) break;
    const ts = info.data.readBigInt64LE(start + 8);
    if (ts >= windowStart) inWindow++;
  }
  if (inWindow >= MIN_SAMPLES_FOR_TWAP) {
    return { ready: true, samples_in_window: inWindow };
  }
  // Estimate ETA: at 3s on-demand spacing per round + ~2s per attest
  // confirmation, each missing sample costs ~5s.
  const missing = MIN_SAMPLES_FOR_TWAP - inWindow;
  const etaSeconds = missing * 5;
  return {
    ready: false,
    reason: "insufficient_samples_in_window",
    samples_in_window: inWindow,
    samples_needed: MIN_SAMPLES_FOR_TWAP,
    eta_seconds: etaSeconds,
  };
}

/**
 * Record user interest in a mint. The on-demand loop reads from this
 * map and aggressively warms any mint requested in the last
 * ON_DEMAND_HOT_WINDOW_MS. Idempotent and cheap.
 *
 * Validates the mint is supported + enabled to prevent random callers
 * draining lender SOL on garbage mints.
 */
export async function requestMintWarm(mintStr) {
  const { rows: [row] } = await query(
    `SELECT mint, decimals, enabled, category
       FROM supported_mints WHERE mint = $1`,
    [mintStr],
  );
  if (!row) {
    return { ok: false, error: "mint_not_supported" };
  }
  if (!row.enabled) {
    return { ok: false, error: "mint_disabled" };
  }
  const existing = state.onDemand.get(mintStr) || { requestedCount: 0 };
  state.onDemand.set(mintStr, {
    lastRequestedAt: Date.now(),
    requestedCount: existing.requestedCount + 1,
    decimals: Number(row.decimals),
    category: row.category,
  });
  const readiness = await checkMintReadiness(mintStr);
  // Not ready → enqueue for the fast burst so it warms in ~12–15s rather
  // than the ~30–45s on-demand drip. Idempotent: re-requesting a mint
  // already bursting just refreshes its slot without resetting attempts.
  if (!readiness.ready && !state.burst.has(mintStr)) {
    state.burst.set(mintStr, {
      decimals: Number(row.decimals),
      category: row.category,
      attempts: 0,
      addedAt: Date.now(),
    });
  }
  return { ok: true, ...readiness };
}

/**
 * WARM-ON-ENABLE (operator 2026-06-28, CRITICAL): make a just-enabled token
 * IMMEDIATELY V4-borrow-ready instead of waiting for a periodic sweep. Called
 * synchronously by EVERY path that flips supported_mints.enabled=TRUE (screener
 * auto-approve, RWA screener, review-queue promote, web/TG submit). It (1) inits
 * the on-chain price-feed PDAs so a borrow never hits AccountNotInitialized, and
 * (2) pushes the mint onto the on-demand warm queue so attestation starts within
 * ~3s — filling the V4 TWAP window (8 samples) in ~24s instead of ~140s. New
 * mints default to attestation_tier='hot', so the continuous attestor then keeps
 * the window full. Best-effort (the 90s feed-init sweep + 20s attestor still
 * backstop) — never blocks/aborts the approval. See
 * feedback_new_token_immediately_v4_borrowable.
 */
export async function warmMintForBorrow(mintStr, source = "enable") {
  try {
    const { ensureMintFeedsInitialized } = await import("./price-attestor.js");
    await ensureMintFeedsInitialized(mintStr);
  } catch (e) {
    console.warn(`[warm-on-enable] feed-init ${mintStr} failed (sweep backstops): ${e.message?.slice(0, 100)}`);
  }
  try {
    await requestMintWarm(mintStr);
  } catch (e) {
    console.warn(`[warm-on-enable] requestMintWarm ${mintStr} failed: ${e.message?.slice(0, 100)}`);
  }
  console.log(`[warm-on-enable] kicked feed-init + on-demand attestation for ${mintStr} (source=${source})`);
}

async function onDemandLoop(lenderPk, programIdV4) {
  // Pull mints requested in the last hot window. Drop expired entries
  // so the map stays small.
  const now = Date.now();
  const cutoff = now - ON_DEMAND_HOT_WINDOW_MS;
  for (const [mint, entry] of state.onDemand.entries()) {
    if (entry.lastRequestedAt < cutoff) state.onDemand.delete(mint);
  }
  const hot = Array.from(state.onDemand.entries()).map(([mint, entry]) => ({
    mint, decimals: entry.decimals, category: entry.category,
  }));

  if (hot.length > 0) {
    // Batch process — same concurrency as priority warmup.
    const batch = hot.slice(0, WARMUP_CONCURRENCY);
    const results = await Promise.all(batch.map((m) => ensureMintWarm(m, lenderPk, programIdV4)));
    const initialized = results.filter((r) => r.action === "now_warm").length;
    if (initialized > 0) {
      console.log(`[v4-readiness] on-demand round warmed ${initialized}/${batch.length} hot mints`);
    }
  }
  setTimeout(() => {
    onDemandLoop(lenderPk, programIdV4).catch((e) =>
      console.warn("[v4-readiness] on-demand loop threw:", e.message?.slice(0, 120)),
    );
  }, ON_DEMAND_LOOP_SPACING_MS);
}

/**
 * Attest a single burst mint. Returns early (no attestation) if it's
 * already at the target sample count — draining it from the queue — or if
 * another loop is mid-attestation on it. Otherwise fires one attestation
 * (initializing the feed PDA first if missing) and bumps its attempt
 * counter, dropping it back to normal on-demand cadence once exhausted.
 */
async function processBurstMint(mint, entry, lenderPk, programIdV4) {
  if (state.inFlight.has(mint)) return { mint, action: "in_flight_skip" };

  // Already warm enough? drain from burst + mark warm.
  const readiness = await checkMintReadiness(mint);
  if (
    readiness.ready &&
    typeof readiness.samples_in_window === "number" &&
    readiness.samples_in_window >= BURST_TARGET_SAMPLES
  ) {
    state.burst.delete(mint);
    state.warmMints.add(mint);
    return { mint, action: "burst_ready" };
  }

  state.inFlight.add(mint);
  try {
    const { attestPrice, initializePriceFeed } = await import("./price-attestor.js");
    try {
      await attestPrice(mint, entry.decimals, undefined, programIdV4);
    } catch (err) {
      if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(err.message || "")) {
        await initializePriceFeed(mint, programIdV4);
        await attestPrice(mint, entry.decimals, undefined, programIdV4);
      } else {
        throw err;
      }
    }
    return { mint, action: "burst_attested" };
  } catch (err) {
    state.lastError = `burst attest ${mint.slice(0, 8)}: ${err.message?.slice(0, 120)}`;
    state.lastErrorAt = new Date().toISOString();
    return { mint, action: "burst_error" };
  } finally {
    state.inFlight.delete(mint);
    entry.attempts++;
    // Exhausted the burst budget — drop back to the normal on-demand
    // cadence (the mint stays in state.onDemand for another few minutes).
    if (entry.attempts >= BURST_MAX_ATTEMPTS) state.burst.delete(mint);
  }
}

/**
 * FAST COLD-START BURST LOOP — drains state.burst aggressively so a mint a
 * user just showed intent on reaches its TWAP threshold in ~12–15s. Runs
 * every BURST_SPACING_MS, processing up to BURST_MAX_CONCURRENT mints in
 * parallel. Idle (empty queue) cost is one timer tick — no attestations,
 * no SOL. See [[feedback_first_attempt_loan_success_cost_effective]].
 */
async function burstLoop(lenderPk, programIdV4) {
  // DRAIN GUARD (security): the burst is the most aggressive attestation path
  // (~1.5s cadence, up to BURST_MAX_ATTEMPTS/mint, unbatched) and it's reachable
  // from the PUBLIC /warm-mint(s) beacons via requestMintWarm. If the deployer
  // wallet is low, pause bursting entirely so a spam/IP-rotation attacker can't
  // amplify a low balance toward drain — the batched continuous loop still keeps
  // active-loan feeds warm. Queue is retained; it resumes when the wallet refills.
  try {
    const { deployerBalanceIsLow } = await import("./price-attestor.js");
    if (await deployerBalanceIsLow()) {
      setTimeout(() => {
        burstLoop(lenderPk, programIdV4).catch((e) =>
          console.warn("[v4-readiness] burst loop threw:", e.message?.slice(0, 120)),
        );
      }, Math.max(BURST_SPACING_MS, 10_000));
      return;
    }
  } catch {
    /* if the guard read fails, fall through — better to warm than to stall */
  }

  const mints = Array.from(state.burst.entries()).slice(0, BURST_MAX_CONCURRENT);
  if (mints.length > 0) {
    await Promise.all(
      mints.map(([mint, entry]) =>
        processBurstMint(mint, entry, lenderPk, programIdV4).catch((e) => {
          state.burst.delete(mint);
          return { mint, action: "burst_threw", error: e.message?.slice(0, 120) };
        }),
      ),
    );
  }
  setTimeout(() => {
    burstLoop(lenderPk, programIdV4).catch((e) =>
      console.warn("[v4-readiness] burst loop threw:", e.message?.slice(0, 120)),
    );
  }, BURST_SPACING_MS);
}

/**
 * CONTINUOUS ALL-MINTS LOOP — the architecture that fulfills the
 * operator's 2026-06-19 PM mandate: every enabled V4 mint must
 * continuously have ≥8 fresh TWAP samples on-chain at all times.
 *
 * On each tick, picks the next CONTINUOUS_CONCURRENCY mints from a
 * round-robin cursor over ALL enabled V4 mints. For each picked mint:
 *   1. Reads the on-chain ring buffer.
 *   2. If samples_in_window ≥ MIN_SAMPLES_FOR_TWAP + CONTINUOUS_BUFFER_SAMPLES,
 *      skip — already healthy.
 *   3. Otherwise fire one attestation. Init the feed PDA first if needed.
 *
 * After a tick, waits CONTINUOUS_BATCH_SPACING_MS, then advances the
 * cursor and repeats.
 *
 * Net behavior at steady state:
 *   174 mints, concurrency 16, 3s spacing → full cycle every ~33s
 *   Each mint attested every ~33s
 *   TWAP window is 300s → ~9 samples per mint per window
 *   ≥ MIN_SAMPLES_FOR_TWAP = 8 always met
 *
 * Skip-if-buffered logic means steady-state SOL spend is BELOW the
 * worst-case 5.3 attestations/sec. Mints sitting at 10 samples don't
 * get attested until they drift to 9, then 8.
 */
// WARM-ALL is the default (2026-07-15). Batched attestation made keeping
// EVERY enabled token continuously warm cheap (~0.2 SOL/day for ~175 mints
// vs ~2.3 unbatched), so we no longer leave cold-tier tokens to a slow,
// failure-prone just-in-time warm at borrow time. Every enabled memecoin/
// stock is kept warm 24/7 → a borrow on ANY token never hits
// TwapInsufficientHistory / "oracle warming up". The tiered filter is kept
// as an env-gated fallback (ATTEST_WARM_ALL=false) for when the catalog
// grows large enough that warming everything is no longer the cheapest path
// (then: warm the active core + burst the long tail on demand).
// Supersedes [[feedback_tiered_attestation_cost_conscious]] for the current
// scale. See [[feedback_first_attempt_loan_success_cost_effective]].
async function refreshContinuousList() {
  const warmAll = process.env.ATTEST_WARM_ALL !== "false"; // default ON
  let rows;
  if (warmAll) {
    // Warm EVERY enabled memecoin/stock — no tier gate.
    ({ rows } = await query(
      `SELECT mint, decimals, symbol, category
         FROM supported_mints
        WHERE enabled = TRUE
          AND category IN ('memecoin', 'stock')`,
    ));
  } else {
    // Tiered fallback: hot + protected + any borrower activity/intent only.
    ({ rows } = await query(
      `WITH active_loan_mints AS (
         SELECT DISTINCT collateral_mint FROM loans WHERE status = 'active'
       ),
       armed_exit_mints AS (
         SELECT DISTINCT l.collateral_mint
           FROM limit_close_orders lc
           JOIN loans l ON l.id = lc.loan_id
          WHERE lc.status IN ('armed', 'firing', 'twap_in_progress', 'firing_started')
       ),
       recent_intent_mints AS (
         SELECT DISTINCT l.collateral_mint
           FROM arm_intents ai
           JOIN loans l ON l.loan_id::text = ai.loan_id_chain
          WHERE ai.created_at > NOW() - INTERVAL '15 minutes'
       ),
       warming_mints AS (
         SELECT DISTINCT mint AS collateral_mint
           FROM mint_warming_intents
          WHERE expires_at > NOW()
       )
       SELECT sm.mint, sm.decimals, sm.symbol, sm.category
         FROM supported_mints sm
         LEFT JOIN active_loan_mints alm ON alm.collateral_mint = sm.mint
         LEFT JOIN armed_exit_mints aem ON aem.collateral_mint = sm.mint
         LEFT JOIN recent_intent_mints rim ON rim.collateral_mint = sm.mint
         LEFT JOIN warming_mints wm ON wm.collateral_mint = sm.mint
        WHERE sm.enabled = TRUE
          AND sm.category IN ('memecoin', 'stock')
          AND (
            sm.attestation_tier = 'hot'
            OR sm.protected = TRUE
            OR alm.collateral_mint IS NOT NULL
            OR aem.collateral_mint IS NOT NULL
            OR rim.collateral_mint IS NOT NULL
            OR wm.collateral_mint IS NOT NULL
          )`,
    ));
  }
  state.continuousList = rows.map((r) => ({
    mint: r.mint,
    decimals: Number(r.decimals),
    symbol: r.symbol,
    category: r.category,
  }));
  state.continuousListRefreshedAt = Date.now();
  console.log(`[v4-readiness] continuous-loop: refreshed mint list — ${state.continuousList.length} enabled V4 mints (warm_all=${warmAll})`);
}

async function continuousAllMintsLoop(lenderPk, programIdV4) {
  // Refresh mint list periodically — handles new mints added at runtime.
  const sinceRefresh = Date.now() - state.continuousListRefreshedAt;
  if (state.continuousList.length === 0 || sinceRefresh > CONTINUOUS_LIST_REFRESH_INTERVAL_MS) {
    try {
      await refreshContinuousList();
    } catch (err) {
      console.warn("[v4-readiness] continuous-loop: refresh failed:", err.message?.slice(0, 120));
    }
  }

  const list = state.continuousList;
  if (list.length === 0) {
    setTimeout(() => continuousAllMintsLoop(lenderPk, programIdV4).catch((e) =>
      console.warn("[v4-readiness] continuous loop threw:", e.message?.slice(0, 120)),
    ), 30_000);
    return;
  }

  // Kill-switch: V4_CONTINUOUS_CONCURRENCY=0 pauses the sweep. Re-checks
  // every 30s so flipping the env var back to nonzero resumes without
  // a redeploy. Operator uses this when Jupiter is in a 429 storm.
  if (CONTINUOUS_CONCURRENCY <= 0) {
    setTimeout(() => continuousAllMintsLoop(lenderPk, programIdV4).catch((e) =>
      console.warn("[v4-readiness] continuous loop threw:", e.message?.slice(0, 120)),
    ), 30_000);
    return;
  }

  // Build batch:
  // 1. ALL stocks always — every tick, guaranteed.
  //    xStocks (Token-2022, transfer hooks) attest slower and tend to fall
  //    below the 8-sample threshold first because they're a small subset
  //    of the round-robin (~5-10 mints out of 172). Putting them in every
  //    batch guarantees each stock gets attested every 3s — way under the
  //    37.5s required cadence, so samples never drift below 8 even with
  //    occasional Token-2022 attestation failures.
  //    Operator-mandated 2026-06-19 PM after xStock SPCX oscillated at 7/8
  //    while every memecoin sat at 8+. Per-stock extra cost: ~0.005 SOL/day.
  // 2. Round-robin memecoins fill the remaining slots — same logic as before.
  const stocks = list.filter((m) => m.category === 'stock');
  const memecoins = list.filter((m) => m.category !== 'stock');

  // Size the per-tick batch so the WHOLE list is cycled within a target
  // window (default 25s, safely under the 37.5s cadence needed for 8
  // samples in 300s) — otherwise warming ~175 mints (warm-all) with the
  // old fixed batch of 16 would starve the memecoin round-robin and let
  // feeds drift below threshold. Batched attestation makes the extra
  // per-tick throughput cheap; readiness reads are lightweight. Bounded by
  // V4_CONTINUOUS_MAX_BATCH to cap RPC per tick.
  // See [[feedback_first_attempt_loan_success_cost_effective]].
  const TARGET_CYCLE_MS = Number(process.env.V4_CONTINUOUS_TARGET_CYCLE_MS) || 25_000;
  const MAX_BATCH = Number(process.env.V4_CONTINUOUS_MAX_BATCH) || 64;
  const memeSlotsNeeded = Math.max(1, Math.ceil((memecoins.length * CONTINUOUS_BATCH_SPACING_MS) / TARGET_CYCLE_MS));
  const effectiveConcurrency = Math.min(
    MAX_BATCH,
    Math.max(CONTINUOUS_CONCURRENCY, stocks.length + memeSlotsNeeded),
  );

  const batch = [];
  for (const s of stocks) {
    if (batch.length >= effectiveConcurrency) break;
    batch.push(s);
  }
  const memeSlots = effectiveConcurrency - batch.length;
  for (let i = 0; i < memeSlots && i < memecoins.length; i++) {
    batch.push(memecoins[(state.continuousCursor + i) % memecoins.length]);
  }
  state.continuousCursor = (state.continuousCursor + memeSlots) % Math.max(memecoins.length, 1);

  // Readiness-filter the batch (a cheap on-chain read; buffered mints cost
  // nothing), then BATCH the needed attestations into multi-instruction
  // transactions — the same cost win as the main attestor tick. This is
  // what keeps every V4 mint warm 24/7 affordably.
  // See [[feedback_first_attempt_loan_success_cost_effective]].
  const needy = [];
  await Promise.all(
    batch.map(async (m) => {
      if (state.inFlight.has(m.mint)) return;
      try {
        const readiness = await checkMintReadiness(m.mint);
        const buffered =
          readiness.ready &&
          typeof readiness.samples_in_window === "number" &&
          readiness.samples_in_window >= MIN_SAMPLES_FOR_TWAP + CONTINUOUS_BUFFER_SAMPLES;
        if (buffered) {
          state.continuousSkipped++;
          return;
        }
        needy.push(m);
      } catch {
        // readiness read blip — treat as needy so a feed never starves.
        needy.push(m);
      }
    }),
  );

  if (needy.length > 0) {
    try {
      const { attestPriceBatch } = await import("./price-attestor.js");
      const { getPricesInSolBatch, getPriceInSol } = await import("./price.js");
      let priceMap = new Map();
      try {
        priceMap = await getPricesInSolBatch(needy.map((m) => m.mint));
      } catch {
        priceMap = new Map();
      }
      // Per-mint backfill for anything the batch endpoint omits (Token-2022
      // stocks need Dex-first routing) — mirrors the main attestor tick.
      const missing = needy.filter((m) => !priceMap.has(m.mint));
      for (const m of missing) {
        try {
          const p = await getPriceInSol(m.mint);
          if (p) priceMap.set(m.mint, p);
        } catch {
          /* this mint retries next tick */
        }
      }
      const items = needy
        .map((m) => ({ mint: m.mint, decimals: m.decimals, priceSol: priceMap.get(m.mint) }))
        .filter((it) => it.priceSol && it.priceSol > 0);
      // Guard against double-attest races with the on-demand/burst loops.
      for (const it of items) state.inFlight.add(it.mint);
      try {
        const res = await attestPriceBatch(items, programIdV4, { label: "v4-continuous" });
        state.continuousAttestations += res.attested.length;
        state.continuousErrors += res.failed.length;
        if (res.failed.length) {
          state.lastError = `v4-continuous batch: ${res.failed[0].err}`;
          state.lastErrorAt = new Date().toISOString();
        }
      } finally {
        for (const it of items) state.inFlight.delete(it.mint);
      }
    } catch (e) {
      state.continuousErrors++;
      console.warn("[v4-readiness] continuous batch threw:", e.message?.slice(0, 120));
    }
  }

  setTimeout(() => continuousAllMintsLoop(lenderPk, programIdV4).catch((e) =>
    console.warn("[v4-readiness] continuous loop threw:", e.message?.slice(0, 120)),
  ), CONTINUOUS_BATCH_SPACING_MS);
}
