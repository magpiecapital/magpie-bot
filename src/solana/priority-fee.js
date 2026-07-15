/**
 * Dynamic Solana priority-fee estimation with a hard cost ceiling.
 *
 * WHY (2026-07-15): every tx-send path used a hardcoded
 * `setComputeUnitPrice({ microLamports: 100_000 })` and the price attestor
 * used none at all. During a mainnet congestion spike, under-priced txns are
 * dropped by validators and expire (the "not confirmed in 30s" flood), which
 * stalls price attestations and, in turn, hangs live borrows ("stuck on
 * signing"). See project_dynamic_priority_fees_rebroadcast.
 *
 * This module returns a per-compute-unit fee (microLamports) that TRACKS real
 * network demand instead of a flat guess:
 *   - primary source: Helius `getPriorityFeeEstimate` (recommended level)
 *   - fallback:       native `getRecentPrioritizationFees` (high percentile)
 *   - last resort:    the configured floor
 * The result is scaled by a safety multiplier, then clamped to [floor, cap].
 *
 * COST: because the estimate is usually well BELOW the old flat 100k in calm
 * conditions, average spend DROPS; the fee only rises (up to the hard cap)
 * when the network genuinely demands it. The cap (`MAX_PRIORITY_FEE_MICROLAMPORTS`)
 * guarantees spend can never run away. Every refresh is logged.
 *
 * The estimate is cached process-wide for a short TTL so a sweep of hundreds
 * of attestations issues ONE fee RPC, not one-per-tx (avoids self-inflicted
 * rate limits).
 */
import { ComputeBudgetProgram } from "@solana/web3.js";
import { connection } from "./connection.js";
import "dotenv/config";

const PRIMARY_RPC = process.env.SOLANA_RPC_URL || "";

// Never pay less than this (keeps us competitive even if an estimate reads 0).
const FLOOR = Number(process.env.MIN_PRIORITY_FEE_MICROLAMPORTS) || 25_000;
// Hard ceiling — spend can NEVER exceed this per compute unit. Operator lever.
const CAP = Number(process.env.MAX_PRIORITY_FEE_MICROLAMPORTS) || 2_000_000;
// Headroom over the raw estimate so we reliably land, not just barely.
const MULTIPLIER = Number(process.env.PRIORITY_FEE_MULTIPLIER) || 1.5;
// How long a single estimate is reused across many sends.
const CACHE_TTL_MS = Number(process.env.PRIORITY_FEE_CACHE_MS) || 8_000;

// Cache the RAW network estimate (pre-clamp), so one RPC serves many callers
// even when they apply different floor/cap/multiplier overrides.
let _cache = { raw: FLOOR, source: "floor", at: 0 };

async function fetchHeliusEstimate(accountKeys) {
  if (!/helius/i.test(PRIMARY_RPC)) throw new Error("primary RPC is not Helius");
  const params = [{ options: { recommended: true } }];
  if (accountKeys && accountKeys.length) params[0].accountKeys = accountKeys;
  const res = await fetch(PRIMARY_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getPriorityFeeEstimate", params }),
    signal: AbortSignal.timeout(4000),
  });
  const j = await res.json();
  const est = j?.result?.priorityFeeEstimate;
  if (typeof est !== "number" || !Number.isFinite(est)) throw new Error("no Helius estimate");
  return est;
}

async function fetchNativeEstimate(accountKeys) {
  // getRecentPrioritizationFees returns up to ~150 recent slots' fees.
  // Use the 75th percentile of the NON-zero fees so a few idle slots don't
  // drag us to 0 during real congestion.
  const pubkeys = (accountKeys || []).slice(0, 128);
  const recent = await connection.getRecentPrioritizationFees(
    pubkeys.length ? { lockedWritableAccounts: pubkeys } : {},
  );
  const fees = (recent || [])
    .map((r) => Number(r.prioritizationFee) || 0)
    .filter((f) => f > 0)
    .sort((a, b) => a - b);
  if (!fees.length) throw new Error("no native fee samples");
  const p75 = fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))];
  return p75;
}

/**
 * Current recommended priority fee (microLamports per compute unit),
 * multiplied for headroom and clamped to [FLOOR, CAP]. Cached for CACHE_TTL_MS.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.accountKeys] base58 writable accounts for a more
 *        accurate, account-specific estimate (optional).
 * @param {string} [opts.label] short tag for the log line.
 * @param {boolean} [opts.force] bypass the cache (rarely needed).
 * @param {number} [opts.floor] per-call floor override (µL/CU). Lets a cheap,
 *        frequent, retry-tolerant sender (the price attestor) pay near-zero in
 *        calm conditions while one-shot user actions keep the higher default.
 * @param {number} [opts.cap] per-call cap override (µL/CU).
 * @param {number} [opts.multiplier] per-call headroom multiplier override.
 */
export async function getDynamicPriorityFee(opts = {}) {
  const {
    accountKeys = [],
    label = "tx",
    force = false,
    floor = FLOOR,
    cap = CAP,
    multiplier = MULTIPLIER,
  } = opts;
  const now = Date.now();

  let raw = _cache.raw;
  let source = _cache.source;
  if (force || now - _cache.at >= CACHE_TTL_MS) {
    try {
      raw = await fetchHeliusEstimate(accountKeys);
      source = "helius";
    } catch {
      try {
        raw = await fetchNativeEstimate(accountKeys);
        source = "native";
      } catch {
        raw = floor;
        source = "floor";
      }
    }
    _cache = { raw, source, at: now };
  }

  const fee = Math.max(floor, Math.min(cap, Math.ceil(raw * multiplier)));
  const capped = raw * multiplier > cap;
  console.log(
    `[priority-fee] ${label}: ${fee} µL/CU (src=${source} raw=${Math.round(raw)} x${multiplier}` +
      `${capped ? " CAPPED" : ""}, floor=${floor} cap=${cap})`,
  );
  return fee;
}

/**
 * ComputeBudget instructions (price + limit) for the current dynamic fee.
 * Prepend these to any transaction. `cuLimit` bounds the fee and improves
 * scheduling; set it comfortably above the instruction's real CU usage.
 *
 * @returns {Promise<import("@solana/web3.js").TransactionInstruction[]>}
 */
export async function priorityFeeInstructions(cuLimit, opts = {}) {
  const microLamports = await getDynamicPriorityFee(opts);
  const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
  if (cuLimit && Number.isFinite(cuLimit)) {
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.ceil(cuLimit) }));
  }
  return ixs;
}

/** Exposed for tests / admin readouts. */
export const _config = { FLOOR, CAP, MULTIPLIER, CACHE_TTL_MS };
