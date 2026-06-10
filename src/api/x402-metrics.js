/**
 * x402 paid-call recording + metrics readout.
 *
 * The x402 service fires a non-blocking POST to /api/v1/internal/x402/record
 * after every successful payment verification. We insert one row per paid
 * call. Failures are silent (a missed metric is not a billing/correctness
 * issue — the on-chain SOL transfer is the source of truth).
 *
 * The public read endpoint aggregates 24h state for the /x402 marketing
 * page widget + any third-party trackers that want to display Magpie's
 * agent-revenue numbers.
 */
import { query } from "../db/pool.js";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function isValidPubkey(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function isValidTxSig(s) {
  // Solana tx signatures are 64 bytes encoded as base58 = ~88 chars.
  return typeof s === "string" && s.length >= 64 && s.length <= 100 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/**
 * POST /api/v1/internal/x402/record
 *
 * Auth: X-Internal-Token must match INTERNAL_API_TOKEN.
 *
 * Body: { endpoint_path, method, amount_lamports, payer_pubkey,
 *         tx_signature, nonce }
 *
 * Idempotent on tx_signature via UNIQUE constraint — a retry from the
 * x402 service after a transient DB blip won't double-count.
 */
export async function handleX402Record(req) {
  if (!INTERNAL_API_TOKEN) {
    return {
      status: 503,
      body: { error: "service_not_configured" },
    };
  }
  const presented = req.headers["x-internal-token"];
  if (presented !== INTERNAL_API_TOKEN) {
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }

  let body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const endpointPath = String(body?.endpoint_path ?? "");
  const method = String(body?.method ?? "");
  const amountLamports = String(body?.amount_lamports ?? "");
  const payerPubkey = String(body?.payer_pubkey ?? "");
  const txSignature = String(body?.tx_signature ?? "");
  const nonce = body?.nonce ? String(body.nonce) : null;

  // Cheap validation — failed records are dropped, not retried, so we
  // don't want bad data accumulating.
  if (
    !endpointPath || endpointPath.length > 256 ||
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method) ||
    !/^\d+$/.test(amountLamports) ||
    !isValidPubkey(payerPubkey) ||
    !isValidTxSig(txSignature)
  ) {
    return { status: 400, body: { error: "invalid_record_shape" } };
  }

  try {
    await query(
      `INSERT INTO x402_paid_calls
         (endpoint_path, method, amount_lamports, payer_pubkey, tx_signature, nonce)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_signature) DO NOTHING`,
      [endpointPath, method, amountLamports, payerPubkey, txSignature, nonce],
    );
  } catch (err) {
    // DB hiccup — log and acknowledge so the x402 service doesn't retry
    // forever on a transient issue. Worst case we miss a metric, not a
    // billing record.
    console.warn("[x402-metrics] record insert failed:", err.message?.slice(0, 200));
    return { status: 200, body: { recorded: false, reason: "db_blip" } };
  }
  return { status: 200, body: { recorded: true } };
}

/**
 * GET /api/v1/public/x402-metrics
 *
 * Free, public, cached upstream. Returns 24h-window aggregates for the
 * x402 marketing surface — counts + revenue + unique payers + per-
 * endpoint breakdown. No PII; payer wallets only surface in the
 * anonymized "top recipients" form via the existing leaderboard route.
 */
export async function handleX402Metrics() {
  const { rows: [agg] } = await query(`
    SELECT
      COUNT(*)::int AS calls_24h,
      COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '1 hour')::int AS calls_1h,
      COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '7 days')::int AS calls_7d,
      COALESCE(SUM(amount_lamports::numeric), 0)::text AS revenue_24h_lamports,
      COALESCE(SUM(amount_lamports::numeric) FILTER
                 (WHERE recorded_at > NOW() - INTERVAL '7 days'), 0)::text
        AS revenue_7d_lamports,
      COUNT(DISTINCT payer_pubkey)::int AS unique_payers_24h
    FROM x402_paid_calls
    WHERE recorded_at > NOW() - INTERVAL '24 hours'
  `);

  const { rows: topEndpoints } = await query(`
    SELECT
      endpoint_path,
      COUNT(*)::int AS calls,
      COALESCE(SUM(amount_lamports::numeric), 0)::text AS revenue_lamports
    FROM x402_paid_calls
    WHERE recorded_at > NOW() - INTERVAL '24 hours'
    GROUP BY endpoint_path
    ORDER BY calls DESC
    LIMIT 10
  `);

  return {
    status: 200,
    body: {
      window: "24h",
      calls_1h: agg.calls_1h,
      calls_24h: agg.calls_24h,
      calls_7d: agg.calls_7d,
      revenue_24h_sol: Number(agg.revenue_24h_lamports) / 1e9,
      revenue_7d_sol: Number(agg.revenue_7d_lamports) / 1e9,
      unique_payers_24h: agg.unique_payers_24h,
      top_endpoints: topEndpoints.map((r) => ({
        path: r.endpoint_path,
        calls: r.calls,
        revenue_sol: Number(r.revenue_lamports) / 1e9,
      })),
      generated_at: new Date().toISOString(),
    },
  };
}
