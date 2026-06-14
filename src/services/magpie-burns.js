/**
 * $MAGPIE burn ledger — single source of truth.
 *
 * Reads + writes to the magpie_burns table. Every user-facing surface
 * (TG /stats, magpie.capital/stats, site dashboard, Pip) MUST source
 * its "total burned" figure through getBurnSummary so the displays
 * stay perfectly in sync.
 *
 * $MAGPIE is Token-2022 with 6 decimals. Raw values in the table
 * are base units (1 token = 1_000_000 raw).
 */
import { query } from "../db/pool.js";

export const MAGPIE_DECIMALS = 6;
const MAGPIE_RAW_DIVISOR = 10n ** BigInt(MAGPIE_DECIMALS);

/**
 * Convert a raw BigInt amount to a human-readable token count string
 * (e.g. "2,000,000.000000"). Uses fixed 6 decimals to match $MAGPIE's
 * precision; the UI can trim trailing zeros.
 */
export function rawToHumanString(amountRaw) {
  const v = BigInt(amountRaw);
  const whole = v / MAGPIE_RAW_DIVISOR;
  const frac = v % MAGPIE_RAW_DIVISOR;
  const fracStr = frac.toString().padStart(MAGPIE_DECIMALS, "0");
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
}

/**
 * Convert raw BigInt to a token-count Number for display. Loses
 * precision beyond ~15 digits — fine for /stats where we round, but
 * call sites that need exact strings should use rawToHumanString.
 */
export function rawToTokenNumber(amountRaw) {
  return Number(BigInt(amountRaw)) / Number(MAGPIE_RAW_DIVISOR);
}

/**
 * Total $MAGPIE burned across all sources, as a raw BigInt.
 */
export async function getTotalBurnedRaw() {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount_raw), 0)::text AS total FROM magpie_burns`,
  );
  return BigInt(rows[0].total);
}

/**
 * Burn summary for display: total + per-source breakdown + most recent.
 *
 * Returned shape (intentionally JSON-friendly — strings for bigints):
 *   {
 *     total_raw: "2000000000000",
 *     total_tokens: "2,000,000.000000",
 *     by_source: { manual: "2000000000000", liquidation_default: "0", buyback: "0" },
 *     by_source_tokens: { manual: "2,000,000.000000", ... },
 *     burn_count: 1,
 *     most_recent: { source, amount_raw, burn_tx_sig, burned_at } | null
 *   }
 */
export async function getBurnSummary() {
  const totals = await query(
    `SELECT source, COUNT(*)::int AS n, SUM(amount_raw)::text AS amt
       FROM magpie_burns
      GROUP BY source`,
  );
  const bySource = { manual: "0", liquidation_default: "0", buyback: "0" };
  let count = 0;
  let totalRaw = 0n;
  for (const r of totals.rows) {
    bySource[r.source] = r.amt;
    count += r.n;
    totalRaw += BigInt(r.amt);
  }
  const recent = await query(
    `SELECT source, amount_raw::text AS amount_raw, burn_tx_sig, related_loan_id, burned_at
       FROM magpie_burns
      ORDER BY burned_at DESC
      LIMIT 1`,
  );
  return {
    total_raw: totalRaw.toString(),
    total_tokens: rawToHumanString(totalRaw),
    by_source: bySource,
    by_source_tokens: Object.fromEntries(
      Object.entries(bySource).map(([k, v]) => [k, rawToHumanString(v)]),
    ),
    burn_count: count,
    most_recent: recent.rows[0]
      ? {
          source: recent.rows[0].source,
          amount_raw: recent.rows[0].amount_raw,
          amount_tokens: rawToHumanString(recent.rows[0].amount_raw),
          burn_tx_sig: recent.rows[0].burn_tx_sig,
          related_loan_id: recent.rows[0].related_loan_id,
          burned_at: recent.rows[0].burned_at,
        }
      : null,
  };
}

/**
 * Record a single burn. Idempotent via burn_tx_sig UNIQUE — re-calling
 * with the same signature is a no-op.
 *
 * Returns the inserted row id, or null if the burn was already recorded
 * under this tx signature.
 */
export async function recordBurn({ amountRaw, source, relatedLoanId, burnTxSig, notes, burnedAt }) {
  const amt = BigInt(amountRaw);
  if (amt <= 0n) throw new Error("amountRaw must be positive");
  if (!["manual", "liquidation_default", "buyback"].includes(source)) {
    throw new Error(`invalid source: ${source}`);
  }
  try {
    const { rows } = await query(
      `INSERT INTO magpie_burns (amount_raw, source, related_loan_id, burn_tx_sig, notes, burned_at)
       VALUES ($1::numeric, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (burn_tx_sig) DO NOTHING
       RETURNING id`,
      [amt.toString(), source, relatedLoanId || null, burnTxSig || null, notes || null, burnedAt || null],
    );
    if (rows.length === 0) return null;
    return rows[0].id;
  } catch (err) {
    console.error("[magpie-burns] recordBurn failed:", err.message);
    throw err;
  }
}
