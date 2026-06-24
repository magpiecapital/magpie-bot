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
import { constantTimeEqual } from "./auth-utils.js";

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
  if (!constantTimeEqual(presented, INTERNAL_API_TOKEN)) {
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
  // kind: "settled" (native SOL, default) | "reserve" (SPL rail pre-settle nonce
  // gate, tx_signature = PENDING:<nonce>) | "settled-spl" (SPL settled, real sig).
  const kind = body?.kind ? String(body.kind) : "settled";
  const isReserve = kind === "reserve";
  // asset: the SPL mint for a settled-spl record (USDC/wSOL); null for native SOL.
  const asset = body?.asset ? String(body.asset).slice(0, 64) : null;

  // Cheap validation — failed records are dropped, not retried, so we
  // don't want bad data accumulating. A reserve marker carries a PENDING:<nonce>
  // tx_signature + empty payer (the SPL rail's durable pre-settle nonce gate);
  // every other record requires a real on-chain signature + payer.
  const txOk = isReserve
    ? /^PENDING:[A-Za-z0-9_+/=:-]{8,160}$/.test(txSignature)
    : isValidTxSig(txSignature);
  const payerOk = isReserve ? payerPubkey === "" || isValidPubkey(payerPubkey) : isValidPubkey(payerPubkey);
  if (
    !endpointPath || endpointPath.length > 256 ||
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method) ||
    !/^\d+$/.test(amountLamports) ||
    !payerOk || !txOk ||
    (isReserve && !nonce)
  ) {
    return { status: 400, body: { error: "invalid_record_shape" } };
  }

  let inserted = false;
  try {
    const { rows } = await query(
      `INSERT INTO x402_paid_calls
         (endpoint_path, method, amount_lamports, payer_pubkey, tx_signature, nonce, kind, asset)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tx_signature) DO NOTHING
       RETURNING tx_signature`,
      [endpointPath, method, amountLamports, payerPubkey, txSignature, nonce, kind, asset],
    );
    inserted = rows.length > 0;
  } catch (err) {
    // DB hiccup — log and acknowledge so the x402 service doesn't retry
    // forever on a transient issue. Worst case we miss a metric, not a
    // billing record.
    console.warn("[x402-metrics] record insert failed:", err.message?.slice(0, 200));
    return { status: 200, body: { recorded: false, reason: "db_blip" } };
  }

  // $MAGPIE holder-rewards flywheel (the x402 leg). Accrue the LIVE
  // governance holder_reward_bps share of this x402 fee to the $MAGPIE
  // holder pool, idempotently keyed on the payment signature. This is what
  // makes "x402 API call fees feed $MAGPIE holder rewards" literally true —
  // every paid agent call now contributes the same governance-ratified
  // (MGP-001) share that loan fees do (10% today, auto-picks-up 70% the
  // moment governance flips holder_reward_bps; no code change needed).
  //
  // Safety: ONLY on a genuinely new row (inserted===true) so retries don't
  // re-attempt; the pool_credit_events UNIQUE(source_type,source_id,pool_kind)
  // is a hard idempotency backstop regardless. Fully isolated in try/catch —
  // an accrual hiccup must NEVER fail the payment-record ack or the agent's
  // call. Gated by X402_FEE_HOLDER_ACCRUAL (default on; set "false" to pause
  // the x402 leg without touching loan-fee accrual). Crucially the accrual
  // only credits a ledger obligation — it moves no SOL; distributions stay on
  // the existing governance/manual cadence.
  // Accrue ONLY for NATIVE-SOL settled payments (amount IS lamports). Skip
  // reserve markers AND SPL settlements (kind "settled-spl"): their amount is a
  // USDC/wSOL atomic, not lamports — accruing it as lamports would mis-credit the
  // pool. The SPL->SOL sweep credits the holder pool after converting SPL->SOL.
  if (inserted && kind === "settled" && process.env.X402_FEE_HOLDER_ACCRUAL !== "false") {
    try {
      const { accrueToHolderPool } = await import(
        "../services/magpie-holder-rewards.js"
      );
      await accrueToHolderPool(amountLamports, {
        sourceType: "x402_fee",
        sourceId: txSignature,
      });
    } catch (err) {
      console.warn(
        "[x402-metrics] holder accrual failed (non-fatal):",
        err.message?.slice(0, 200),
      );
    }
  }

  // `fresh` is the durable single-use signal for the x402 gateway: true means
  // this payment signature was claimed for the first time; false means it was
  // already spent (a cross-instance replay the in-process Map can't see). The
  // x402 middleware rejects a non-fresh claim. On the db_blip path above we
  // return no `fresh`, so the gateway fails OPEN (a transient DB blip must
  // never block a legitimately-paid call).
  return { status: 200, body: { recorded: true, fresh: inserted } };
}

/**
 * POST /api/v1/internal/x402/release
 *
 * Two-phase claim release (audit FIX 3). The x402 gateway claims a payment
 * signature in x402_paid_calls BEFORE serving (single-use enforcement). If the
 * downstream handler then fails for an INFRA reason (bot 5xx / timeout / threw),
 * the agent paid but got nothing, and the consumed claim would otherwise block
 * a retry (payment_already_consumed) — the agent loses its SOL with no recourse.
 * The gateway calls this to RELEASE the claim so the SAME payment re-drives the
 * handler within the 10-min nonce window. Idempotent: a repeat release is a
 * clean no-op.
 *
 * Reverses BOTH the single-use claim AND the holder-pool accrual that
 * handleX402Record made (the call was never delivered, so it must not earn
 * holder rewards), each keyed on the signature so it's exact. Accrual is
 * reversed FIRST so a partial failure can never leave a double-accrual on retry.
 * Internal-token gated — only the gateway (which made the claim) calls it.
 */
