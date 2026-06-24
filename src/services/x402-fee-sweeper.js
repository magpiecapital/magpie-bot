/**
 * x402 USDC fee sweeper.
 *
 * Routes accrued x402 API call fees paid in USDC into the same
 * holder-rewards economics as borrow fees. The standard x402 v2 rail
 * accepts USDC or wSOL; wSOL lands in the lender's canonical wSOL ATA
 * (the borrow fee_wallet) and is already swept to the distribution
 * wallet by fee-wallet-sweeper.js. USDC lands in the lender's USDC ATA,
 * which NO other sweeper touches — without this it sits stranded and
 * never reaches $MAGPIE holders. This closes that leg.
 *
 * Every tick (default 1h):
 *   1. Reconcile any prior swap that confirmed but didn't finish
 *      accruing/transferring (crash-safety).
 *   2. Read the lender's USDC ATA balance.
 *   3. If >= MIN, write a 'planned' audit row, then Jupiter-swap
 *      USDC -> SOL (pre-flight simulated, refuse on sim reject).
 *   4. Credit the holder pool's governance share of the realized SOL
 *      via accrueToHolderPool — idempotent at the DB level on the swap
 *      signature (pool_credit_events UNIQUE).
 *   5. Transfer the realized SOL to the distribution wallet so the
 *      distributor balance backs the new holder accrual.
 *   6. Mark the audit row confirmed + DM the operator.
 *
 * Design mirrors treasury-sweeper.js / fee-wallet-sweeper.js: world-class
 * standard (pre-flight sim), idempotent pool credit (P0 rule), audit
 * trail, env kill switch, advisory lock. Disabled by default until
 * X402_FEE_SWEEP_ENABLED is set — ship-safe.
 *
 * Refs:
 *   - feedback_pool_credits_must_be_idempotent_at_db_level
 *   - feedback_world_class_engineering_standard
 *   - MARKETING.md ("x402 fees feed the same holder-rewards economics")
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "node:fs";
import bs58 from "bs58";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { getAdminId } from "./admin-notify.js";
import { accrueToHolderPool } from "./magpie-holder-rewards.js";

// ─── Constants ────────────────────────────────────────────────────
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_DECIMALS = 6;
const LENDER_PUBKEY = new PublicKey("4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");
const DISTRIBUTION_WALLET = new PublicKey("CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac");
const LAMPORTS_PER_SOL = 1_000_000_000;
const ADVISORY_LOCK_KEY = 73_004_022_990_402n;

const JUPITER_QUOTE_API =
  process.env.JUPITER_QUOTE_API || "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_API =
  process.env.JUPITER_SWAP_API || "https://lite-api.jup.ag/swap/v1/swap";

// ─── Config ───────────────────────────────────────────────────────
function envNumber(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isDisabled() {
  // Kill switch always wins.
  const killV = (process.env.X402_FEE_SWEEP_DISABLED || "").toLowerCase();
  if (killV === "1" || killV === "true" || killV === "yes") return true;
  // ENABLED by operator decision 2026-06-24 — x402 USDC fees now auto-convert
  // to SOL and accrue to $MAGPIE holders. Previously gated behind
  // X402_FEE_SWEEP_ENABLED (ship-safe off); the operator turned it on, so the
  // default is now ON. Risk is bounded by: the 1-USDC threshold (won't act on
  // dust), pre-flight sim on every swap, idempotent holder accrual, and the
  // kill switch above. X402_FEE_SWEEP_ENABLED is kept as a no-op for back-compat.
  return false;
}

const INTERVAL_MS = envNumber("X402_FEE_SWEEP_INTERVAL_MS", 60 * 60 * 1000); // 1h
const FIRST_RUN_MS = envNumber("X402_FEE_SWEEP_FIRST_RUN_MS", 8 * 60 * 1000); // 8min after boot
// Minimum USDC (atomic, 6 decimals) before a swap is worth the fee +
// slippage. Default 1 USDC.
const MIN_USDC_ATOMIC = envNumber("X402_FEE_SWEEP_MIN_USDC_ATOMIC", 1_000_000);
const SLIPPAGE_BPS = envNumber("X402_FEE_SWEEP_SLIPPAGE_BPS", 100); // 1%

// ─── Lender keypair (env-first, no CWD fallback) ──────────────────
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
      "x402-fee-sweeper: LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set",
    );
  }
  _lenderKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
  return _lenderKp;
}

// ─── Jupiter (mirrors liquidation-collateral-sweeper) ─────────────
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
      wrapAndUnwrapSol: true, // output native SOL to the lender
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "medium" },
      },
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

// ─── Audit ────────────────────────────────────────────────────────
async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS x402_fee_sweeps (
      id            BIGSERIAL PRIMARY KEY,
      status        TEXT NOT NULL,
      usdc_atomic   NUMERIC NOT NULL DEFAULT 0,
      sol_lamports  NUMERIC NOT NULL DEFAULT 0,
      holder_lamports NUMERIC NOT NULL DEFAULT 0,
      swap_sig      TEXT,
      transfer_sig  TEXT,
      accrued       BOOLEAN NOT NULL DEFAULT FALSE,
      error_message TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function alertOperator(bot, text) {
  try {
    const adminId = getAdminId();
    if (!adminId || !bot) return;
    await bot.api.sendMessage(adminId, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.warn("[x402-fee-sweeper] alert send failed:", err.message);
  }
}

async function tryAdvisoryLock() {
  try {
    const { rows } = await query(`SELECT pg_try_advisory_lock($1::bigint) AS got`, [
      String(ADVISORY_LOCK_KEY),
    ]);
    return rows[0]?.got === true;
  } catch {
    return false;
  }
}
async function releaseAdvisoryLock() {
  try {
    await query(`SELECT pg_advisory_unlock($1::bigint)`, [String(ADVISORY_LOCK_KEY)]);
  } catch { /* best-effort */ }
}

