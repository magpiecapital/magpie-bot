/**
 * Infrastructure health monitor.
 *
 * Probes the four external dependencies every 5 minutes and tracks
 * rolling latency + error rates. Alerts admin only on SUSTAINED
 * degradation (3+ consecutive bad samples) so a single blip doesn't
 * page anyone.
 *
 * Probes:
 *   1. Anthropic  — HEAD against api.anthropic.com (fast, free)
 *   2. Helius     — getSlot via the configured Helius RPC
 *   3. Public RPC — getSlot against the public Solana mainnet endpoint
 *                   (the fallback path — needs to stay healthy or we
 *                   have no failover when Helius hiccups)
 *   4. DB         — SELECT 1 against the primary pool
 *
 * Status states per probe: HEALTHY / DEGRADED / DOWN
 * State transitions DM the admin (with cooldown to avoid flapping).
 *
 * Also exposed: getHealthSnapshot() for the /health admin command,
 * so admin can pull current status on demand.
 */
import { Connection } from "@solana/web3.js";
import { notifyAdmin, getAdminId } from "./admin-notify.js";
import { query } from "../db/pool.js";

const POLL_INTERVAL_MS = Number(process.env.INFRA_HEALTH_POLL_MS) || 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const STATE_TRANSITION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min — same probe won't re-alert within this window
const CONSECUTIVE_BAD_FOR_ALERT = 3; // 3 × 5min = 15 min sustained issue before paging
const CONSECUTIVE_GOOD_FOR_RECOVER = 2; // 2 × 5min = 10 min recovery before "back online"

// Probe latency thresholds (ms)
const LATENCY_DEGRADED_MS = 2_500;
const LATENCY_DOWN_MS = 9_500; // i.e. timeout

const HELIUS_URL = process.env.SOLANA_RPC_URL
  || process.env.HELIUS_RPC_URL
  || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const PUBLIC_RPC = process.env.PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

// Per-probe state machine
function newProbeState(name) {
  return {
    name,
    status: "unknown", // unknown | healthy | degraded | down
    consecutiveBad: 0,
    consecutiveGood: 0,
    lastLatencyMs: null,
    lastError: null,
    lastCheckedAt: null,
    lastAlertedStatus: null,
    lastAlertedAt: 0,
    samples: [], // ring buffer of last N latencies for trending
  };
}

const probes = {
  anthropic: newProbeState("Anthropic"),
  helius: newProbeState("Helius RPC"),
  publicRpc: newProbeState("Public RPC"),
  database: newProbeState("Database"),
};

const MAX_SAMPLES = 24; // 2h of 5-min samples

function recordSample(p, latencyMs, error) {
  p.lastLatencyMs = latencyMs;
  p.lastError = error;
  p.lastCheckedAt = Date.now();
  p.samples.push({ t: Date.now(), latencyMs, error: !!error });
  if (p.samples.length > MAX_SAMPLES) p.samples.shift();

  // Compute new status
  let newStatus;
  if (error || latencyMs >= LATENCY_DOWN_MS) {
    newStatus = "down";
  } else if (latencyMs >= LATENCY_DEGRADED_MS) {
    newStatus = "degraded";
  } else {
    newStatus = "healthy";
  }

  // Hysteresis: only transition after consecutive samples agree
  if (newStatus === "healthy") {
    p.consecutiveGood++;
    p.consecutiveBad = 0;
    if (p.consecutiveGood >= CONSECUTIVE_GOOD_FOR_RECOVER) {
      const prev = p.status;
      p.status = "healthy";
      return prev !== "healthy" && prev !== "unknown" ? { from: prev, to: "healthy" } : null;
    }
  } else {
    p.consecutiveBad++;
    p.consecutiveGood = 0;
    if (p.consecutiveBad >= CONSECUTIVE_BAD_FOR_ALERT) {
      const prev = p.status;
      p.status = newStatus;
      return prev !== newStatus ? { from: prev, to: newStatus } : null;
    }
  }
  return null; // no transition this sample
}

async function timed(promise, timeoutMs) {
  const start = Date.now();
  try {
    const result = await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    return { latencyMs: Date.now() - start, error: null, result };
  } catch (err) {
    return { latencyMs: Date.now() - start, error: err.message || String(err) };
  }
}

// ──────────────────────────── PROBES ────────────────────────────

async function probeAnthropic() {
  // HEAD on /v1/messages doesn't actually charge us — Anthropic returns
  // 405 (method not allowed) but the TCP/TLS + auth handshake exercises
  // the full real path. Auth header omitted on purpose — we just want
  // to verify the endpoint is reachable.
  return timed(
    fetch("https://api.anthropic.com/", {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }).then((r) => r.status),
    PROBE_TIMEOUT_MS,
  );
}

async function probeRpc(url) {
  const conn = new Connection(url, "confirmed");
  return timed(conn.getSlot(), PROBE_TIMEOUT_MS);
}

