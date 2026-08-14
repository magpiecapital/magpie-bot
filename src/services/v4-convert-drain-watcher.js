/**
 * V4 convert_collateral_slice drain watcher — INTERIM detection for the
 * unpatched CRITICAL from the 2026-07-08 audit (fix ships as V4.x at a new
 * program id, pending Sec3). Read-only: ZERO protocol-functionality impact.
 *
 * The bug: convert_collateral_slice moves a collateral slice to an
 * engine-owned ATA, the swap is 100% caller-assembled, and the only
 * post-check is sol_received >= min_sol_out with min_sol_out ALSO
 * engine-supplied — it never verifies the collateral was consumed. A
 * compromised ENGINE_AUTHORITY (min_sol_out=0 + no-op swap) drains 100%
 * of a V4 borrower's collateral. Exploit precondition = engine-key
 * compromise, so an early-warning alarm is the right interim defense.
 *
 * Detection (pricing-free, robust): for every convert_collateral_slice tx
 * we compare token-balance deltas from the tx meta —
 *   - collateral actually LEFT the collateral_vault (slice removed), AND
 *   - the sol_proceeds_vault received ~NOTHING back  (drain: no real swap),
 *     OR the engine_collateral_account RETAINED the slice (parked, not swapped).
 * A legitimate conversion always returns real SOL and nets the engine ATA
 * to ~0. Either anomaly → immediate operator page + one alert per signature.
 *
 * No emojis per Magpie copy rules.
 */
import { connection, backupConnections, withFailover } from "../solana/connection.js";
import { notifyAdmin } from "./admin-notify.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
const b58decode = bs58.decode || (bs58.default && bs58.default.decode);

// Fetch a jsonParsed transaction via RAW JSON-RPC (with endpoint failover).
// web3.js Connection.getTransaction({encoding:"jsonParsed"}) THROWS on real
// txs ("accountKeys.0 expected a string, received object") — its response
// validator rejects the parsed shape — which would silently blind this
// watcher. Raw RPC returns string account keys / base58 ix data, exactly what
// analyzeConvertTx expects. Validated 2026-07-18 against real V4 conversions.
const _rpcUrls = [connection.rpcEndpoint, ...backupConnections.map((c) => c.rpcEndpoint)]
  .filter((u, i, a) => u && a.indexOf(u) === i);
async function getParsedTxRaw(sig) {
  for (const url of _rpcUrls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }],
        }),
      });
      const j = await res.json();
      if (j && j.result) return j.result;
    } catch { /* try next endpoint */ }
  }
  return null;
}

const V4_PROGRAM_ID = process.env.PROGRAM_ID_V4 || "HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo";
const WATCH_INTERVAL_MS = Number(process.env.V4_CONVERT_DRAIN_INTERVAL_MS) || 3 * 60_000;
const SCAN_LIMIT = Number(process.env.V4_CONVERT_DRAIN_SCAN_LIMIT) || 25;
// SOL the proceeds vault must have gained for a real conversion; below this
// (while collateral left the vault) = drain. 0.001 SOL — any real swap clears it.
const MIN_PROCEEDS_LAMPORTS = Number(process.env.V4_CONVERT_MIN_PROCEEDS_LAMPORTS) || 1_000_000;
const DUST = 1; // token base units — "moved" threshold
const WSOL = "So11111111111111111111111111111111111111112";
// convert_collateral_slice discriminator (Anchor sha256("global:convert_collateral_slice")[..8])
const CONVERT_DISC = [253, 2, 10, 59, 245, 38, 24, 72];

let _timer = null;
let _lastSig = null;            // cursor: newest signature already scanned
let _lastTickAt = null;         // liveness: epoch ms of the last completed scan
let _lastScanSigs = 0;          // sigs seen in the last scan
let _alertsTotal = 0;           // drain alerts paged this process
let _lastError = null;          // last scan error message (for /health)
const _alerted = new Set();     // signatures already paged on (bounded)

function rememberAlerted(sig) {
  _alerted.add(sig);
  if (_alerted.size > 500) _alerted.delete(_alerted.values().next().value);
}

/** base-unit token amount for a given account index from a pre/post list. */
function tokenAmountAt(list, accountIndex) {
  const e = (list || []).find((b) => b.accountIndex === accountIndex);
  return e ? BigInt(e.uiTokenAmount.amount) : null;
}