export async function handleX402Release(req) {
  if (!INTERNAL_API_TOKEN) {
    return { status: 503, body: { error: "service_not_configured" } };
  }
  const presented = req.headers["x-internal-token"];
  if (!constantTimeEqual(presented, INTERNAL_API_TOKEN)) {
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
  const txSignature = String(body?.tx_signature ?? "");
  if (!isValidTxSig(txSignature)) {
    return { status: 400, body: { error: "invalid_signature" } };
  }

  // 1. Reverse the holder-pool accrual (if any) — atomic delete-credit +
  //    decrement-pool in ONE statement so a retry is a clean no-op and the pool
  //    can never drift from the ledger. Mirrors the accrual's idempotency.
  let accrualReversed = false;
  try {
    const { rows } = await query(
      `WITH del AS (
         DELETE FROM pool_credit_events
          WHERE source_type = 'x402_fee' AND source_id = $1 AND pool_kind = 'holder'
         RETURNING lamports
       )
       UPDATE magpie_holder_pool
          SET accrued_lamports = accrued_lamports - COALESCE((SELECT lamports FROM del), 0),
              updated_at = NOW()
        WHERE id = 1 AND EXISTS (SELECT 1 FROM del)
       RETURNING accrued_lamports`,
      [txSignature],
    );
    accrualReversed = rows.length > 0;
  } catch (err) {
    console.warn("[x402-metrics] release accrual-reversal failed:", err.message?.slice(0, 200));
  }

  // 2. Un-claim the signature so the agent can retry the same payment.
  let released = false;
  try {
    const { rows } = await query(
      `DELETE FROM x402_paid_calls WHERE tx_signature = $1 RETURNING tx_signature`,
      [txSignature],
    );
    released = rows.length > 0;
  } catch (err) {
    console.warn("[x402-metrics] release claim-delete failed:", err.message?.slice(0, 200));
    return { status: 500, body: { error: "release_failed" } };
  }

  return { status: 200, body: { released, accrual_reversed: accrualReversed } };
}

/**
 * GET /api/v1/public/x402-metrics
 *
 * Free, public, cached upstream. Returns 24h-window aggregates for the
 * x402 marketing surface — counts + revenue + unique payers + per-
 * endpoint breakdown. No PII; payer wallets only surface in the
 * anonymized "top recipients" form via the existing leaderboard route.
 */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export async function handleX402Metrics() {
  // kind <> 'reserve' excludes pre-settle nonce gates (not real calls). Lamport
  // revenue sums are FILTERED to kind = 'settled' (native SOL) — an SPL
  // settled-spl amount is a USDC/wSOL atomic, NOT lamports, so summing it as
  // lamports would corrupt the SOL revenue figure. SPL volume is reported
  // separately per asset (in its own atomic units).
  const { rows: [agg] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE kind <> 'reserve')::int AS calls_24h,
      COUNT(*) FILTER (WHERE kind <> 'reserve' AND recorded_at > NOW() - INTERVAL '1 hour')::int AS calls_1h,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled'), 0)::text AS revenue_24h_lamports,
      COUNT(*) FILTER (WHERE kind = 'settled-spl')::int AS spl_calls_24h,
      COUNT(*) FILTER (WHERE kind = 'settled-spl' AND asset = $1)::int AS usdc_calls_24h,
      COUNT(*) FILTER (WHERE kind = 'settled-spl' AND asset = $2)::int AS wsol_calls_24h,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled-spl' AND asset = $1), 0)::text AS usdc_atomic_24h,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled-spl' AND asset = $2), 0)::text AS wsol_lamports_24h,
      COUNT(DISTINCT payer_pubkey) FILTER (WHERE kind <> 'reserve' AND payer_pubkey <> '')::int AS unique_payers_24h
    FROM x402_paid_calls
    WHERE recorded_at > NOW() - INTERVAL '24 hours'
  `, [USDC_MINT, WSOL_MINT]);

  const { rows: [w] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE kind <> 'reserve')::int AS calls_7d,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled'), 0)::text AS revenue_7d_lamports,
      MAX(recorded_at) FILTER (WHERE kind = 'settled-spl') AS last_spl_at
    FROM x402_paid_calls
    WHERE recorded_at > NOW() - INTERVAL '7 days'
  `);

  const { rows: topEndpoints } = await query(`
    SELECT
      endpoint_path,
      COUNT(*) FILTER (WHERE kind <> 'reserve')::int AS calls,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled'), 0)::text AS revenue_lamports
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
      calls_7d: w.calls_7d,
      revenue_24h_sol: Number(agg.revenue_24h_lamports) / 1e9,
      revenue_7d_sol: Number(w.revenue_7d_lamports) / 1e9,
      unique_payers_24h: agg.unique_payers_24h,
      // Standard SPL rail (USDC/wSOL) — reported in native atomic units (USDC 6dp,
      // wSOL 9dp), NEVER folded into the SOL revenue above.
      standard_rail: {
        spl_calls_24h: agg.spl_calls_24h,
        usdc_calls_24h: agg.usdc_calls_24h,
        usdc_24h: Number(agg.usdc_atomic_24h) / 1e6,
        wsol_calls_24h: agg.wsol_calls_24h,
        wsol_sol_24h: Number(agg.wsol_lamports_24h) / 1e9,
        last_settlement_at: w.last_spl_at || null,
      },
      top_endpoints: topEndpoints.map((r) => ({
        path: r.endpoint_path,
        calls: r.calls,
        revenue_sol: Number(r.revenue_lamports) / 1e9,
      })),
      generated_at: new Date().toISOString(),
    },
  };
}
