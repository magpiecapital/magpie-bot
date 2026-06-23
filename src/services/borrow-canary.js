/**
 * Borrow canary — every 60s, probes the four critical predictors of a
 * successful V4 borrow. If any fails, logs to conversion_events with
 * path='borrow_canary'. Two consecutive fails per check → CRIT-DM
 * operator with class. First success after a fail → "recovered" DM.
 *
 * Predictors (each is a separate event row, so /convstats can split):
 *   1. rpc      — withFailover getLatestBlockhash (RPC health)
 *   2. twap     — /api/v1/v4/twap?mint=<memecoin V4 mint> (oracle warm)
 *   3. twap     — /api/v1/v4/twap?mint=<stock V4 mint> (oracle warm, stock path)
 *   4. health   — /api/v1/health internal call (composite liveness)
 *
 * Pure read path — no SOL spent, no on-chain tx, no user impact.
 *
 * Operator-mandated 2026-06-19 PM per
 * [[feedback_v4_loan_lifecycle_zero_errors_mandate]]: catches
 * degradations within 60s, beats every other layer for MTTD.
 */
import { withFailover } from "../solana/connection.js";
import { recordConversionEvent } from "./conversion-tracker.js";
import { getAdminId } from "./admin-notify.js";
import { query } from "../db/pool.js";

const TICK_INTERVAL_MS = Number(process.env.BORROW_CANARY_INTERVAL_MS) || 60_000;
const FAIL_DEBOUNCE = Number(process.env.BORROW_CANARY_FAIL_DEBOUNCE) || 2;

// Canary mints — pick a CURRENTLY-ENABLED memecoin + stock from supported_mints
// so the canary always validates a REAL borrowable mint and AUTO-ADAPTS when a
// mint is delisted. A hardcoded mint going stale was the root cause of the SPCX
// false-positive class: after SPCX (XsbEhLAt…) was delisted, the canary kept
// probing it, /api/v1/v4/twap returned 404 mint_not_supported forever, and it
// alarmed "users would see this borrowing" — for a mint NO user can borrow.
// An env override (CANARY_MEMECOIN_MINT / CANARY_STOCK_MINT) is honored ONLY
// while it's still enabled; otherwise we auto-pick the most stable enabled mint
// in the category (protected + hot first). Cached 5 min.
let _canaryMints = null;
let _canaryMintsAt = 0;
const CANARY_MINTS_TTL_MS = 5 * 60_000;

async function pickEnabledMint(categories, preferredEnv) {
  // Honor the env override only if it is still an enabled supported_mint.
  if (preferredEnv) {
    try {
      const { rows } = await query(
        `SELECT 1 FROM supported_mints WHERE mint = $1 AND enabled = TRUE`,
        [preferredEnv],
      );
      if (rows.length) return preferredEnv;
    } catch { /* fall through to auto-pick */ }
  }
  try {
    const { rows } = await query(
      `SELECT mint FROM supported_mints
         WHERE enabled = TRUE AND category = ANY($1)
         ORDER BY protected DESC, (attestation_tier = 'hot') DESC, created_at ASC
         LIMIT 1`,
      [categories],
    );
    return rows.length ? rows[0].mint : null;
  } catch {
    return null;
  }
}

async function getCanaryMints() {
  const now = Date.now();
  if (_canaryMints && now - _canaryMintsAt < CANARY_MINTS_TTL_MS) return _canaryMints;
  const memecoin = await pickEnabledMint(["memecoin"], process.env.CANARY_MEMECOIN_MINT);
  const stock = await pickEnabledMint(["stock", "etf", "metal"], process.env.CANARY_STOCK_MINT);
  _canaryMints = { memecoin, stock };
  _canaryMintsAt = now;
  return _canaryMints;
}

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL
  || `http://127.0.0.1:${process.env.PORT || 3000}`;

// Per-check consecutive fail counters. Reset on first success.
const consecFails = new Map(); // checkName → int
const alertedAt = new Map();   // checkName → timestamp of last alert (debounce)

function classifyError(e) {
  const m = (e?.message || String(e)).toLowerCase();
  if (m.includes("warming") || m.includes("insufficient_history") || m.includes("twapinsufficient")) return "v4_twap_warming";
  if (m.includes("uninitialized") || m.includes("not_initialized")) return "v4_feed_uninitialized";
  if (m.includes("stale") || m.includes("attestation")) return "v4_stale_attestation";
  if (m.includes("timeout") || m.includes("abort")) return "network_timeout";
  if (m.includes("502") || m.includes("503") || m.includes("504")) return "infra_5xx";
  if (m.includes("rate") && m.includes("limit")) return "rpc_rate_limited";
  if (m.includes("blockhash")) return "rpc_blockhash";
  return "other";
}

async function probeRpcBlockhash() {
  const start = Date.now();
  try {
    const bh = await withFailover(async (conn) => conn.getLatestBlockhash("confirmed"));
    if (!bh?.blockhash) throw new Error("no blockhash returned");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: e, class: classifyError(e) };
  }
}

