/**
 * V4 Hardening T5 — Per-loan V4 health probe.
 *
 * Why this exists (operator-mandated 2026-06-15 PM)
 * ─────────────────────────────────────────────────
 * The Token-2022 sol_proceeds_vault init bug that broke loans 762/763/772
 * was invisible until users tried to repay. The patch (V4 program sha256
 * 0d57a4f3...) is shipped, but if it EVER regresses for any reason —
 * Anchor codegen drift, a future redeploy with a missing constraint,
 * incidental state corruption — we want to know within minutes, not
 * when the next user hits it.
 *
 * This probe runs every PROBE_INTERVAL_MS (default 15 min). For each
 * active V4 loan it:
 *   1. Derives the sol_proceeds_vault PDA.
 *   2. Reads it on-chain via getAccountInfo.
 *   3. If initialized: verifies owner === classic SPL Token Program.
 *      If Token-2022: P0 alert to operator + log.
 *   4. If uninitialized: ok (lazy init expected on first fire/repay).
 *
 * Read-only. No tx submission. No state changes. Symmetric with the
 * engine canary's sol_proceeds_vault check (which validates against a
 * single template loan) — this probe is stricter because it sweeps
 * EVERY active V4 loan.
 *
 * The probe is additive: it never touches V1/V2/V3 loans, never writes
 * to any DB table, and degrades silently on RPC blip. If it can't
 * read the chain it logs a warn and keeps going.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";

const PROBE_INTERVAL_MS = Number(process.env.V4_HEALTH_PROBE_INTERVAL_MS) || 15 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const ALERT_DEDUP_WINDOW_MS = 6 * 60 * 60_000; // re-alert at most every 6h per loan

// In-memory dedup so we don't spam the operator on every cycle. Keyed by
// loan_id. Value is the last unix-ms we alerted on that loan.
const _lastAlertedAt = new Map();

let _timer = null;

function solProceedsVaultPda(loanPubkey, v4ProgramId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol-proceeds"), loanPubkey.toBuffer()],
    v4ProgramId,
  );
}

async function probeOneLoan(loan, v4ProgramId) {
  const loanPdaPk = new PublicKey(loan.loan_pda);
  const [solProceedsVault] = solProceedsVaultPda(loanPdaPk, v4ProgramId);
  let info;
  try {
    info = await connection.getAccountInfo(solProceedsVault, "confirmed");
  } catch (err) {
    return { ok: null, reason: "rpc_blip", detail: err.message?.slice(0, 80) };
  }
  if (!info) {
    // Vault not initialized yet — that's normal for a loan that hasn't
    // had a fire-or-repay event yet. Will be init_if_needed'd lazily.
    return { ok: true, reason: "uninitialized_ok" };
  }
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return {
      ok: false,
      reason: "vault_owned_by_token2022",
      detail: `loan ${loan.id} (chain ${loan.loan_id}) sol_proceeds_vault ${solProceedsVault.toBase58()} owned by Token-2022 instead of classic SPL Token`,
    };
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    return {
      ok: false,
      reason: "vault_owner_unexpected",
      detail: `loan ${loan.id} sol_proceeds_vault owner ${info.owner.toBase58()} (expected classic SPL Token)`,
    };
  }
  return { ok: true, reason: "vault_classic_spl" };
}

async function tick(bot) {
  const v4ProgramIdStr = process.env.PROGRAM_ID_V4;
  if (!v4ProgramIdStr) return; // No V4 deployed → nothing to probe
  let v4ProgramId;
  try { v4ProgramId = new PublicKey(v4ProgramIdStr); } catch {
    console.warn("[v4-health-probe] PROGRAM_ID_V4 invalid; skipping tick");
    return;
  }

  let loans;
  try {
    const r = await query(
      `SELECT id, loan_id::text AS loan_id, loan_pda, borrower_wallet, collateral_mint
         FROM loans
        WHERE program_id = $1 AND status = 'active'
        LIMIT 100`,
      [v4ProgramIdStr],
    );
    loans = r.rows;
  } catch (err) {
    console.warn("[v4-health-probe] DB read failed:", err.message?.slice(0, 80));
    return;
  }
  if (loans.length === 0) return;

  let failures = [];
  let okCount = 0;
  let unknownCount = 0;
  for (const l of loans) {
    const r = await probeOneLoan(l, v4ProgramId);
    if (r.ok === true) okCount++;
    else if (r.ok === null) unknownCount++;
    else failures.push({ loan: l, result: r });
  }

  if (failures.length === 0) {
    console.log(`[v4-health-probe] OK n=${loans.length} (uninit/init both safe), rpc_blips=${unknownCount}`);
    return;
  }

  console.warn(`[v4-health-probe] FAIL ${failures.length}/${loans.length} loans have bad sol_proceeds_vault state`);
  const adminId = getAdminId();
  if (!adminId || !bot) return;
  const now = Date.now();
  // De-dup per loan — alert once per loan per ALERT_DEDUP_WINDOW_MS.
  const fresh = failures.filter((f) => (now - (_lastAlertedAt.get(f.loan.id) || 0)) > ALERT_DEDUP_WINDOW_MS);
  for (const f of fresh) _lastAlertedAt.set(f.loan.id, now);

  if (fresh.length === 0) {
    console.log("[v4-health-probe] all failures within dedup window; suppressing DMs");
    return;
  }

  try {
    await bot.api.sendMessage(
      adminId,
      [
        `*V4 sol_proceeds_vault probe FAILED on ${fresh.length} loan(s)*`,
        "",
        ...fresh.slice(0, 5).map((f) => `\`loan ${f.loan.id} (chain ${f.loan.loan_id})\`: ${f.result.reason} — ${(f.result.detail || "").slice(0, 100)}`),
        fresh.length > 5 ? `… and ${fresh.length - 5} more` : "",
        "",
        "This is the patched-bug class returning. Investigate immediately — the V4 patch (sha256 0d57a4f3...) may have regressed or a new failure mode appeared.",
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.warn("[v4-health-probe] alert DM failed:", err.message?.slice(0, 80));
  }
}

export function startV4LoanHealthProbe(bot) {
  if (_timer) return;
  console.log(`[v4-health-probe] armed — first run in ${FIRST_RUN_DELAY_MS / 60_000} min, then every ${PROBE_INTERVAL_MS / 60_000} min`);
  setTimeout(() => {
    tick(bot).catch((e) => console.warn("[v4-health-probe] first tick threw:", e.message?.slice(0, 80)));
    _timer = setInterval(() => {
      tick(bot).catch((e) => console.warn("[v4-health-probe] tick threw:", e.message?.slice(0, 80)));
    }, PROBE_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

export function stopV4LoanHealthProbe() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
