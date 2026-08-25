/**
 * agent-surface canary — every ~15 min, verifies the PUBLIC AGENT-DISCOVERY
 * surface that Magpie's whole AI-agent strategy depends on. If any of this
 * silently breaks, agents and LLMs stop being able to FIND or READ Magpie —
 * a strategic-reputation failure that no existing probe catches:
 *
 *   - x402-path-canary guards the borrow CONTRACT (x402 → bot → cosign).
 *   - borrow-canary guards the bot's OWN RPC / TWAP / health.
 *   - NEITHER checks whether an agent can DISCOVER Magpie (the MCP registry
 *     listing) or READ it (the endpoints every MCP tool + llms.txt depend on).
 *
 * This canary asserts exactly that read-side discovery surface:
 *   R1  MCP Registry lists io.github.magpiecapital/magpie as active + latest
 *   R2  collateral catalog endpoint returns a non-empty token list
 *   R3  protocol-pulse returns live aggregates (active_loans present)
 *   R4  tiers endpoint returns the 3-tier ladder
 *   R5  pool endpoint returns live pool state (program present)
 *   R6  OpenAPI spec is served (machine integrators depend on it)
 *   R7  llms.txt is served and still advertises the MCP servers
 *
 * SAFETY — pure public HTTP GETs. NEVER pays, signs, cosigns, or touches any
 * program/on-chain surface. Zero SOL, zero side effects. Completely isolated
 * from the V4.1 source-frozen program surface.
 *
 * Structure mirrors x402-path-canary.js: per-check consecFails/alertedAt
 * debounce (alert after 2 consecutive fails), 30-min re-notify while failing,
 * recovery DM on first success, every tick recorded to conversion_events
 * (path='agent_surface_canary').
 *
 * Operator directive 2026-08-21: operate like Google/Apple/Amazon — you don't
 * ship a strategic surface without a monitor watching it.
 */
import { recordConversionEvent } from "./conversion-tracker.js";
import { getAdminId, notifyAdmin } from "./admin-notify.js";

const TICK_INTERVAL_MS = Number(process.env.AGENT_SURFACE_CANARY_INTERVAL_MS) || 900_000; // ~15 min
const FAIL_DEBOUNCE = Number(process.env.AGENT_SURFACE_CANARY_FAIL_DEBOUNCE) || 2;

const X402 = (process.env.X402_SERVICE_URL || "https://x402.magpie.capital").replace(/\/+$/, "");
const SITE = (process.env.SITE_URL || "https://www.magpie.capital").replace(/\/+$/, "");
const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.magpiecapital%2Fmagpie";
const MCP_NAME = "io.github.magpiecapital/magpie";

const consecFails = new Map();
const alertedAt = new Map();

