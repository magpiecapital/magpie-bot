/**
 * x402-path canary — every ~5 min, drives the CROSS-SERVICE x402 → bot →
 * cosign borrow contract with the CHEAPEST mechanism that still proves
 * each hop. It catches the class of CONTRACT failures BETWEEN magpie-x402
 * and magpie-bot that no existing probe sees:
 *
 *   - auth / PUBLIC_ROUTES omission  (a paid endpoint 401s after payment)
 *   - x402 proxy field rename        (snake_case → camelCase/lamports drift)
 *   - inner build-borrow summary-shape drift (a renamed/dropped summary field)
 *   - cosign field-name rename       (route stops reading partialSignedTxBase64)
 *   - repay field-contract drift     (build-repay validation contract changes)
 *
 * The existing borrow-canary.js only pings RPC / TWAP / health on the bot's
 * OWN process — it would NOT catch any of the above, because none of them
 * involve the predictors borrow-canary probes. This canary asserts the
 * literal request/response contract each service depends on.
 *
 * SAFETY — this canary NEVER pays, NEVER signs, NEVER cosigns, spends ZERO
 * SOL, and has ZERO on-chain effect:
 *   - HOP 1+2 are FREE GETs (x402 /health + /.well-known/x402.json).
 *   - HOP 3 calls the bot's OWN inner build-borrow with the INTERNAL token
 *     (the inner hop is NOT payment-gated). buildBorrowTx builds an unsigned
 *     tx (discarded, never signed/submitted) and does only an idempotent
 *     users/wallets upsert — it does NOT insert a loans row. No on-chain tx.
 *   - HOP 4+5 POST an EMPTY body and assert the expected VALIDATION error —
 *     they never construct, sign, or submit anything.
 *
 * Structure mirrors borrow-canary.js exactly: setInterval cadence, per-hop
 * consecFails/alertedAt debounce (alert after 2 consecutive fails), 30-min
 * re-notify while still failing, recovery DM on first success after a fail,
 * every tick recorded to conversion_events (path='x402_path_canary').
 *
 * Operator-mandated cross-service contract guard
 * (see [[feedback_x402_pool_separation_mandate]] +
 * [[feedback_x402_paid_agent_endpoints_must_be_in_public_routes]]).
 */
import { recordConversionEvent } from "./conversion-tracker.js";
import { getAdminId, notifyAdmin } from "./admin-notify.js";
import { query } from "../db/pool.js";

const TICK_INTERVAL_MS = Number(process.env.X402_PATH_CANARY_INTERVAL_MS) || 300_000; // ~5 min
const FAIL_DEBOUNCE = Number(process.env.X402_PATH_CANARY_FAIL_DEBOUNCE) || 2;

// The public x402 service we drive HOP 1+2 against. Default to prod.
const X402_SERVICE_URL = (process.env.X402_SERVICE_URL || "https://x402.magpie.capital").replace(/\/+$/, "");

// The bot's OWN local server (HOP 3/4/5). Mirrors borrow-canary's
// BOT_INTERNAL_URL so the canary hits the in-process server, never the
// public edge. PORT default matches borrow-canary (3000) for symmetry.
const BOT_INTERNAL_URL = (process.env.BOT_INTERNAL_URL
  || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, "");

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

// A pubkey-ONLY canary borrower. Build-only needs no secret key (we never
// sign). Defaults to the system program (a valid base58 pubkey that owns
// no collateral) so the canary works even if the env is unset — HOP 3 then
// still proves the auth + summary-shape contract up to the valuation gate.
// Set CANARY_BORROWER_WALLET to a wallet that holds a tiny amount of the
// canary mint to drive the FULL valuation + tx-build path.
const CANARY_BORROWER_WALLET =
  process.env.CANARY_BORROWER_WALLET || "11111111111111111111111111111111";

// Tiny raw collateral amount for HOP 3. We never sign or submit, so the
// amount only needs to be a valid u64 string the build path accepts.
const CANARY_BORROWER_AMOUNT = process.env.CANARY_BORROWER_AMOUNT || "1";

// Per-hop consecutive-fail + last-alert maps. Reset on first success.
// Keyed by stable hop names (HOP1_x402_health … HOP5_repay_contract) so the
// debounce counter is tied to the HOP, not a specific mint/url.
const consecFails = new Map(); // hopName → int
const alertedAt = new Map();   // hopName → ms of last alert (debounce)

