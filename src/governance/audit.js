/**
 * Audit step — independent re-verification that the implementation
 * actually landed correctly. This runs AFTER implementation and BEFORE
 * announcement, so the community is never told "the change is live"
 * unless we have verified it from a clean read.
 *
 * Each action type has its own audit function. The audit reads the
 * post-state and compares it to the planned state. Anything other
 * than an exact match → audit failure → halt announcement.
 *
 * Audit functions are READ-ONLY. They never mutate. If audit fails,
 * the implementation rollback path is handled by the pipeline, not here.
 */

import { execSync } from "node:child_process";
import { query } from "../db/pool.js";

async function auditDbConfigUpdate(action) {
  const { key, new_value } = action;
  const { rows } = await query(`SELECT config_value FROM governance_config WHERE config_key = $1`, [key]);
  if (rows.length === 0) {
    return { verified: false, reason: `key_not_found: ${key}` };
  }
  const got = JSON.stringify(rows[0].config_value);
  const want = JSON.stringify(new_value);
  if (got !== want) {
    return { verified: false, reason: `value_mismatch: want=${want} got=${got}` };
  }
  return { verified: true, reason: "config_value_matches_plan" };
}

const GITHUB_REPO_SLUG = process.env.GITHUB_REPO_SLUG || "magpiecapital/magpie-bot";
const GITHUB_API_BASE = "https://api.github.com";

/**
 * Audit branch+PR existence via the GitHub REST API. The previous
 * implementation shelled out to git + gh, but the Railway container
 * doesn't include either binary — every audit failed with
 * "git: not found", stalling MGP-001's pipeline at verification_failed.
 * The bot repo is public, so unauthenticated REST calls suffice
 * (60 req/hr/IP — autopilot ticks every 5 min so well under budget).
 */
async function auditBotConstantPr(action) {
  const { branch_name } = action;
  const headers = { "Accept": "application/vnd.github+json", "User-Agent": "magpie-autopilot-audit" };
  // Branch existence
  try {
    const r = await fetch(
      `${GITHUB_API_BASE}/repos/${GITHUB_REPO_SLUG}/branches/${encodeURIComponent(branch_name)}`,
      { headers },
    );
    if (r.status === 404) {
      return { verified: false, reason: `branch_not_on_remote: ${branch_name}` };
    }
    if (!r.ok) {
      return { verified: false, reason: `branch_lookup_http_${r.status}` };
    }
  } catch (err) {
    return { verified: false, reason: `branch_lookup_failed: ${err.message?.slice(0, 80)}` };
  }
  // Open PR for the branch
  try {
    const [owner] = GITHUB_REPO_SLUG.split("/");
    const r = await fetch(
      `${GITHUB_API_BASE}/repos/${GITHUB_REPO_SLUG}/pulls?head=${owner}:${encodeURIComponent(branch_name)}&state=open`,
      { headers },
    );
    if (!r.ok) {
      return { verified: false, reason: `pr_lookup_http_${r.status}` };
    }
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      return { verified: false, reason: "no_open_pr_for_branch" };
    }
  } catch (err) {
    return { verified: false, reason: `pr_lookup_failed: ${err.message?.slice(0, 80)}` };
  }
  return { verified: true, reason: "branch_pushed_and_pr_open" };
}

async function auditManualRequired(action, proposalId, actionIdx) {
  // Manual actions are verified ONLY when the operator explicitly
  // confirms via /gov-confirm-manual. Check the operator_manual_confirmations
  // ledger via governance_pipeline_log.
  const { rows } = await query(
    `SELECT 1 FROM governance_pipeline_log
     WHERE proposal_id = $1
       AND step_name = 'manual_confirmation'
       AND detail->>'action_idx' = $2
       AND status = 'ok'
     LIMIT 1`,
    [proposalId, String(actionIdx)],
  );
  if (rows.length === 0) {
    return { verified: false, reason: "awaiting_operator_manual_confirmation" };
  }
  return { verified: true, reason: "operator_confirmed_manual_action" };
}

/**
 * Audit a full implementation plan. Returns:
 *   {
 *     overall_verified: bool,
 *     per_action: [ { action_idx, action_type, verified, reason }, ... ],
 *     summary: { verified_count, unverified_count }
 *   }
 *
 * `overall_verified = true` ONLY if EVERY non-manual action is verified.
 * Manual actions in awaiting_operator state are tracked but DON'T block
 * the announcement — the announcement template includes "pending manual"
 * status for any unconfirmed manual actions.
 */
export async function auditImplementation({ plan, implResults, proposalId }) {
  const per_action = [];
  let verified_count = 0;
  let unverified_count = 0;
  let blocking_unverified = 0;

  for (let i = 0; i < plan.length; i++) {
    const action = plan[i];
    const implResult = implResults[i];
    // If implementation halted before this action, mark unverified
    if (!implResult) {
      per_action.push({ action_idx: i, action_type: action.type, verified: false, reason: "implementation_did_not_reach" });
      unverified_count++;
      blocking_unverified++;
      continue;
    }
    let r;
    try {
      switch (action.type) {
        case "db_config_update":
          r = await auditDbConfigUpdate(action);
          break;
        case "bot_constant_pr":
          r = await auditBotConstantPr(action);
          break;
        case "manual_required":
          r = await auditManualRequired(action, proposalId, i);
          break;
        default:
          r = { verified: false, reason: `unsupported_action_type_in_audit: ${action.type}` };
      }
    } catch (err) {
      r = { verified: false, reason: `auditor_threw: ${err.message}` };
    }
    per_action.push({ action_idx: i, action_type: action.type, ...r });
    if (r.verified) verified_count++;
    else {
      unverified_count++;
      // Manual-required awaiting confirmation is NON-blocking — we still
      // announce the result; operator will follow up. All other unverified
      // states block the announcement.
      if (action.type !== "manual_required") blocking_unverified++;
    }
  }

  return {
    overall_verified: blocking_unverified === 0,
    per_action,
    summary: { verified_count, unverified_count, blocking_unverified },
  };
}