const UA = { "User-Agent": "magpie-agent-surface-canary/1.0" };
async function getJson(url, timeoutMs = 12000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const r = await fetch(url, { headers: UA, signal: ctl });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
async function getText(url, timeoutMs = 12000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

// Each check returns { ok, latencyMs, detail? } or throws.
const CHECKS = [
  ["mcp_registry_listing", async () => {
    // registry API can be slow (7s+ observed) — generous timeout; the check
    // asserts LISTING, not their latency
    const d = await getJson(REGISTRY, 25_000);
    const mine = (d.servers || []).filter((s) => s.server?.name === MCP_NAME);
    if (!mine.length) throw new Error("magpie not found in MCP registry");
    const latest = mine.find((s) => s._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest);
    if (!latest) throw new Error("no version flagged isLatest");
    const status = latest._meta["io.modelcontextprotocol.registry/official"].status;
    if (status !== "active") throw new Error(`registry status='${status}' (expected active)`);
    return { detail: { latest_version: latest.server.version, status } };
  }],
  ["collateral_catalog", async () => {
    const d = await getJson(`${X402}/api/v1/collateral/eligible`);
    const toks = d.tokens || d.data || d;
    if (!Array.isArray(toks) || toks.length < 10) throw new Error(`catalog has ${Array.isArray(toks) ? toks.length : "non-array"} tokens`);
    return { detail: { count: toks.length } };
  }],
  ["protocol_pulse", async () => {
    const d = await getJson(`${X402}/api/v1/agent/protocol-pulse`);
    if (typeof d.active_loans !== "number") throw new Error("pulse missing active_loans");
    return { detail: { active_loans: d.active_loans } };
  }],
  ["tiers_ladder", async () => {
    const d = await getJson(`${X402}/api/v1/tiers`);
    if (!Array.isArray(d.tiers) || d.tiers.length < 3) throw new Error("tiers ladder incomplete");
    return { detail: { tiers: d.tiers.length } };
  }],
  ["pool_state", async () => {
    const d = await getJson(`${X402}/api/v1/pool`);
    if (!d.program && !d.poolPda) throw new Error("pool state missing program/poolPda");
    return { detail: { program_version: d.program_version } };
  }],
  ["openapi_spec", async () => {
    const d = await getJson(`${X402}/openapi.json`);
    if (!d.openapi && !d.paths) throw new Error("openapi.json not a valid spec");
    return { detail: { paths: d.paths ? Object.keys(d.paths).length : 0 } };
  }],
  ["llms_txt", async () => {
    const t = await getText(`${SITE}/llms.txt`);
    if (!/magpie-mcp/.test(t)) throw new Error("llms.txt no longer advertises the MCP server");
    return { detail: { bytes: t.length } };
  }],
];

async function recordAndMaybeAlert(name, result) {
  const ok = result.ok;
  try {
    await recordConversionEvent({
      path: "agent_surface_canary",
      outcome: ok ? "success" : "failure",
      failureClass: ok ? null : "agent_surface_degraded",
      surface: "canary",
      latencyMs: result.latencyMs,
      detail: ok ? { check: name, ...(result.detail || {}) } : { check: name, error: (result.error?.message || "").slice(0, 200) },
    });
  } catch { /* telemetry never blocks */ }

  const adminId = getAdminId();
  if (!adminId) return;

  if (ok) {
    const prev = consecFails.get(name) || 0;
    if (prev >= FAIL_DEBOUNCE) {
      try {
        await notifyAdmin(`agent-surface canary recovered — \`${name}\` healthy again after ${prev} consecutive fails.`, { parse_mode: "Markdown" });
      } catch { /* swallow */ }
    }
    consecFails.set(name, 0);
    alertedAt.delete(name);
    return;
  }

  const next = (consecFails.get(name) || 0) + 1;
  consecFails.set(name, next);
  if (next < FAIL_DEBOUNCE) return;

  const lastAt = alertedAt.get(name) || 0;
  if (Date.now() - lastAt < 30 * 60_000) return;
  alertedAt.set(name, Date.now());

  const reason = (result.error?.message || "").slice(0, 180);
  const msg = [
    `🚨 *agent-surface canary degraded*`,
    ``,
    `Check: \`${name}\``,
    `Consecutive fails: ${next}`,
    `Latency: ${result.latencyMs}ms`,
    ``,
    `Reason: \`${reason}\``,
    ``,
    `_An AI agent or LLM currently CANNOT reliably discover or read Magpie through this surface (MCP registry / catalog / pulse / tiers / pool / OpenAPI / llms.txt). This is the agent-adoption strategic surface — investigate ASAP._`,
  ].join("\n");
  try { await notifyAdmin(msg, { parse_mode: "Markdown" }); } catch { /* swallow */ }
}

async function tick() {
  for (const [name, fn] of CHECKS) {
    const t0 = Date.now();
    try {
      const r = await fn();
      await recordAndMaybeAlert(name, { ok: true, latencyMs: Date.now() - t0, detail: r?.detail });
    } catch (error) {
      await recordAndMaybeAlert(name, { ok: false, latencyMs: Date.now() - t0, error });
    }
  }
}

export function startAgentSurfaceCanary(bot) {
  void bot;
  if (process.env.AGENT_SURFACE_CANARY_DISABLED === "true") {
    console.log("[agent-surface-canary] disabled via env");
    return;
  }
  console.log(`[agent-surface-canary] starting — every ${TICK_INTERVAL_MS}ms, debounce=${FAIL_DEBOUNCE}, checks=${CHECKS.map(([n]) => n).join(",")}`);
  setTimeout(() => tick().catch((e) => console.warn("[agent-surface-canary] tick err:", e.message)), 60_000);
  setInterval(() => tick().catch((e) => console.warn("[agent-surface-canary] tick err:", e.message)), TICK_INTERVAL_MS);
}
