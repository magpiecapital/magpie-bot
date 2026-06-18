/**
 * Liquidation collateral auto-sweeper.
 *
 * Layer 5 of the 2026-06-18 cosign-borrow exploit defense doctrine.
 * After a memecoin liquidation lands tokens in the lender wallet, this
 * service immediately swaps them to SOL via Jupiter so the wallet doesn't
 * hold drain-bait. Shrinks the "wallet holds tokens" attack window from
 * hours (manual operator sale) to ~60 seconds.
 *
 * Defense doctrine recap:
 *   - Layer 1: cosign-borrow Gate 0b — per-ix discriminator source check
 *   - Layer 2: cosign-borrow pre-flight balance-delta simulation
 *   - Layer 3: COSIGN_BORROW_DISABLED env kill switch
 *   - Layer 4: self-monitor probeLenderWalletBalance — alert on decrease
 *   - Layer 5: THIS service — auto-sweep proceeds to SOL
 *
 * Layers 1+2+4 already block the exploit class. Layer 5 minimizes the
 * surface so even a future unknown gate bypass has nothing to drain.
 *
 * Eligibility (operator-mandated 2026-06-18 PM):
 *   - distribution_status = 'pending_sale'
 *   - row age > 60s (let any liquidation-cascade dust settle)
 *   - collateral_mint.category = 'memecoin' only
 *     - RWA: thin Jupiter liquidity, swap risk too high
 *     - MAGPIE: goes to magpie_burn_pending, separate flow
 *     - Token-2022 ScaledUiAmount (SPCX et al): unreliable routing
 *   - auto_sweep_attempts < MAX_ATTEMPTS (default 2)
 *
 * Attempt strategy:
 *   - Attempt 1: 5% slippage (matches V4 fire convention)
 *   - Attempt 2: 10% slippage (emergency widen)
 *   - After max attempts: leave row in pending_sale + flag
 *     auto_sweep_failed_at + crit-alert; operator sells manually
 *
 * Safety:
 *   - Advisory DB lock so multiple bot instances can't double-sweep
 *   - Pre-flight simulate before broadcast (refuse anything RPC rejects)
 *   - Audit-trail: every attempt updates auto_sweep_attempts +
 *     auto_sweep_last_attempt_at + auto_sweep_last_error
 *   - Kill switch: LIQ_COLLATERAL_SWEEP_DISABLED=true halts the loop
 *
 * Env knobs:
 *   | Env                                | Default          | Notes |
 *   |------------------------------------|------------------|-------|
 *   | LIQ_COLLATERAL_SWEEP_DISABLED      | (unset)          | Kill switch |
 *   | LIQ_COLLATERAL_SWEEP_INTERVAL_MS   | 90000 (90s)      | Tick cadence |
 *   | LIQ_COLLATERAL_SWEEP_FIRST_RUN_MS  | 120000 (2min)    | Delay after boot |
 *   | LIQ_COLLATERAL_SWEEP_DELAY_SEC     | 60               | Min row age before eligible |
 *   | LIQ_COLLATERAL_SWEEP_MAX_ATTEMPTS  | 2                | Then flag for operator |
 *   | LIQ_COLLATERAL_SWEEP_SLIPPAGE_BPS  | 500,1000         | Comma list of slippage bps per attempt |
 *   | LIQ_COLLATERAL_SWEEP_BATCH_LIMIT   | 5                | Rows processed per tick |
 *   | JUPITER_QUOTE_API                  | lite-api.jup.ag  | Quote endpoint |
 *   | JUPITER_SWAP_API                   | lite-api.jup.ag  | Swap-build endpoint |
 *
 * Refs:
 *   - feedback_cosign_borrow_token_drain_exploit_2026_06_18
 *   - feedback_world_class_engineering_standard
 *   - feedback_no_breakage_to_existing_users
 */
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import bs58 from "bs58";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";

// ─── Constants ────────────────────────────────────────────────────
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
const ADVISORY_LOCK_KEY = 89_771_618_618_730n;

const SCALED_UI_AMOUNT_MINTS = new Set([
  // SPCX and other Token-2022 mints with the ScaledUiAmount extension.
  // Jupiter's routing for these is unreliable and the on-chain price
  // semantics are special-cased throughout the protocol.
  "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
]);

const MAGPIE_MINT = process.env.MAGPIE_MINT || "8qsB76aedTbi2nDdmscSXM1NMkJgDqJrTGsmFP1Tpump";

// ─── Config ───────────────────────────────────────────────────────
const DISABLED = /^(1|true|yes|on)$/i.test(
  process.env.LIQ_COLLATERAL_SWEEP_DISABLED || "",
);
const TICK_MS = Number(process.env.LIQ_COLLATERAL_SWEEP_INTERVAL_MS) || 90_000;
const FIRST_RUN_MS =
  Number(process.env.LIQ_COLLATERAL_SWEEP_FIRST_RUN_MS) || 120_000;
const DELAY_SEC = Number(process.env.LIQ_COLLATERAL_SWEEP_DELAY_SEC) || 60;
const MAX_ATTEMPTS =
  Number(process.env.LIQ_COLLATERAL_SWEEP_MAX_ATTEMPTS) || 2;