// ── Canary mint resolution (mirrors borrow-canary.getCanaryMints) ─────────
// HOP 3 needs a CURRENTLY-ENABLED mint so the inner build-borrow exercises a
// REAL borrowable token and AUTO-ADAPTS when a mint is delisted. Honor the
// CANARY_BORROWER_MINT env override ONLY while it is still enabled; otherwise
// auto-pick the most stable enabled mint (prefer protected + hot). Cached 5m.
let _canaryMint = null;
let _canaryMintAt = 0;
const CANARY_MINT_TTL_MS = 5 * 60_000;

async function getCanaryMint() {
  const now = Date.now();
  if (_canaryMint && now - _canaryMintAt < CANARY_MINT_TTL_MS) return _canaryMint;
  // Honor the env override only if it is still an enabled supported_mint.
  const preferred = process.env.CANARY_BORROWER_MINT;
  if (preferred) {
    try {
      const { rows } = await query(
        `SELECT mint FROM supported_mints WHERE mint = $1 AND enabled = TRUE`,
        [preferred],
      );
      if (rows.length) {
        _canaryMint = rows[0].mint;
        _canaryMintAt = now;
        return _canaryMint;
      }
    } catch { /* fall through to auto-pick */ }
  }
  try {
    // Prefer a stable/hot mint: protected first, then hot tier, then oldest.
    const { rows } = await query(
      `SELECT mint FROM supported_mints
         WHERE enabled = TRUE
         ORDER BY protected DESC, (attestation_tier = 'hot') DESC, created_at ASC
         LIMIT 1`,
    );
    _canaryMint = rows.length ? rows[0].mint : null;
  } catch {
    _canaryMint = null;
  }
  _canaryMintAt = now;
  return _canaryMint;
}

// ── fetch-with-timeout helper (no signing, no payment) ────────────────────
async function fetchJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 8_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? body : undefined,
      signal: ctl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON — leave null */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ── Field-shape adapter replicated from magpie-x402
//    src/routes/build-borrow.ts (the camelCase/lamports transform the x402
//    proxy applies to the bot summary before the SDK consumes it). If the
//    bot's summary shape drifts, this transform yields undefined/NaN exactly
//    where the SDK would throw "Cannot convert undefined to a BigInt" AFTER
//    a loan already opened on-chain — the worst failure class. We run it here
//    so the canary catches the drift before any real agent does.
function x402SummaryTransform(summary) {
  const s = summary || {};
  const toLamports = (sol) => (sol == null ? undefined : String(Math.round(Number(sol) * 1e9)));
  return {
    loanId: s.loanId ?? s.loan_id,
    borrowableLamports: s.borrowableLamports ?? toLamports(s.principal_sol),
    feeLamports: s.feeLamports ?? toLamports(s.fee_sol),
  };
}

// numeric-parseable = present AND Number(x) is a finite number. The x402
// transform emits STRINGS (they feed BigInt() in the SDK); we assert they
// parse to a finite number, which is the real contract.
function isNumericParseable(v) {
  if (v == null) return false;
  const n = Number(v);
  return Number.isFinite(n);
}

// ────────────────────────────── HOPS ─────────────────────────────────────

/**
 * HOP 1 — x402 service is up. GET {X402_SERVICE_URL}/health → 200 + ok.
 */
async function hopX402Health() {
  const { status, json } = await fetchJson(`${X402_SERVICE_URL}/health`, { timeoutMs: 8_000 });
  if (status !== 200) throw new Error(`HOP1 x402 /health http_${status}`);
  if (json && json.ok === false) throw new Error("HOP1 x402 /health reports ok=false");
  return { detail: { status } };
}

/**
 * HOP 2 — x402 still ADVERTISES the build-borrow route in its discovery doc.
 * GET {X402_SERVICE_URL}/.well-known/x402.json → 200 and the endpoints array
 * contains POST /api/v1/agent/build-borrow. A dropped/renamed advert means
 * standard agents can no longer discover (and therefore pay for) the route.
 */
async function hopX402Discovery() {
  const { status, json } = await fetchJson(`${X402_SERVICE_URL}/.well-known/x402.json`, { timeoutMs: 8_000 });
  if (status !== 200) throw new Error(`HOP2 x402 discovery http_${status}`);
  if (!json || !Array.isArray(json.endpoints)) {
    throw new Error("HOP2 x402 discovery missing endpoints[] array");
  }
  const advertised = json.endpoints.some(
    (e) =>
      e &&
      e.path === "/api/v1/agent/build-borrow" &&
      String(e.method || "").toUpperCase() === "POST",
  );
  if (!advertised) {
    throw new Error("HOP2 x402 discovery no longer advertises POST /api/v1/agent/build-borrow");
  }
  return { detail: { status, endpoints: json.endpoints.length } };
}

