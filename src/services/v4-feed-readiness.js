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
    in_flight: state.inFlight.size,
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
  return { ok: true, ...readiness };
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