async function probeDb() {
  return timed(query("SELECT 1"), PROBE_TIMEOUT_MS);
}

// ──────────────────────────── TICK ────────────────────────────

function statusEmoji(s) {
  return s === "healthy" ? "🟢" : s === "degraded" ? "🟡" : s === "down" ? "🔴" : "⚪️";
}

async function tick(bot) {
  const probeFns = {
    anthropic: probeAnthropic,
    helius: () => probeRpc(HELIUS_URL),
    publicRpc: () => probeRpc(PUBLIC_RPC),
    database: probeDb,
  };

  for (const [key, fn] of Object.entries(probeFns)) {
    try {
      const { latencyMs, error } = await fn();
      const transition = recordSample(probes[key], latencyMs, error);
      if (transition) {
        await maybeAlertTransition(bot, probes[key], transition);
      }
    } catch (err) {
      // Defensive — probe itself threw outside the timed wrapper
      recordSample(probes[key], LATENCY_DOWN_MS, err.message);
    }
  }
}

async function maybeAlertTransition(bot, probe, transition) {
  if (!getAdminId() || !bot) return;

  // Public Solana RPC frequently rate-limits Railway's shared IPs with
  // 429s. The bot doesn't use the public RPC for actual operations
  // (Helius handles everything), so a public-RPC degradation is monitor
  // noise — not user impact. Log it but don't DM the operator.
  if (probe.name === "Public RPC") {
    console.log(`[infra-health] ${probe.name} ${transition.from} → ${transition.to} (log-only; not user-facing)`);
    return;
  }

  const now = Date.now();
  // Cooldown to prevent flapping
  if (probe.lastAlertedStatus === transition.to
      && now - probe.lastAlertedAt < STATE_TRANSITION_COOLDOWN_MS) {
    return;
  }
  probe.lastAlertedStatus = transition.to;
  probe.lastAlertedAt = now;

  const emoji = statusEmoji(transition.to);
  const latencyTxt = probe.lastLatencyMs != null ? `${probe.lastLatencyMs}ms` : "n/a";
  let msg;
  if (transition.to === "healthy") {
    msg = `${emoji} *${probe.name} recovered*\n\nLatency back to ${latencyTxt}. (Was ${transition.from}.)`;
  } else if (transition.to === "degraded") {
    msg = [
      `${emoji} *${probe.name} degraded*`,
      "",
      `Latency: ${latencyTxt} (slow, above ${LATENCY_DEGRADED_MS}ms for ${CONSECUTIVE_BAD_FOR_ALERT}+ samples)`,
      probe.lastError ? `Last error: \`${probe.lastError.slice(0, 200)}\`` : "",
      "",
      "Likely still working but slower than usual. Watch /health.",
    ].filter(Boolean).join("\n");
  } else if (transition.to === "down") {
    msg = [
      `${emoji} *${probe.name} appears DOWN*`,
      "",
      probe.lastError ? `Error: \`${probe.lastError.slice(0, 200)}\`` : `Latency: ${latencyTxt} (timeout)`,
      "",
      `Sustained for ${CONSECUTIVE_BAD_FOR_ALERT}+ samples (15+ min).`,
      "",
      `Check provider status:`,
      `- Anthropic: https://status.anthropic.com`,
      `- Helius:    https://status.helius.xyz`,
      `- Railway:   https://status.railway.com`,
      `- Solana:    https://status.solana.com`,
    ].join("\n");
  }
  await notifyAdmin(bot, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
}

// ──────────────────────────── PUBLIC API ────────────────────────

export function getHealthSnapshot() {
  const snapshot = {};
  for (const [key, p] of Object.entries(probes)) {
    const recent = p.samples.slice(-12); // last hour
    const recentLatencies = recent.filter((s) => !s.error).map((s) => s.latencyMs);
    const avgLatency = recentLatencies.length > 0
      ? Math.round(recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length)
      : null;
    const errorRate = recent.length > 0
      ? recent.filter((s) => s.error).length / recent.length
      : 0;
    snapshot[key] = {
      name: p.name,
      status: p.status,
      lastLatencyMs: p.lastLatencyMs,
      lastError: p.lastError,
      lastCheckedAt: p.lastCheckedAt,
      avgLatencyMs_1h: avgLatency,
      errorRate_1h: errorRate,
      sampleCount: p.samples.length,
    };
  }
  return snapshot;
}

export function startInfraHealth(bot) {
  if (!getAdminId()) {
    console.log("[infra-health] No admin ID — alerts disabled (probes still run for /health)");
  }
  console.log(`[infra-health] Starting (probes every ${POLL_INTERVAL_MS / 1000}s)`);
  // First probe 30s after boot — let other startup tasks settle
  setTimeout(() => tick(bot), 30 * 1000);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}