async function getUsdcBalanceAtomic() {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, LENDER_PUBKEY, false);
  const info = await connection.getParsedAccountInfo(ata);
  const amt = info.value?.data?.parsed?.info?.tokenAmount?.amount;
  return amt ? BigInt(amt) : 0n;
}

// Credit the holder share + transfer realized SOL to the distributor.
// Idempotent: accrueToHolderPool is keyed on the swap sig; the transfer
// is gated on the audit row not already having a transfer_sig.
async function finalizeSweep(rowId, swapSig, solLamports, lender, bot, usdcAtomic) {
  // 1. Holder accrual (idempotent on swap sig)
  const holder = await accrueToHolderPool(BigInt(solLamports), {
    sourceType: "x402_usdc_sweep",
    sourceId: swapSig,
  });
  const holderLamports = holder ? Number(holder) : 0;
  if (holder) {
    // First (non-idempotent-skip) accrual — record the credited amount.
    await query(`UPDATE x402_fee_sweeps SET accrued = TRUE, holder_lamports = $2, updated_at = NOW() WHERE id = $1`, [
      rowId,
      String(holderLamports),
    ]);
  } else {
    // Idempotent re-run (reconcile) — credit already applied; don't clobber
    // the recorded holder_lamports with 0.
    await query(`UPDATE x402_fee_sweeps SET accrued = TRUE, updated_at = NOW() WHERE id = $1`, [rowId]);
  }

  // 2. Transfer realized SOL to the distribution wallet so it backs the
  //    accrual. Keep a small buffer for the network fee.
  const transferLamports = Math.max(0, Number(solLamports) - 10_000);
  let transferSig = null;
  if (transferLamports > 0) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: lender.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({
        fromPubkey: lender.publicKey,
        toPubkey: DISTRIBUTION_WALLET,
        lamports: transferLamports,
      }),
    );
    tx.sign(lender);
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      throw new Error(`transfer sim rejected: ${JSON.stringify(sim.value.err).slice(0, 120)}`);
    }
    transferSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: transferSig, blockhash, lastValidBlockHeight }, "confirmed");
  }

  await query(
    `UPDATE x402_fee_sweeps SET status = 'confirmed', transfer_sig = $2, updated_at = NOW() WHERE id = $1`,
    [rowId, transferSig],
  );

  await alertOperator(
    bot,
    `🪙 *x402 USDC fee sweep*\n\n` +
      `Swapped \`${(Number(usdcAtomic) / 10 ** USDC_DECIMALS).toFixed(4)}\` USDC → \`${(Number(solLamports) / LAMPORTS_PER_SOL).toFixed(4)}\` SOL.\n` +
      `• Holder pool credited: \`${(holderLamports / LAMPORTS_PER_SOL).toFixed(4)}\` SOL (governance share)\n` +
      `• Sent to distributor: \`${(transferLamports / LAMPORTS_PER_SOL).toFixed(4)}\` SOL\n` +
      `• Swap: \`${swapSig}\`${transferSig ? `\n• Transfer: \`${transferSig}\`` : ""}`,
  );
}

// ─── Tick ─────────────────────────────────────────────────────────
async function tickInner(bot) {
  const lender = loadLenderKeypair();

  // 0. Reconcile any swap that confirmed but didn't finish accruing
  //    (crash between swap and accrual). accrueToHolderPool is idempotent
  //    so re-running is safe.
  const { rows: pending } = await query(
    `SELECT id, swap_sig, sol_lamports, usdc_atomic FROM x402_fee_sweeps
       WHERE status = 'swapped' AND swap_sig IS NOT NULL ORDER BY id ASC LIMIT 5`,
  );
  for (const p of pending) {
    try {
      console.log(`[x402-fee-sweeper] reconciling pending sweep #${p.id} (${p.swap_sig?.slice(0, 10)}…)`);
      await finalizeSweep(p.id, p.swap_sig, Number(p.sol_lamports), lender, bot, BigInt(p.usdc_atomic || 0));
    } catch (err) {
      console.warn(`[x402-fee-sweeper] reconcile #${p.id} failed: ${err.message?.slice(0, 120)}`);
    }
  }

  // 1. Check USDC balance
  const usdc = await getUsdcBalanceAtomic();
  if (usdc < BigInt(MIN_USDC_ATOMIC)) {
    return; // nothing material to sweep
  }

  // 2. Plan (audit anchor before any irreversible action)
  const { rows: planRows } = await query(
    `INSERT INTO x402_fee_sweeps (status, usdc_atomic) VALUES ('planned', $1) RETURNING id`,
    [String(usdc)],
  );
  const rowId = planRows[0].id;

  try {
    // 3. Quote + build + sign + sim + send
    const quote = await getJupiterQuote({
      inputMint: USDC_MINT.toBase58(),
      outputMint: SOL_MINT,
      amount: usdc.toString(),
      slippageBps: SLIPPAGE_BPS,
    });
    const swapTxB64 = await getJupiterSwapTx({ quoteResponse: quote, userPublicKey: lender.publicKey.toBase58() });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
    tx.sign([lender]);
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      throw new Error(`swap sim rejected: ${JSON.stringify(sim.value.err).slice(0, 120)} ${(sim.value.logs || []).slice(-2).join(" | ").slice(0, 160)}`);
    }
    const swapSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(swapSig, "confirmed");
    const solLamports = Number(quote.outAmount);

    // 4. Record swap success BEFORE accrual/transfer (reconcile anchor)
    await query(
      `UPDATE x402_fee_sweeps SET status = 'swapped', swap_sig = $2, sol_lamports = $3, updated_at = NOW() WHERE id = $1`,
      [rowId, swapSig, String(solLamports)],
    );

    // 5. Accrue holder share (idempotent) + transfer to distributor
    await finalizeSweep(rowId, swapSig, solLamports, lender, bot, usdc);
    console.log(`[x402-fee-sweeper] swept ${(Number(usdc) / 1e6).toFixed(4)} USDC → ${(solLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (${swapSig.slice(0, 10)}…)`);
  } catch (err) {
    await query(`UPDATE x402_fee_sweeps SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`, [
      rowId,
      String(err.message || "").slice(0, 300),
    ]);
    console.warn(`[x402-fee-sweeper] sweep #${rowId} failed: ${err.message?.slice(0, 160)}`);
  }
}