async function probeTwap(mint) {
  const start = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5_000);
    const res = await fetch(`${BOT_INTERNAL_URL}/api/v1/v4/twap?mint=${encodeURIComponent(mint)}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) {
      // A delisted (404 mint_not_supported) or disabled (409 mint_disabled) mint
      // is NOT user-borrowable, so it is NOT a user-facing borrow failure — never
      // alarm on it (the next tick re-selects a live mint). Only a genuine route
      // / infra / data error alarms. Distinguish via the error body.
      let errBody = null;
      try { errBody = await res.json(); } catch { /* body not json */ }
      if (errBody?.error === "mint_not_supported" || errBody?.error === "mint_disabled") {
        return { ok: true, latencyMs: Date.now() - start, skipped: errBody.error };
      }
      throw new Error(`twap http_${res.status}`);
    }
    const body = await res.json();
    if (!body || body.error || !body.twap_lamports_per_whole) {
      throw new Error(body?.error || "twap_missing_field");
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: e, class: classifyError(e) };
  }
}

async function probeHealth() {
  const start = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3_000);
    const res = await fetch(`${BOT_INTERNAL_URL}/api/v1/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`health http_${res.status}`);
    const body = await res.json();
    if (body?.status !== "ok") throw new Error(`health status_${body?.status}`);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: e, class: classifyError(e) };
  }
}

async function recordAndMaybeAlert(bot, checkName, result, mint, programId) {
  // Telemetry every tick.
  await recordConversionEvent({
    path: "borrow_canary",
    outcome: result.ok ? "success" : "failure",
    failureClass: result.ok ? null : result.class,
    mint: mint ?? null,
    programId: programId ?? null,
    wallet: null,
    surface: "canary",
    latencyMs: result.latencyMs,
    detail: result.ok ? { check: checkName } : { check: checkName, error: (result.error?.message || String(result.error || "")).slice(0, 200) },
  });

  const adminId = getAdminId();
  if (!bot || !adminId) return;

  if (result.ok) {
    const prev = consecFails.get(checkName) || 0;
    if (prev >= FAIL_DEBOUNCE) {
      // Recovery — send single DM and reset state.
      try {
        await bot.api.sendMessage(adminId, `Canary recovered — \`${checkName}\` is healthy again after ${prev} consecutive fails.`, { parse_mode: "Markdown" });
      } catch { /* swallow DM err */ }
    }
    consecFails.set(checkName, 0);
    alertedAt.delete(checkName);
    return;
  }

  const next = (consecFails.get(checkName) || 0) + 1;
  consecFails.set(checkName, next);
  if (next < FAIL_DEBOUNCE) return; // not yet noisy

  // De-bounce repeated alerts — re-notify every 30 min if still failing.
  const lastAt = alertedAt.get(checkName) || 0;
  if (Date.now() - lastAt < 30 * 60_000) return;
  alertedAt.set(checkName, Date.now());

  const msg = [
    `🚨 *Borrow canary degraded*`,
    ``,
    `Check: \`${checkName}\``,
    `Class: \`${result.class}\``,
    `Consecutive fails: ${next}`,
    `Latency: ${result.latencyMs}ms`,
    ``,
    `Error: \`${(result.error?.message || String(result.error || "")).slice(0, 160)}\``,
    ``,
    `_Users would currently see this class trying to borrow. Investigate ASAP._`,
  ].join("\n");
  try {
    await bot.api.sendMessage(adminId, msg, { parse_mode: "Markdown" });
  } catch { /* swallow DM err */ }
}

async function tick(bot) {
  // Resolve the live mints to probe (dynamic — auto-adapts to delistings).
  const { memecoin, stock } = await getCanaryMints();

  // Always-on probes + a twap probe per live mint that exists. Stable check
  // names ("twap_memecoin" / "twap_stock") so the consecutive-fail counter is
  // tied to the CATEGORY, not a specific mint address — a delisting swaps the
  // underlying mint without resetting/orphaning a per-address counter.
  const probes = [
    ["rpc_blockhash", probeRpcBlockhash(), null],
    ["health", probeHealth(), null],
  ];
  if (memecoin) probes.push(["twap_memecoin", probeTwap(memecoin), memecoin]);
  if (stock) probes.push(["twap_stock", probeTwap(stock), stock]);

  const results = await Promise.all(probes.map(([, p]) => p));
  await Promise.all(
    probes.map(([name, , mint], i) => recordAndMaybeAlert(bot, name, results[i], mint, null)),
  );
}

export function startBorrowCanary(bot) {
  if (process.env.BORROW_CANARY_DISABLED === "true") {
    console.log("[borrow-canary] disabled via BORROW_CANARY_DISABLED=true");
    return;
  }
  console.log(`[borrow-canary] starting — every ${TICK_INTERVAL_MS}ms, debounce=${FAIL_DEBOUNCE}, mints=dynamic (live enabled memecoin + stock, auto-adapts to delistings)`);
  // Initial delayed run so the bot has time to bind the port.
  setTimeout(() => tick(bot).catch((e) => console.warn("[borrow-canary] tick err:", e.message)), 30_000);
  setInterval(() => tick(bot).catch((e) => console.warn("[borrow-canary] tick err:", e.message)), TICK_INTERVAL_MS);
}