/** Analyze one parsed tx; return an anomaly reason string, or null if clean. */
function analyzeConvertTx(tx) {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!msg || !meta || meta.err) return null; // failed txs didn't move funds
  const keys = (msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  // locate the convert_collateral_slice instruction (top-level)
  const ix = (msg.instructions || []).find((i) => {
    const pid = i.programId ?? keys[i.programIdIndex];
    if (pid !== V4_PROGRAM_ID) return false;
    if (typeof i.data !== "string") return false;
    let bytes;
    // jsonParsed encodes an unparsed instruction's data as base58.
    try { bytes = [...b58decode(i.data)]; } catch { return false; }
    return CONVERT_DISC.every((b, n) => bytes[n] === b);
  });
  if (!ix) return null;
  // account order (IDL): 0 loan, 1 collateral_mint, 2 collateral_vault,
  // 3 sol_proceeds_vault, 4 engine_collateral_account, ...
  const ixAccts = ix.accounts || [];
  const collateralVault = ixAccts[2];
  const solProceedsVault = ixAccts[3];
  const engineAta = ixAccts[4];
  const idxOf = (pk) => keys.indexOf(pk);
  const vIdx = idxOf(collateralVault), pIdx = idxOf(solProceedsVault), eIdx = idxOf(engineAta);

  const pre = meta.preTokenBalances, post = meta.postTokenBalances;
  // collateral removed from the vault (positive = slice left)
  const vPre = tokenAmountAt(pre, vIdx), vPost = tokenAmountAt(post, vIdx);
  const collateralLeft = (vPre != null && vPost != null) ? vPre - vPost : 0n;
  // engine ATA net collateral change (positive = retained/parked)
  const ePre = tokenAmountAt(pre, eIdx) ?? 0n, ePost = tokenAmountAt(post, eIdx) ?? 0n;
  const engineRetained = ePost - ePre;
  // SOL proceeds gained (wSOL token balance OR native lamports of the proceeds acct)
  const proceedsWsolGain = (tokenAmountAt(post, pIdx) ?? 0n) - (tokenAmountAt(pre, pIdx) ?? 0n);
  const nativeGain = pIdx >= 0 ? BigInt(meta.postBalances[pIdx] - meta.preBalances[pIdx]) : 0n;
  const proceedsGain = proceedsWsolGain > nativeGain ? proceedsWsolGain : nativeGain;

  if (collateralLeft <= BigInt(DUST)) return null; // no slice actually moved → not a conversion of value

  if (engineRetained > BigInt(DUST)) {
    return `collateral slice moved to the engine ATA and was NOT swapped out (engine retained ${engineRetained} base units) — collateral parked, not converted`;
  }
  if (proceedsGain < BigInt(MIN_PROCEEDS_LAMPORTS)) {
    return `collateral left the vault (${collateralLeft} base units) but the SOL-proceeds vault gained only ${proceedsGain} lamports (< ${MIN_PROCEEDS_LAMPORTS}) — no real swap value returned`;
  }
  return null;
}

async function scanOnce(bot) {
  _lastTickAt = Date.now(); // liveness: the interval fired and a scan is running
  const program = new PublicKey(V4_PROGRAM_ID);
  const sigs = await withFailover((c) =>
    c.getSignaturesForAddress(program, { limit: SCAN_LIMIT, ...(_lastSig ? { until: _lastSig } : {}) }),
  ).catch((e) => { _lastError = `getSignatures: ${e.message?.slice(0, 80)}`; return null; });
  if (!Array.isArray(sigs)) return;
  _lastScanSigs = sigs.length; _lastError = null;
  if (sigs.length === 0) return;
  // newest first → advance cursor to the newest we saw this pass
  const newest = sigs[0]?.signature;
  // process oldest→newest so alerts read chronologically
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    if (_alerted.has(s.signature)) continue;
    const tx = await getParsedTxRaw(s.signature).catch(() => null);
    if (!tx) continue;
    let reason = null;
    try { reason = analyzeConvertTx(tx); } catch (e) { console.warn(`[v4-drain] analyze failed ${s.signature.slice(0, 12)}: ${e.message?.slice(0, 120)}`); continue; }
    if (reason) {
      rememberAlerted(s.signature);
      _alertsTotal++;
      console.error(`[v4-drain] ANOMALY ${s.signature}: ${reason}`);
      try {
        await notifyAdmin(
          bot,
          "V4 CONVERT-SLICE DRAIN ALERT (unpatched critical)\n" +
          `tx: https://solscan.io/tx/${s.signature}\n` +
          `reason: ${reason}\n` +
          "Action: verify the ENGINE_AUTHORITY key is not compromised and pause the engine if needed. This is the audit's #1 critical; the on-chain fix ships as V4.x pending Sec3.",
        );
      } catch (e) { console.warn(`[v4-drain] notifyAdmin failed: ${e.message?.slice(0, 120)}`); }
    }
  }
  if (newest) _lastSig = newest;
}

export function startV4ConvertDrainWatcher(bot) {
  if (_timer) return;
  const tick = () => scanOnce(bot).catch((e) => console.warn(`[v4-drain] tick error: ${e.message?.slice(0, 160)}`));
  // index.js already staggers this call ~190s after boot — scan right away
  // (no second delay) so the security monitor isn't blind for ~5 min per deploy.
  tick();
  _timer = setInterval(tick, WATCH_INTERVAL_MS);
  console.log(`[v4-drain] convert-slice drain watcher armed — scanning now, then every ${WATCH_INTERVAL_MS / 1000}s`);
}

/** Liveness for /api/v1/health — so a silently-dead security monitor is visible. */
export function getV4ConvertDrainWatcherHealth() {
  if (_timer == null && _lastTickAt == null) return { state: "not_started" };
  const ageMs = _lastTickAt != null ? Date.now() - _lastTickAt : null;
  // stale if we've missed ~3 intervals (never let this flip the bot's own status)
  const stale = ageMs == null || ageMs > 3 * WATCH_INTERVAL_MS;
  return {
    state: _lastTickAt == null ? "starting" : (stale ? "stale" : "ok"),
    last_tick_at: _lastTickAt != null ? new Date(_lastTickAt).toISOString() : null,
    age_ms: ageMs,
    last_scan_sigs: _lastScanSigs,
    alerts_total: _alertsTotal,
    ...(_lastError ? { last_error: _lastError } : {}),
  };
}