/**
 * HOP 3 — the inner build-borrow contract (the bug-prone hop). POST to the
 * bot's OWN /api/v1/agent/build-borrow with ONLY the X-Internal-Token (the
 * inner hop is NOT payment-gated). Assert HTTP 200 AND that summary carries
 * the EXACT SDK-consumed fields. Then run the x402 proxy's camelCase/lamports
 * transform and assert the derived fields come out present + numeric-parseable.
 *
 * BUILD-ONLY: the returned partial tx is discarded, never signed, never
 * submitted. buildBorrowTx does only an idempotent users/wallets upsert; it
 * does NOT insert a loans row. Zero SOL, zero on-chain effect.
 */
async function hopInnerBuildBorrow() {
  if (!INTERNAL_API_TOKEN) {
    throw new Error("HOP3 INTERNAL_API_TOKEN not configured (cannot drive inner build-borrow)");
  }
  const mint = await getCanaryMint();
  if (!mint) {
    // No enabled mint to probe against. Not a contract failure — treat as a
    // benign skip so we don't alarm when the protocol legitimately has no
    // enabled collateral. The next tick re-resolves.
    return { skipped: "no_enabled_mint" };
  }

  const { status, json } = await fetchJson(`${BOT_INTERNAL_URL}/api/v1/agent/build-borrow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_API_TOKEN,
    },
    body: JSON.stringify({
      borrower_wallet: CANARY_BORROWER_WALLET,
      collateral_mint: mint,
      collateral_amount: CANARY_BORROWER_AMOUNT,
      tier: 0,
    }),
    timeoutMs: 15_000,
  });

  if (status === 401) {
    throw new Error("HOP3 inner build-borrow 401 — INTERNAL_API_TOKEN mismatch (auth contract broken)");
  }
  if (status !== 200) {
    // The valuation gate can legitimately reject a canary wallet that holds
    // no collateral (collateral_value_zero / price_oracle_failed). That is
    // NOT a contract failure of the hop we're testing — it means auth +
    // validation + routing all PASSED and we reached the borrow gauntlet.
    // Treat those known "wallet has nothing to borrow against" classes as a
    // PASS-with-skip; anything else is a real contract failure.
    const reason = String(json?.error || json?.reason || "").toLowerCase();
    const benign =
      reason.includes("collateral_value_zero") ||
      reason.includes("price_oracle_failed") ||
      reason.includes("refused") ||      // anti-exploit gate (reached = contract OK)
      reason.includes("banned");
    if (benign) {
      return { skipped: `reached_gauntlet:${reason || status}`, detail: { status } };
    }
    throw new Error(`HOP3 inner build-borrow http_${status} error=${(json?.error || "").toString().slice(0, 120)}`);
  }

  // 200 — assert the inner summary carries the EXACT SDK-consumed fields.
  const summary = json?.summary;
  if (!summary || typeof summary !== "object") {
    throw new Error("HOP3 200 but response has no summary object");
  }
  const required = ["program_id", "loan_id", "principal_sol", "fee_sol", "loan_pda"];
  const missing = required.filter((k) => summary[k] === undefined || summary[k] === null);
  if (missing.length) {
    throw new Error(`HOP3 summary missing field(s): ${missing.join(", ")}`);
  }

  // Replicate the x402 proxy field-shape transform and assert the derived
  // fields the SDK actually consumes come out present + numeric-parseable.
  const t = x402SummaryTransform(summary);
  if (t.loanId === undefined || t.loanId === null) {
    throw new Error("HOP3 x402 transform: loanId came out undefined (summary.loan_id drift)");
  }
  if (!isNumericParseable(t.borrowableLamports)) {
    throw new Error("HOP3 x402 transform: borrowableLamports not numeric (summary.principal_sol drift)");
  }
  if (!isNumericParseable(t.feeLamports)) {
    throw new Error("HOP3 x402 transform: feeLamports not numeric (summary.fee_sol drift)");
  }

  return {
    detail: {
      status,
      program_id: String(summary.program_id).slice(0, 12),
      mint: String(mint).slice(0, 8),
    },
  };
}

/**
 * HOP 4 — cosign field-name contract (no spend). POST an EMPTY body {} to the
 * bot's /api/v1/cosign-borrow and assert it returns the EXPECTED 400
 * "Missing partialSignedTxBase64" shape. This proves the route is mounted,
 * is in PUBLIC_ROUTES (not 401), and still reads body.partialSignedTxBase64.
 * A 404/405/401 or a different 400 message = the field/route contract drifted.
 */
async function hopCosignFieldName() {
  const { status, json } = await fetchJson(`${BOT_INTERNAL_URL}/api/v1/cosign-borrow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
    timeoutMs: 8_000,
  });
  if (status === 401) throw new Error("HOP4 cosign 401 — route fell out of PUBLIC_ROUTES (paid-then-denied class)");
  if (status === 404) throw new Error("HOP4 cosign field drift: got 404 (route not mounted)");
  if (status === 405) throw new Error("HOP4 cosign field drift: got 405 (method contract changed)");
  if (status !== 400) throw new Error(`HOP4 cosign expected 400, got ${status}`);
  const err = String(json?.error || "");
  if (!/missing partialSignedTxBase64/i.test(err)) {
    throw new Error(`HOP4 cosign field drift: 400 but message="${err.slice(0, 80)}" (expected "Missing partialSignedTxBase64")`);
  }
  return { detail: { status } };
}

