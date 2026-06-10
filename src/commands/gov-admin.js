/**
 * Operator admin commands for the governance autopilot.
 *
 *   /gov-pause [reason]       — kill the autopilot. Reason is logged.
 *   /gov-resume               — re-enable.
 *   /gov-status               — show current autopilot state + recent runs.
 *   /gov-confirm-manual <proposal_id> <action_idx>
 *                             — operator confirms that a manual action
 *                               (e.g., v3 program deploy) was completed.
 *                               This flips the audit step from "awaiting
 *                               operator" to "verified".
 *
 * Auth: same operator gate the rest of admin uses (env.OPERATOR_TG_IDS
 * comma-separated). Non-operator callers get a polite "command is
 * operator-only" message and the attempt is logged.
 */

import { query } from "../db/pool.js";

const OPERATOR_IDS = (process.env.OPERATOR_TG_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOperator(ctx) {
  if (OPERATOR_IDS.length === 0) return false;
  return OPERATOR_IDS.includes(String(ctx.from?.id ?? ""));
}

export async function handleGovPause(ctx) {
  if (!isOperator(ctx)) return ctx.reply("Command is operator-only.");
  const reason = (ctx.message?.text ?? "").replace(/^\/gov-pause\s*/, "").trim() || "(no reason given)";
  await query(
    `UPDATE governance_autopilot_state
        SET enabled = false,
            paused_by = $1,
            paused_at = NOW(),
            paused_reason = $2
      WHERE id = 1`,
    [String(ctx.from.id), reason],
  );
  await ctx.reply(`🛑 Governance autopilot PAUSED.\nReason: ${reason}\nUse /gov-resume to re-enable.`);
}

export async function handleGovResume(ctx) {
  if (!isOperator(ctx)) return ctx.reply("Command is operator-only.");
  await query(
    `UPDATE governance_autopilot_state
        SET enabled = true,
            paused_by = NULL,
            paused_at = NULL,
            paused_reason = NULL
      WHERE id = 1`,
  );
  await ctx.reply("✅ Governance autopilot RESUMED.");
}

export async function handleGovStatus(ctx) {
  if (!isOperator(ctx)) return ctx.reply("Command is operator-only.");
  const { rows: [s] } = await query(
    `SELECT enabled, paused_by, paused_at, paused_reason, last_run_at, last_run_status, last_run_detail
       FROM governance_autopilot_state WHERE id = 1`,
  );
  const { rows: recent } = await query(
    `SELECT proposal_id, outcome, closed_at, implementation_status, announcement_status
       FROM governance_proposal_state
       ORDER BY updated_at DESC LIMIT 5`,
  );
  const lines = [
    "═══ Governance Autopilot Status ═══",
    `Enabled         : ${s.enabled ? "✅ YES" : "🛑 PAUSED"}`,
    s.paused_at ? `Paused by       : ${s.paused_by}` : null,
    s.paused_at ? `Paused at       : ${s.paused_at.toISOString()}` : null,
    s.paused_reason ? `Paused reason   : ${s.paused_reason}` : null,
    `Last run        : ${s.last_run_at?.toISOString?.() ?? "never"}`,
    `Last run status : ${s.last_run_status ?? "(none)"}`,
    "",
    "Recent proposals:",
    ...(recent.length === 0 ? ["  (none)"] : recent.map(
      (r) => `  ${r.proposal_id}: outcome=${r.outcome ?? "(none)"} impl=${r.implementation_status ?? "-"} ann=${r.announcement_status ?? "-"}`,
    )),
  ].filter(Boolean);
  await ctx.reply(lines.join("\n"));
}

export async function handleGovConfirmManual(ctx) {
  if (!isOperator(ctx)) return ctx.reply("Command is operator-only.");
  const parts = (ctx.message?.text ?? "").split(/\s+/);
  const proposalId = parts[1];
  const actionIdxStr = parts[2];
  const actionIdx = Number(actionIdxStr);
  if (!proposalId || !Number.isInteger(actionIdx) || actionIdx < 0) {
    return ctx.reply("Usage: /gov-confirm-manual <proposal_id> <action_idx>\nExample: /gov-confirm-manual MGP-002 3");
  }
  await query(
    `INSERT INTO governance_pipeline_log (run_id, proposal_id, step_name, status, detail)
     VALUES (gen_random_uuid(), $1, 'manual_confirmation', 'ok', $2::jsonb)`,
    [proposalId, JSON.stringify({ action_idx: actionIdx, confirmed_by: String(ctx.from.id), confirmed_at: new Date().toISOString() })],
  );
  await ctx.reply(
    `✅ Manual action confirmed for ${proposalId}[${actionIdx}].\n` +
    `Next autopilot run will re-audit and update implementation_status accordingly.`,
  );
}