const SLIPPAGE_BPS_PROGRESSION = (
  process.env.LIQ_COLLATERAL_SWEEP_SLIPPAGE_BPS || "500,1000"
)
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const BATCH_LIMIT =
  Number(process.env.LIQ_COLLATERAL_SWEEP_BATCH_LIMIT) || 5;
const JUPITER_QUOTE_API =
  process.env.JUPITER_QUOTE_API || "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_API = (
  process.env.JUPITER_SWAP_API || "https://lite-api.jup.ag/swap/v1/swap"
);

// ─── Lender keypair load ──────────────────────────────────────────
let _lenderKp = null;
function loadLenderKeypair() {
  if (_lenderKp) return _lenderKp;
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    _lenderKp = Keypair.fromSecretKey(decode(b58));
    return _lenderKp;
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "[liq-collateral-sweeper] LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set",
    );
  }
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  _lenderKp = Keypair.fromSecretKey(new Uint8Array(raw));
  return _lenderKp;
}

// ─── Helpers ──────────────────────────────────────────────────────
async function getJupiterQuote({ inputMint, outputMint, amount, slippageBps }) {
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`quote HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  const json = await res.json();
  if (!json?.outAmount) throw new Error("quote missing outAmount");
  return json;
}

async function getJupiterSwapTx({ quoteResponse, userPublicKey }) {
  const res = await fetch(JUPITER_SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // High priority for liquidation collateral sales — we want this
      // to land quickly so the wallet stops holding the token.
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 5_000_000, priorityLevel: "high" } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`swap-build HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  const json = await res.json();
  if (!json?.swapTransaction) throw new Error("swap response missing swapTransaction");
  return json.swapTransaction;
}

async function acquireAdvisoryLock() {
  try {
    const { rows } = await query(
      `SELECT pg_try_advisory_lock($1) AS got`,
      [ADVISORY_LOCK_KEY.toString()],
    );
    return rows[0]?.got === true;
  } catch (err) {
    console.warn(`[liq-collateral-sweeper] advisory lock error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

// ─── Tick ─────────────────────────────────────────────────────────
async function sweepOneRow(row, lender, bot) {
  const ctx = `liq#${row.id} mint=${(row.collateral_mint || "").slice(0, 8)}…`;

  // Pick slippage based on which attempt this is.
  const attemptIdx = Math.min(
    row.auto_sweep_attempts,
    SLIPPAGE_BPS_PROGRESSION.length - 1,
  );
  const slippageBps =
    SLIPPAGE_BPS_PROGRESSION[attemptIdx] ?? SLIPPAGE_BPS_PROGRESSION[0];

  let lastError = null;
  try {
    // Step 1 — quote
    const quote = await getJupiterQuote({
      inputMint: row.collateral_mint,
      outputMint: SOL_MINT,
      amount: row.lender_share_raw,
      slippageBps,
    });
    const expectedSolLamports = Number(quote.outAmount);
    const expectedMinLamports = Number(quote.otherAmountThreshold);
    console.log(
      `[liq-collateral-sweeper] ${ctx} quote @${slippageBps}bps: in=${row.lender_share_raw}, out=${expectedSolLamports} (min ${expectedMinLamports})`,
    );

    // Step 2 — build swap tx
    const swapTxBase64 = await getJupiterSwapTx({
      quoteResponse: quote,
      userPublicKey: lender.publicKey.toBase58(),
    });
    const swapTxBytes = Buffer.from(swapTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBytes);

    // Step 3 — sign
    tx.sign([lender]);

    // Step 4 — pre-flight simulate (refuse anything the RPC rejects)
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "confirmed",
    });
    if (sim.value.err) {
      throw new Error(
        `pre-flight sim rejected: ${JSON.stringify(sim.value.err).slice(0, 120)} logs=${(sim.value.logs || []).slice(-3).join(" | ").slice(0, 200)}`,
      );
    }

    // Step 5 — send + confirm
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    console.log(`[liq-collateral-sweeper] ${ctx} broadcast sig=${sig}`);
    const confirmed = await connection.confirmTransaction(sig, "confirmed");
    if (confirmed.value.err) {
      throw new Error(
        `confirmation err: ${JSON.stringify(confirmed.value.err).slice(0, 120)}`,
      );
    }

    // Step 6 — flip row to awaiting_distribution with the sale recorded.
    // Use the minimum-out as the conservative proceeds figure; the
    // sale-detector path computes from actual chain receipts later.
    // (sale_detected_at signals to the existing flow that this row is
    // ready for distribution-watcher.)
    const upd = await query(
      `UPDATE liquidation_economics
          SET sale_tx_sig = $2,
              sale_proceeds_lamports = $3,
              sale_detected_at = NOW(),
              distribution_status = 'awaiting_distribution',
              auto_sweep_attempts = auto_sweep_attempts + 1,
              auto_sweep_last_attempt_at = NOW(),
              auto_sweep_last_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND distribution_status = 'pending_sale'`,
      [row.id, sig, expectedMinLamports],
    );
    if (upd.rowCount === 0) {
      console.warn(
        `[liq-collateral-sweeper] ${ctx} row state changed under us — sweep landed but row update was a no-op`,
      );
    } else {
      console.log(
        `[liq-collateral-sweeper] ${ctx} SWEPT in 1 tx — ${(expectedMinLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL min received`,
      );
    }
    return { ok: true };
  } catch (err) {
    lastError = err.message?.slice(0, 250) || "unknown";
    console.warn(
      `[liq-collateral-sweeper] ${ctx} attempt ${row.auto_sweep_attempts + 1}/${MAX_ATTEMPTS} FAILED @${slippageBps}bps: ${lastError}`,
    );
  }

  // Failure path — bump attempts + record error. If at cap, flag for
  // operator review and crit-alert.
  const newAttempts = row.auto_sweep_attempts + 1;
  const reachedCap = newAttempts >= MAX_ATTEMPTS;
  await query(
    `UPDATE liquidation_economics
        SET auto_sweep_attempts = $2,
            auto_sweep_last_attempt_at = NOW(),
            auto_sweep_last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [row.id, newAttempts, lastError],
  );
  if (reachedCap && bot) {
    // Use the same admin-notify path the other crit alerts use.
    try {
      const { notifyAdmin } = await import("./admin-notify.js");
      await notifyAdmin(
        bot,
        `[liq-collateral-sweeper] CRIT row #${row.id} (${row.collateral_symbol || row.collateral_mint?.slice(0, 8)}) reached ${MAX_ATTEMPTS} failed auto-sweep attempts. Last error: ${lastError}. Sell manually via your normal flow; row stays in pending_sale.`,
      );
    } catch (notifyErr) {
      console.warn(
        `[liq-collateral-sweeper] crit-alert failed: ${notifyErr.message?.slice(0, 100)}`,
      );
    }
  }
  return { ok: false, error: lastError };
}

