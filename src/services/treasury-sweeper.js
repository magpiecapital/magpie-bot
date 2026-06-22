/**
 * Treasury sweeper.
 *
 * Periodically moves accumulated fees from the lender wallet (4JSSSa…)
 * to the treasury vault (6foLvbG…) so a compromise of the hot lender
 * key bounds the lifetime-fee-drain loss to one sweep window.
 *
 * Design constraints (operator-mandated 2026-06-18 PM):
 *
 *   1. World-class engineering standard — pre-flight simulate every tx
 *      before broadcast. Refuse to send anything the RPC rejects in sim.
 *
 *   2. Never breakage to existing users — the lender wallet handles
 *      cosign-borrow, attestations, admin instructions. We MUST leave a
 *      generous operational reserve (default 5 SOL, env-tunable) so
 *      none of those flows ever run dry.
 *
 *   3. Audit-trail everything — every tick writes a row to
 *      treasury_sweeps. Outcomes covered: success, skip_below_min,
 *      skip_disabled, skip_locked, sim_reject, send_error.
 *
 *   4. Operator kill switch — TREASURY_SWEEP_DISABLED=true halts the
 *      sweeper instantly without a redeploy.
 *
 *   5. Idempotent / non-overlapping — at boot, hold an advisory lock
 *      so multiple bot instances can't double-sweep. (Railway runs
 *      single-instance today but defense in depth costs nothing.)
 *
 * Env knobs:
 *
 *   | Env                              | Default            | Notes |
 *   |----------------------------------|--------------------|-------|
 *   | TREASURY_SWEEP_DISABLED          | (unset, enabled)   | Kill switch |
 *   | TREASURY_SWEEP_INTERVAL_MS       | 21600000 (6h)      | Tick cadence |
 *   | TREASURY_SWEEP_FIRST_RUN_MS      | 300000 (5min)      | Delay after boot |
 *   | TREASURY_SWEEP_RESERVE_SOL       | 5                  | Operational floor |
 *   | TREASURY_SWEEP_MIN_SOL           | 0.1                | Min sweep size; skip below |
 *   | TREASURY_SWEEP_DEST_PUBKEY       | 6foLvbG…           | Override only if you know why |
 *   | TREASURY_SWEEP_CONSEC_FAIL_ALERT | 3                  | Alert operator after N failures |
 *
 * Refs:
 *   - project_treasury_vault_2026_06_18 — the destination vault
 *   - feedback_world_class_engineering_standard
 *   - feedback_no_breakage_to_existing_users
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import fs from "node:fs";
import bs58 from "bs58";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { getAdminId } from "./admin-notify.js";
import { assertAllowedDestination } from "./privileged-destinations.js";
import {
  runPrivilegedSign,
  recordPrivilegedSignResult,
} from "./privileged-sign-guard.js";

// ─── Constants ────────────────────────────────────────────────────

const TREASURY_VAULT_DEFAULT =
  "6foLvbGkB3Joqrj9TZRhoFwEmkSW4AbyREoYWCaHqgVk";
const LENDER_PUBKEY_DEFAULT =
  "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";

const LAMPORTS_PER_SOL = 1_000_000_000;

const ADVISORY_LOCK_KEY = 73_002_606_180_618n; // arbitrary unique key

// ─── Config ───────────────────────────────────────────────────────

function envNumber(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isDisabled() {
  // Default to DISABLED until operator explicitly enables. Ship-safe
  // posture — the sweeper rolls out with the deploy but doesn't start
  // moving funds until TREASURY_SWEEP_ENABLED is set to a truthy value.
  // A defense-in-depth TREASURY_SWEEP_DISABLED still wins (kill switch
  // even if ENABLED is also set).
  const killV = (process.env.TREASURY_SWEEP_DISABLED || "").toLowerCase();
  if (killV === "1" || killV === "true" || killV === "yes") return true;
  const enableV = (process.env.TREASURY_SWEEP_ENABLED || "").toLowerCase();
  const enabled = enableV === "1" || enableV === "true" || enableV === "yes";
  return !enabled;
}

const INTERVAL_MS = envNumber("TREASURY_SWEEP_INTERVAL_MS", 6 * 60 * 60 * 1000);
const FIRST_RUN_MS = envNumber("TREASURY_SWEEP_FIRST_RUN_MS", 5 * 60 * 1000);
const RESERVE_SOL = envNumber("TREASURY_SWEEP_RESERVE_SOL", 5);
const MIN_SOL = envNumber("TREASURY_SWEEP_MIN_SOL", 0.1);
const CONSEC_FAIL_ALERT = envNumber("TREASURY_SWEEP_CONSEC_FAIL_ALERT", 3);

let consecutiveFailures = 0;

// ─── Lender keypair load ──────────────────────────────────────────

let lenderKeypairCache = null;
function loadLenderKeypair() {
  if (lenderKeypairCache) return lenderKeypairCache;
  // Match the loader pattern used by src/services/price-attestor.js:
  // prefer the env-var-encoded private key (production / Railway has
  // no on-disk keypair file), fall back to LENDER_KEYPAIR_PATH for
  // local dev. EXPLICITLY refuses the CWD-relative fallback so an
  // attacker who can plant a file in cwd can't trick the sweeper into
  // using it.
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    lenderKeypairCache = Keypair.fromSecretKey(decode(b58));
    return lenderKeypairCache;
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "treasury-sweeper: LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing the CWD-relative fallback. Set the env var.",
    );
  }
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  lenderKeypairCache = Keypair.fromSecretKey(new Uint8Array(raw));
  return lenderKeypairCache;
}

// ─── DB helpers ───────────────────────────────────────────────────

async function recordSweep(row) {
  try {
    await query(
      `INSERT INTO treasury_sweeps
         (outcome, lender_balance_lamports_before, reserve_lamports,
          swept_lamports, destination_pubkey, tx_signature, error_message,
          confirmed_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.outcome,
        String(row.lender_balance_lamports_before ?? 0),
        String(row.reserve_lamports ?? 0),
        String(row.swept_lamports ?? 0),
        row.destination_pubkey,
        row.tx_signature || null,
        row.error_message || null,
        row.confirmed_at || null,
        row.notes || null,
      ],
    );
  } catch (err) {
    // Don't crash the sweeper if the audit insert fails — log loudly
    console.error("[treasury-sweeper] audit insert failed:", err.message);
  }
}

async function tryAdvisoryLock() {
  try {
    const { rows } = await query(
      `SELECT pg_try_advisory_lock($1::bigint) AS got`,
      [String(ADVISORY_LOCK_KEY)],
    );
    return rows[0]?.got === true;
  } catch (err) {
    console.warn("[treasury-sweeper] advisory lock query failed:", err.message);
    return false;
  }
}

async function releaseAdvisoryLock() {
  try {
    await query(`SELECT pg_advisory_unlock($1::bigint)`, [
      String(ADVISORY_LOCK_KEY),
    ]);
  } catch { /* best-effort */ }
}

