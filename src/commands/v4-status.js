/**
 * /v4-status — admin command for a one-shot V4 health snapshot.
 *
 * V4 Hardening T7 (operator-mandated 2026-06-15 PM).
 *
 * Surfaces everything an operator needs to answer "is V4 healthy right
 * now?" in a single TG message:
 *
 *   1. Active V4 loans + recent borrows/repays/liquidations
 *   2. V4 limit-close arms + fires
 *   3. Per-loan sol_proceeds_vault probe summary (read on-chain right
 *      now — not the watcher's cached state — so a regression is
 *      visible immediately)
 *   4. Recent arm-attempt audit (catches "request reached the bot but
 *      was rejected" failures the dashboard didn't surface)
 *   5. Most recent V4 fire — full receipt
 *   6. Engine canary tail — was the last V4 canary OK?
 *
 * Read-only. No mutations. Safe to run any time.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { isAdmin } from "../services/admin.js";
import { getJupiterBudgetStats } from "../services/jupiter-budget.js";

function fmt(n) {
  if (n == null) return "?";
  return Number(n).toLocaleString();
}

function fmtSol(lamports) {
  if (lamports == null) return "?";
  return (Number(lamports) / 1e9).toFixed(4);
}

function ageMs(ts) {
  if (!ts) return null;
  return Date.now() - new Date(ts).getTime();
}

function fmtAge(ms) {
  if (ms == null) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function handleV4Status(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply("Not authorized.");
  }

  const v4ProgramIdStr = process.env.PROGRAM_ID_V4;
  if (!v4ProgramIdStr) {
    return ctx.reply("PROGRAM_ID_V4 not set. No V4 to check.");
  }
  let v4ProgramId;
  try { v4ProgramId = new PublicKey(v4ProgramIdStr); }
  catch { return ctx.reply(`PROGRAM_ID_V4 invalid: \`${v4ProgramIdStr}\``, { parse_mode: "Markdown" }); }

  await ctx.reply("Collecting V4 health snapshot…");

  // Jupiter budget stats (rolling 60s window) — cheap, no I/O
  let jupBudget = null;
  try { jupBudget = getJupiterBudgetStats(); } catch { /* best-effort */ }

  // ── 1. Loan + activity counts ──
  const sinceWindow = "INTERVAL '24 hours'";
  let counts = null;
  try {
    const { rows: [row] } = await query(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status = 'active' AND start_timestamp > NOW() - ${sinceWindow})::int AS borrows_24h,
          COUNT(*) FILTER (WHERE status = 'repaid' AND end_timestamp > NOW() - ${sinceWindow})::int AS repays_24h,
          COUNT(*) FILTER (WHERE status = 'liquidated' AND end_timestamp > NOW() - ${sinceWindow})::int AS liquidations_24h
         FROM loans WHERE program_id = $1`,
      [v4ProgramIdStr],
    );
    counts = row;
  } catch (err) {
    counts = { err: err.message?.slice(0, 80) };
  }

  // ── 2. Arm + fire counts ──
  let armFire = null;
  try {
    const { rows: [row] } = await query(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'armed')::int AS armed,
          COUNT(*) FILTER (WHERE status = 'armed' AND armed_at > NOW() - ${sinceWindow})::int AS armed_24h,
          COUNT(*) FILTER (WHERE status = 'fired')::int AS fired,
          COUNT(*) FILTER (WHERE status = 'fired' AND fired_at > NOW() - ${sinceWindow})::int AS fired_24h
         FROM limit_close_orders WHERE engine_program_id = $1`,
      [v4ProgramIdStr],
    );
    armFire = row;
  } catch (err) {
    armFire = { err: err.message?.slice(0, 80) };
  }

  // ── 3. sol_proceeds_vault probe over EVERY active V4 loan ──
  let probeSummary = { ok: 0, uninit: 0, token2022: 0, other: 0, rpc_blip: 0, failures: [] };
  try {
    const { rows: loans } = await query(
      `SELECT id, loan_id::text AS loan_id, loan_pda
         FROM loans WHERE program_id = $1 AND status = 'active' LIMIT 50`,
      [v4ProgramIdStr],
    );
    for (const l of loans) {
      try {
        const loanPdaPk = new PublicKey(l.loan_pda);
        const [solProceedsVault] = PublicKey.findProgramAddressSync(
          [Buffer.from("sol-proceeds"), loanPdaPk.toBuffer()],
          v4ProgramId,
        );
        const info = await connection.getAccountInfo(solProceedsVault, "confirmed");
        if (!info) probeSummary.uninit++;
        else if (info.owner.equals(TOKEN_PROGRAM_ID)) probeSummary.ok++;
        else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          probeSummary.token2022++;
          probeSummary.failures.push(`loan ${l.id}: Token-2022 vault (${solProceedsVault.toBase58().slice(0, 8)}…)`);
        } else {
          probeSummary.other++;
          probeSummary.failures.push(`loan ${l.id}: owner=${info.owner.toBase58().slice(0, 8)}…`);
        }
      } catch (err) {
        probeSummary.rpc_blip++;
      }
    }
  } catch (err) {
    probeSummary = { err: err.message?.slice(0, 80) };
  }

  // ── 4. Recent arm-attempt audit (last 20 attempts on V4 loans) ──
  let armAuditTail = [];
  try {
    const { rows } = await query(
      `SELECT a.created_at, a.status, a.error_code, a.error_message, a.loan_id, l.program_id
         FROM arm_attempt_audit a
         LEFT JOIN loans l ON l.id = a.loan_id
        WHERE l.program_id = $1
        ORDER BY a.created_at DESC LIMIT 10`,
      [v4ProgramIdStr],
    );
    armAuditTail = rows;
  } catch (err) {
    // Audit table may not be filtered by program — fall back to most recent.
    try {
      const { rows } = await query(
        `SELECT created_at, status, error_code, error_message, loan_id
           FROM arm_attempt_audit ORDER BY created_at DESC LIMIT 10`,
      );
      armAuditTail = rows;
    } catch { /* silent */ }
  }

  // ── 5. Most recent V4 fire receipt ──
  let lastFire = null;
  try {
    const { rows: [row] } = await query(
      `SELECT loan_id, trigger_kind, trigger_value_micro::text AS tv,
              slice_pct, fired_at, proceeds_lamports::text AS proceeds,
              net_to_user_lamports::text AS net, tx_signature_swap
         FROM limit_close_orders
        WHERE engine_program_id = $1 AND status = 'fired'
        ORDER BY fired_at DESC LIMIT 1`,
      [v4ProgramIdStr],
    );
    lastFire = row;
  } catch (err) {
    lastFire = { err: err.message?.slice(0, 80) };
  }

  // ── 6. Engine canary tail (V4 only) ──
  let canaryTail = null;
  try {
    const { rows: [row] } = await query(
      `SELECT run_at, overall_ok, duration_ms, checks
         FROM engine_canary_runs
        WHERE program_id = $1
        ORDER BY run_at DESC LIMIT 1`,
      [v4ProgramIdStr],
    );
    canaryTail = row;
  } catch (err) {
    canaryTail = { err: err.message?.slice(0, 80) };
  }

  // ── Format response ──
  const lines = [
    `*V4 Health Snapshot*`,
    `Program: \`${v4ProgramIdStr.slice(0, 8)}…${v4ProgramIdStr.slice(-4)}\``,
    "",
    `*Loans*`,
    `• Active:          *${fmt(counts?.active)}*`,
    `• Borrows (24h):   ${fmt(counts?.borrows_24h)}`,
    `• Repays (24h):    ${fmt(counts?.repays_24h)}`,
    `• Liquidations (24h): ${fmt(counts?.liquidations_24h)}`,
    "",
    `*Limit-close orders*`,
    `• Armed (total):   ${fmt(armFire?.armed)}`,
    `• Armed (24h):     ${fmt(armFire?.armed_24h)}`,
    `• Fired (total):   ${fmt(armFire?.fired)}`,
    `• Fired (24h):     *${fmt(armFire?.fired_24h)}*`,
    "",
    `*sol_proceeds_vault probe (every active V4 loan)*`,
    `• Classic SPL (good):  ${probeSummary.ok}`,
    `• Uninit (lazy-ok):    ${probeSummary.uninit}`,
    `• Token-2022 (BAD):    ${probeSummary.token2022}`,
    `• Other owner (BAD):   ${probeSummary.other}`,
    `• RPC blips:           ${probeSummary.rpc_blip}`,
    ...(probeSummary.failures && probeSummary.failures.length > 0 ? [
      "",
      `_Failing loans:_`,
      ...probeSummary.failures.slice(0, 5).map((f) => `  ${f}`),
    ] : []),
    "",
    `*Last V4 fire*`,
    lastFire?.fired_at
      ? `• At ${fmtAge(ageMs(lastFire.fired_at))}, loan ${lastFire.loan_id}, slice ${(lastFire.slice_pct || 10000) / 100}%, proceeds ${fmtSol(lastFire.proceeds)} SOL`
      : "• No V4 fires yet.",
    "",
    `*Latest V4 engine canary*`,
    canaryTail?.run_at
      ? `• ${canaryTail.overall_ok ? "OK" : "FAIL"} ${fmtAge(ageMs(canaryTail.run_at))} (${canaryTail.duration_ms}ms)`
      : "• No canary runs yet.",
    "",
    `*Recent arm-attempt audit (any pool)*`,
    armAuditTail.length === 0
      ? "• No recent rows."
      : armAuditTail.slice(0, 5).map((a) =>
          `• ${fmtAge(ageMs(a.created_at))}: \`${a.status || "?"}\` loan ${a.loan_id || "?"} ${a.error_code ? `(${a.error_code})` : ""}`,
        ).join("\n"),
    "",
    `*Jupiter budget (rolling 60s)*`,
    ...(jupBudget
      ? [
          `• OK: ${jupBudget.jup_ok} · 429: ${jupBudget.jup_429} · err: ${jupBudget.jup_err} · ratio_429: ${jupBudget.ratio_429}`,
          `• Bucket: ${Math.floor(jupBudget.bucket.tokens_available)}/${jupBudget.bucket.budget_max} (${jupBudget.bucket.budget_per_sec}/sec)`,
          `• Defers to Dex: ${jupBudget.budget_defer} · backoff skips: ${jupBudget.backoff_skip} · mints in backoff: ${jupBudget.mints_in_backoff}`,
        ]
      : ["• stats unavailable"]),
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