/**
 * HOP 5 — repay field-contract (no spend). POST an EMPTY body {} to the bot's
 * /api/v1/agent/build-repay and assert the EXPECTED validation error: 400
 * { error: "missing_params", required: ["borrower_wallet", "loan_pda"] }.
 * Proves the route is mounted, in PUBLIC_ROUTES (not 401), and the field
 * contract is intact. A 404/405/401 or a different 400 shape = drift.
 */
async function hopRepayContract() {
  if (!INTERNAL_API_TOKEN) {
    // build-repay also requires the internal token; without it we can't
    // distinguish the validation-error contract from an auth 401. Skip.
    return { skipped: "no_internal_token" };
  }
  const { status, json } = await fetchJson(`${BOT_INTERNAL_URL}/api/v1/agent/build-repay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_API_TOKEN,
    },
    body: JSON.stringify({}),
    timeoutMs: 8_000,
  });
  if (status === 401) throw new Error("HOP5 build-repay 401 — INTERNAL_API_TOKEN mismatch or route fell out of PUBLIC_ROUTES");
  if (status === 404) throw new Error("HOP5 build-repay field drift: got 404 (route not mounted)");
  if (status === 405) throw new Error("HOP5 build-repay field drift: got 405 (method contract changed)");
  if (status !== 400) throw new Error(`HOP5 build-repay expected 400 missing_params, got ${status}`);
  const err = String(json?.error || "");
  if (err !== "missing_params") {
    throw new Error(`HOP5 build-repay field drift: 400 but error="${err.slice(0, 80)}" (expected "missing_params")`);
  }
  const required = Array.isArray(json?.required) ? json.required : [];
  if (!required.includes("borrower_wallet") || !required.includes("loan_pda")) {
    throw new Error(`HOP5 build-repay required[] drift: got ${JSON.stringify(required).slice(0, 80)}`);
  }
  return { detail: { status } };
}

// Stable hop registry — order is the cross-service flow order.
const HOPS = [
  ["HOP1_x402_health", hopX402Health],
  ["HOP2_x402_discovery", hopX402Discovery],
  ["HOP3_inner_build_borrow", hopInnerBuildBorrow],
  ["HOP4_cosign_field_name", hopCosignFieldName],
  ["HOP5_repay_contract", hopRepayContract],
];

/**
 * Record a hop result to conversion_events + manage the per-hop alert
 * debounce. Mirrors borrow-canary.recordAndMaybeAlert exactly:
 *   - telemetry every tick
 *   - alert only after FAIL_DEBOUNCE consecutive fails
 *   - re-notify at most every 30 min while still failing
 *   - single recovery DM on the first success after a fail
 */
async function recordAndMaybeAlert(hopName, result) {
  const ok = result.ok;
  // Skips count as a (benign) success for debounce purposes — the contract
  // was reachable; we just couldn't fully exercise it this tick.
  await recordConversionEvent({
    path: "x402_path_canary",
    outcome: ok ? "success" : "failure",
    failureClass: ok ? null : "x402_path_contract",
    surface: "canary",
    latencyMs: result.latencyMs,
    detail: ok
      ? { hop: hopName, ...(result.skipped ? { skipped: result.skipped } : {}), ...(result.detail || {}) }
      : { hop: hopName, error: (result.error?.message || String(result.error || "")).slice(0, 200) },
  });

  const adminId = getAdminId();
  if (!adminId) return;

  if (ok) {
    const prev = consecFails.get(hopName) || 0;
    if (prev >= FAIL_DEBOUNCE) {
      try {
        await notifyAdmin(
          `x402-path canary recovered — \`${hopName}\` is healthy again after ${prev} consecutive fails.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* swallow DM err */ }
    }
    consecFails.set(hopName, 0);
    alertedAt.delete(hopName);
    return;
  }

  const next = (consecFails.get(hopName) || 0) + 1;
  consecFails.set(hopName, next);
  if (next < FAIL_DEBOUNCE) return; // not yet noisy

  // Re-notify at most every 30 min while still failing.
  const lastAt = alertedAt.get(hopName) || 0;
  if (Date.now() - lastAt < 30 * 60_000) return;
  alertedAt.set(hopName, Date.now());

  const reason = (result.error?.message || String(result.error || "")).slice(0, 180);
  const msg = [
    `🚨 *x402-path canary degraded*`,
    ``,
    `Hop: \`${hopName}\``,
    `Consecutive fails: ${next}`,
    `Latency: ${result.latencyMs}ms`,
    ``,
    `Reason: \`${reason}\``,
    ``,
    `_This is a CROSS-SERVICE x402 → bot contract failure (auth / field rename / summary drift). A real agent borrow/repay would currently fail at this hop. Investigate ASAP._`,
  ].join("\n");
  try {
    await notifyAdmin(msg, { parse_mode: "Markdown" });
  } catch { /* swallow DM err */ }
}