async function tick(bot) {
  if (isDisabled()) return;
  const gotLock = await tryAdvisoryLock();
  if (!gotLock) return;
  try {
    await tickInner(bot);
  } catch (err) {
    console.error("[x402-fee-sweeper] tick error:", err.message);
  } finally {
    await releaseAdvisoryLock();
  }
}

// ─── Start ────────────────────────────────────────────────────────
export function startX402FeeSweeper(bot) {
  if (isDisabled()) {
    console.log("[x402-fee-sweeper] disabled (set X402_FEE_SWEEP_ENABLED=true to enable) — not starting");
    return null;
  }
  console.log(
    `[x402-fee-sweeper] starting (interval=${INTERVAL_MS / 60_000}min, first run in ${FIRST_RUN_MS / 60_000}min, min=${MIN_USDC_ATOMIC / 1e6} USDC)`,
  );
  ensureTable().catch((e) => console.warn("[x402-fee-sweeper] ensureTable failed:", e.message));
  setTimeout(() => {
    tick(bot).catch((e) => console.error("[x402-fee-sweeper] first run error:", e.message));
  }, FIRST_RUN_MS);
  return setInterval(() => {
    tick(bot).catch((e) => console.error("[x402-fee-sweeper] interval error:", e.message));
  }, INTERVAL_MS);
}
