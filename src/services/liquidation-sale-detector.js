/**
 * Sale-detection helper for the liquidation economics watcher.
 *
 * Given a (lenderWallet, collateralMint, lenderShareRaw) tuple, finds
 * a Solana tx where the lender wallet's collateral token balance went
 * DOWN by approximately lenderShareRaw and the lender's SOL balance
 * went UP. Returns the tx signature + the SOL inflow lamports.
 *
 * Why a separate module
 * ─────────────────────
 * Keeps the Helius RPC + parsing surface in one focused file. The
 * watcher imports lazily so a missing HELIUS_API_KEY does not crash
 * the watcher; the watcher logs and skips detection that tick.
 *
 * What "match" means
 * ──────────────────
 * The operator's lender wallet does a LOT of transactions. The match
 * heuristic is:
 *   - Look at the wallet's last N signatures (default 100)
 *   - For each tx, check the wallet's PRE/POST token balance for
 *     the collateral mint
 *   - If post < pre AND (pre - post) is within
 *     [lenderShareRaw * toleranceLow, lenderShareRaw * toleranceHigh],
 *     consider it a candidate
 *   - Pick the OLDEST candidate that hasn't already been claimed by
 *     another liquidation_economics row (caller deduplicates by
 *     sale_tx_sig uniqueness)
 *
 * Tolerance exists because the operator may batch / route through an
 * aggregator that splits the sale across multiple instructions, OR
 * the operator may have other collateral of the same mint and sell
 * more than strictly the seized amount.
 *
 * Limitations
 * ───────────
 *   - Ambiguous matches return null. The watcher leaves the row in
 *     'pending_sale' for operator review.
 *   - Looks at the lender wallet's SOL inflow in the same tx. If the
 *     sale was routed through a swap aggregator that distributed SOL
 *     to multiple recipients, the SOL inflow may differ from the true
 *     sale value. Operator can manually adjust the row in that case.
 *   - Does not yet rule out collateral transfers between the lender's
 *     own accounts (e.g. moving the seized token to a different wallet
 *     before selling). Phase 1 takes this as a known limitation.
 */
const HELIUS_RPC = (k) => `https://mainnet.helius-rpc.com/?api-key=${k}`;
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const DEFAULT_LIMIT = 100;
const FETCH_TIMEOUT_MS = 12_000;

async function rpc(method, params) {
  if (!HELIUS_KEY) throw new Error("HELIUS_API_KEY unset");
  const res = await fetch(HELIUS_RPC(HELIUS_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Helius ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Helius ${method} error: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Pull the lender wallet's recent signatures + decode each one for
 * token-balance deltas on the target mint. Returns an array of
 * candidate matches sorted oldest-first.
 */
async function scanCandidates({ lenderWallet, collateralMint, limit = DEFAULT_LIMIT }) {
  const sigs = await rpc("getSignaturesForAddress", [
    lenderWallet,
    { limit },
  ]);
  if (!Array.isArray(sigs) || sigs.length === 0) return [];

  const candidates = [];
  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    const sig = sigInfo.signature;
    let tx;
    try {
      tx = await rpc("getTransaction", [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch {
      continue;
    }
    if (!tx) continue;
    const meta = tx.meta;
    if (!meta || meta.err) continue;

    // Token balance change for the lender wallet's account holding the
    // target mint. preTokenBalances + postTokenBalances are arrays
    // keyed by accountIndex within the tx; we want any account whose
    // owner == lenderWallet AND mint == collateralMint.
    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    let preAmt = null;
    let postAmt = null;
    for (const t of pre) {
      if (t.mint === collateralMint && t.owner === lenderWallet) {
        preAmt = BigInt(t.uiTokenAmount?.amount || "0");
        break;
      }
    }
    for (const t of post) {
      if (t.mint === collateralMint && t.owner === lenderWallet) {
        postAmt = BigInt(t.uiTokenAmount?.amount || "0");
        break;
      }
    }
    if (preAmt == null && postAmt == null) continue;
    if (preAmt == null) preAmt = 0n;
    if (postAmt == null) postAmt = 0n;
    if (postAmt >= preAmt) continue; // not an outflow
    const tokenOutflow = preAmt - postAmt;

    // SOL delta on the lender wallet's main account. accountKeys order
    // in `tx.transaction.message.accountKeys` matches pre/postBalances.
    const accs = tx.transaction?.message?.accountKeys || [];
    let solDelta = 0n;
    for (let i = 0; i < accs.length; i++) {
      const pk = typeof accs[i] === "string" ? accs[i] : accs[i]?.pubkey;
      if (pk === lenderWallet) {
        const preLamports = BigInt(meta.preBalances[i] ?? 0);
        const postLamports = BigInt(meta.postBalances[i] ?? 0);
        solDelta = postLamports - preLamports;
        break;
      }
    }

    candidates.push({
      txSig: sig,
      blockTime: sigInfo.blockTime || tx.blockTime || null,
      tokenOutflow,
      solDeltaLamports: solDelta,
    });
  }
  // Oldest first so the caller can assign the earliest match.
  candidates.sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));
  return candidates;
}

/**
 * Find a sale tx matching the given liquidation row. Returns the
 * matching candidate's tx sig + SOL inflow, or null when no candidate
 * passes the tolerance window.
 *
 * Side-effect-free; the caller is responsible for persisting the match
 * via the UPDATE with WHERE sale_tx_sig IS NULL race guard.
 */
export async function findSaleForLiquidation({
  lenderWallet,
  collateralMint,
  lenderShareRaw,
  toleranceLow = 0.80,
  toleranceHigh = 1.20,
  limit = DEFAULT_LIMIT,
}) {
  if (!HELIUS_KEY) return null;
  const target = BigInt(lenderShareRaw);
  if (target === 0n) return null;
  const candidates = await scanCandidates({ lenderWallet, collateralMint, limit });
  for (const c of candidates) {
    // Must have positive SOL inflow (this is supposed to be a sale).
    if (c.solDeltaLamports <= 0n) continue;
    const ratio = Number(c.tokenOutflow) / Number(target);
    if (ratio < toleranceLow || ratio > toleranceHigh) continue;
    return {
      txSig: c.txSig,
      solInflowLamports: c.solDeltaLamports.toString(),
      blockTime: c.blockTime,
      tokenOutflowRaw: c.tokenOutflow.toString(),
      matchRatio: ratio,
    };
  }
  return null;
}