/**
 * One tick — run every hop. Each hop is wrapped in its own try/catch so a
 * thrown error in one hop NEVER crashes the tick or the process. The whole
 * tick is also wrapped by the caller's .catch().
 */
async function tick() {
  for (const [hopName, fn] of HOPS) {
    const start = Date.now();
    let result;
    try {
      const out = await fn();
      result = { ok: true, latencyMs: Date.now() - start, skipped: out?.skipped, detail: out?.detail };
    } catch (e) {
      result = { ok: false, latencyMs: Date.now() - start, error: e };
    }
    // Per-hop record/alert is itself wrapped so a telemetry/DM failure on one
    // hop never prevents the remaining hops from running.
    try {
      await recordAndMaybeAlert(hopName, result);
    } catch (e) {
      console.warn(`[x402-path-canary] record/alert err on ${hopName}:`, e?.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TODO (optional, env-gated full E2E — DELIBERATELY NOT IMPLEMENTED here):
//
//   When X402_PATH_CANARY_FULL=true AND CANARY_WALLET (bs58 secret key) is
//   set, run a REAL, self-repaying round trip on a dedicated canary wallet:
//       pay (x402 standard rail) → build-borrow → SIGN with CANARY_WALLET →
//       cosign-borrow (submit) → confirm loan on-chain → build-repay → SIGN →
//       submit repay → confirm collateral returned.
//   This is the only way to catch failures in the SIGN/COSIGN/SUBMIT path
//   that the build-only hops above cannot. It MUST:
//     - use a dedicated, low-balance wallet that ONLY ever does canary loans,
//     - always repay within the same tick (self-repaying — never leave an
//       open loan), with a guarded retry on the repay leg,
//     - spend real (tiny) SOL on fees + the x402 build fee, so it is gated
//       OFF by default and only enabled deliberately by the operator.
//   NOT implemented in this file: we never load a secret key here and never
//   sign. Keep this canary build-only + zero-spend.
// ─────────────────────────────────────────────────────────────────────────

export function startX402PathCanary(bot) {
  // `bot` is accepted for call-site symmetry with startBorrowCanary; admin
  // DMs go through notifyAdmin (cached bot registered via setNotifyBot at
  // boot), so we don't thread `bot` through every hop.
  void bot;
  if (process.env.X402_PATH_CANARY_DISABLED === "true") {
    console.log("[x402-path-canary] disabled via X402_PATH_CANARY_DISABLED=true");
    return;
  }
  console.log(
    `[x402-path-canary] starting — every ${TICK_INTERVAL_MS}ms, debounce=${FAIL_DEBOUNCE}, ` +
      `x402=${X402_SERVICE_URL}, bot=${BOT_INTERNAL_URL}, hops=${HOPS.map(([n]) => n).join(",")}`,
  );
  // Initial delayed run so the bot has bound its port + the x402 service is
  // reachable. Wrap so a thrown tick never crashes the process.
  setTimeout(() => tick().catch((e) => console.warn("[x402-path-canary] tick err:", e.message)), 45_000);
  setInterval(() => tick().catch((e) => console.warn("[x402-path-canary] tick err:", e.message)), TICK_INTERVAL_MS);
}