// ─── Alert ────────────────────────────────────────────────────────

async function alertOperator(bot, text) {
  try {
    const adminId = getAdminId();
    if (!adminId || !bot) return;
    await bot.api.sendMessage(adminId, text, { parse_mode: "Markdown" });
  } catch (err) {
    console.warn("[treasury-sweeper] alert send failed:", err.message);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────

async function tick(bot) {
  if (isDisabled()) {
    await recordSweep({
      outcome: "skip_disabled",
      lender_balance_lamports_before: 0,
      reserve_lamports: 0,
      swept_lamports: 0,
      destination_pubkey: process.env.TREASURY_SWEEP_DEST_PUBKEY || TREASURY_VAULT_DEFAULT,
      notes: "TREASURY_SWEEP_DISABLED env var set",
    });
    return;
  }

  const gotLock = await tryAdvisoryLock();
  if (!gotLock) {
    await recordSweep({
      outcome: "skip_locked",
      lender_balance_lamports_before: 0,
      reserve_lamports: 0,
      swept_lamports: 0,
      destination_pubkey: process.env.TREASURY_SWEEP_DEST_PUBKEY || TREASURY_VAULT_DEFAULT,
      notes: "advisory lock held by another instance",
    });
    return;
  }

  try {
    await tickInner(bot);
  } finally {
    await releaseAdvisoryLock();
  }
}

async function tickInner(bot) {
  const lenderPk = new PublicKey(LENDER_PUBKEY_DEFAULT);
  const destPk = new PublicKey(
    process.env.TREASURY_SWEEP_DEST_PUBKEY || TREASURY_VAULT_DEFAULT,
  );

  // 1. Read balance
  const lenderBal = await connection.getBalance(lenderPk, "confirmed");
  const reserveLamports = Math.round(RESERVE_SOL * LAMPORTS_PER_SOL);
  const minLamports = Math.round(MIN_SOL * LAMPORTS_PER_SOL);
  const sweepable = lenderBal - reserveLamports;

  // 2. Skip if below threshold
  if (sweepable < minLamports) {
    await recordSweep({
      outcome: "skip_below_min",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      notes: `sweepable=${(sweepable / LAMPORTS_PER_SOL).toFixed(4)} SOL < min=${MIN_SOL} SOL`,
    });
    consecutiveFailures = 0; // clean state, not a failure
    return;
  }

  // 3. Build transfer instruction
  // Reserve ~5000 lamports of headroom for the tx fee on top of the
  // operational reserve — we don't want to leave the wallet with
  // exactly RESERVE and then need a few thousand lamports to actually
  // send this tx.
  const TX_FEE_HEADROOM = 5000;
  const sweepAmount = sweepable - TX_FEE_HEADROOM;
  if (sweepAmount <= 0) {
    await recordSweep({
      outcome: "skip_below_min",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      notes: "sweepable after tx-fee headroom is <= 0",
    });
    return;
  }

  const lenderKp = loadLenderKeypair();
  if (!lenderKp.publicKey.equals(lenderPk)) {
    const msg = `lender keypair pubkey ${lenderKp.publicKey.toBase58()} does not match expected ${LENDER_PUBKEY_DEFAULT}`;
    await recordSweep({
      outcome: "sim_reject",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      error_message: msg,
    });
    consecutiveFailures++;
    await maybeAlertConsecutive(bot, msg);
    return;
  }

  // Hard allowlist check — the destination MUST be on the source-
  // level allowlist for this service. An attacker who flips
  // TREASURY_SWEEP_DEST_PUBKEY on Railway can only redirect to a
  // pre-approved cold-storage vault.
  try {
    assertAllowedDestination("treasury-sweeper", destPk);
  } catch (allowlistErr) {
    await recordSweep({
      outcome: "sim_reject",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      error_message: allowlistErr.message?.slice(0, 200),
      notes: "destination not on source-level allowlist — refusing to build tx",
    });
    consecutiveFailures++;
    await maybeAlertConsecutive(bot, allowlistErr.message?.slice(0, 200));
    return;
  }

  const ix = SystemProgram.transfer({
    fromPubkey: lenderPk,
    toPubkey: destPk,
    lamports: sweepAmount,
  });
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: lenderPk,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(ix);

  // Sign + simulate + audit-log through the centralised guard. The
  // guard verifies the lender's SOL balance decreases by <= the swept
  // amount + a tx-fee budget, and rejects on any other balance change
  // (e.g. an undeclared token decrease on a lender ATA).
  // Operator-mandated 2026-06-18 PM — see
  // feedback_cosign_borrow_token_drain_exploit_2026_06_18.
  let guard;
  try {
    guard = await runPrivilegedSign({
      service: "treasury-sweeper",
      tx,
      signers: [lenderKp],
      allowedDeltas: [
        {
          pubkey: lenderPk,
          kind: "sol",
          // Allow up to sweepAmount + tx-fee headroom + 5000 lamports of
          // priority-fee slack. Any deviation is suspicious.
          maxDecrease: BigInt(sweepAmount + TX_FEE_HEADROOM + 5_000),
        },
      ],
    });
  } catch (guardErr) {
    const errStr = guardErr.message?.slice(0, 200) || "guard rejected";
    await recordSweep({
      outcome: "sim_reject",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      error_message: errStr,
    });
    consecutiveFailures++;
    await maybeAlertConsecutive(bot, `Sweep guard rejected: ${errStr}`);
    return;
  }
  const auditId = guard.auditId;

  // 5. Broadcast
  let sig;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  } catch (err) {
    await recordSweep({
      outcome: "send_error",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      error_message: err.message?.slice(0, 200),
    });
    await recordPrivilegedSignResult({
      auditId,
      status: "failed",
      error: `broadcast: ${err.message?.slice(0, 200)}`,
    });
    consecutiveFailures++;
    await maybeAlertConsecutive(bot, `Sweep send failed: ${err.message?.slice(0, 120)}`);
    return;
  }
  await recordPrivilegedSignResult({ auditId, status: "broadcast", txSig: sig });

  // 6. Confirm
  try {
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  } catch (err) {
    await recordSweep({
      outcome: "send_error",
      lender_balance_lamports_before: lenderBal,
      reserve_lamports: reserveLamports,
      swept_lamports: 0,
      destination_pubkey: destPk.toBase58(),
      tx_signature: sig,
      error_message: `confirm timeout: ${err.message?.slice(0, 120)}`,
    });
    await recordPrivilegedSignResult({
      auditId,
      status: "failed",
      error: `confirm: ${err.message?.slice(0, 200)}`,
    });
    consecutiveFailures++;
    await maybeAlertConsecutive(bot, `Sweep confirm timeout: ${sig}`);
    return;
  }
  await recordPrivilegedSignResult({ auditId, status: "confirmed", txSig: sig });

  // 7. Success
  consecutiveFailures = 0;
  await recordSweep({
    outcome: "success",
    lender_balance_lamports_before: lenderBal,
    reserve_lamports: reserveLamports,
    swept_lamports: sweepAmount,
    destination_pubkey: destPk.toBase58(),
    tx_signature: sig,
    confirmed_at: new Date(),
  });
  console.log(
    `[treasury-sweeper] swept ${(sweepAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${destPk.toBase58()} (sig: ${sig.slice(0, 10)}…)`,
  );
}

async function maybeAlertConsecutive(bot, errMsg) {
  if (consecutiveFailures < CONSEC_FAIL_ALERT) return;
  // Reset so we don't spam — operator gets one alert per threshold crossing.
  consecutiveFailures = 0;
  await alertOperator(
    bot,
    `*Treasury sweeper failing*\n\n` +
      `Last error: \`${errMsg.slice(0, 200)}\`\n\n` +
      `Set \`TREASURY_SWEEP_DISABLED=true\` on Railway to halt, or check the \`treasury_sweeps\` audit table for context.`,
  );
}

// ─── Start ────────────────────────────────────────────────────────

export function startTreasurySweeper(bot) {
  if (isDisabled()) {
    console.log("[treasury-sweeper] disabled via TREASURY_SWEEP_DISABLED — not starting");
    return null;
  }
  console.log(
    `[treasury-sweeper] starting (interval=${INTERVAL_MS / 60_000}min, first run in ${FIRST_RUN_MS / 60_000}min, reserve=${RESERVE_SOL} SOL, min=${MIN_SOL} SOL)`,
  );
  setTimeout(() => {
    tick(bot).catch((err) => {
      console.error("[treasury-sweeper] first tick threw:", err.message);
    });
  }, FIRST_RUN_MS);
  return setInterval(() => {
    tick(bot).catch((err) => {
      console.error("[treasury-sweeper] tick threw:", err.message);
    });
  }, INTERVAL_MS);
}

// ─── Status helpers (for admin commands) ──────────────────────────

export async function getTreasurySweeperStatus() {
  const lenderPk = new PublicKey(LENDER_PUBKEY_DEFAULT);
  const destPk = new PublicKey(
    process.env.TREASURY_SWEEP_DEST_PUBKEY || TREASURY_VAULT_DEFAULT,
  );
  const [lenderBal, treasuryBal, recent] = await Promise.all([
    connection.getBalance(lenderPk, "confirmed").catch(() => null),
    connection.getBalance(destPk, "confirmed").catch(() => null),
    query(
      `SELECT id, outcome, initiated_at,
              lender_balance_lamports_before::text AS bal_before,
              swept_lamports::text AS swept,
              tx_signature, error_message, notes
         FROM treasury_sweeps
        ORDER BY initiated_at DESC LIMIT 10`,
    ).catch(() => ({ rows: [] })),
  ]);
  return {
    disabled: isDisabled(),
    interval_min: INTERVAL_MS / 60_000,
    reserve_sol: RESERVE_SOL,
    min_sol: MIN_SOL,
    lender_pubkey: lenderPk.toBase58(),
    lender_balance_sol:
      lenderBal == null ? null : lenderBal / LAMPORTS_PER_SOL,
    treasury_vault_pubkey: destPk.toBase58(),
    treasury_balance_sol:
      treasuryBal == null ? null : treasuryBal / LAMPORTS_PER_SOL,
    consecutive_failures: consecutiveFailures,
    recent: recent.rows,
  };
}