async function tick(bot) {
  if (DISABLED) return;

  let lender;
  try {
    lender = loadLenderKeypair();
  } catch (err) {
    console.warn(
      `[liq-collateral-sweeper] cannot load lender keypair, skipping tick: ${err.message?.slice(0, 100)}`,
    );
    return;
  }

  const gotLock = await acquireAdvisoryLock();
  if (!gotLock) {
    // Another instance is sweeping; that's fine.
    return;
  }

  try {
    const eligibleMints = await getEligibleMints();
    if (eligibleMints.size === 0) return;

    const { rows } = await query(
      `SELECT id, loan_id, collateral_mint, collateral_symbol,
              lender_share_raw, auto_sweep_attempts, created_at
         FROM liquidation_economics
        WHERE distribution_status = 'pending_sale'
          AND created_at < NOW() - make_interval(secs => $1)
          AND auto_sweep_attempts < $2
          AND collateral_mint = ANY($3::text[])
        ORDER BY created_at ASC
        LIMIT $4`,
      [DELAY_SEC, MAX_ATTEMPTS, Array.from(eligibleMints), BATCH_LIMIT],
    );
    if (rows.length === 0) return;

    console.log(
      `[liq-collateral-sweeper] tick: ${rows.length} eligible row(s) ready to sweep`,
    );
    for (const row of rows) {
      await sweepOneRow(row, lender, bot);
    }
  } finally {
    try {
      await query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY.toString()]);
    } catch {
      /* lock auto-releases on session end */
    }
  }
}

async function getEligibleMints() {
  // Memecoin category only. Exclude MAGPIE (separate burn flow) and
  // ScaledUiAmount mints (unreliable Jupiter routing).
  const { rows } = await query(
    `SELECT mint FROM supported_mints WHERE enabled = TRUE AND category = 'memecoin'`,
  );
  const eligible = new Set();
  for (const r of rows) {
    if (r.mint === MAGPIE_MINT) continue;
    if (SCALED_UI_AMOUNT_MINTS.has(r.mint)) continue;
    eligible.add(r.mint);
  }
  return eligible;
}

// ─── Lifecycle ────────────────────────────────────────────────────
let _timer = null;
export function startLiquidationCollateralSweeper(bot) {
  if (_timer) return;
  if (DISABLED) {
    console.log("[liq-collateral-sweeper] disabled via LIQ_COLLATERAL_SWEEP_DISABLED");
    return;
  }
  console.log(
    `[liq-collateral-sweeper] armed — first run in ${Math.round(FIRST_RUN_MS / 1000)}s, then every ${Math.round(TICK_MS / 1000)}s (delay=${DELAY_SEC}s, attempts=${MAX_ATTEMPTS}, slippage=${SLIPPAGE_BPS_PROGRESSION.join(",")}bps)`,
  );
  setTimeout(() => {
    tick(bot).catch((e) =>
      console.warn(`[liq-collateral-sweeper] first run failed: ${e.message?.slice(0, 120)}`),
    );
    _timer = setInterval(() => {
      tick(bot).catch((e) =>
        console.warn(`[liq-collateral-sweeper] tick failed: ${e.message?.slice(0, 120)}`),
      );
    }, TICK_MS);
  }, FIRST_RUN_MS);
}
export function stopLiquidationCollateralSweeper() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
