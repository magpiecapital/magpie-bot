/**
 * Implementation runner — executes the implementation_plan from a
 * ratified proposal's registry entry. Each action type has its own
 * handler. All handlers return { ok, detail } for the audit log.
 *
 * Critical invariant: handlers must be IDEMPOTENT. The pipeline may
 * retry on transient failure. A handler should check current state
 * and short-circuit to "ok" if the change is already in place.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { query } from "../db/pool.js";

/**
 * db_config_update — UPDATE governance_config with previous-value capture.
 * Idempotent: if config_value already equals new_value, returns ok=true with detail.skipped=true.
 */
async function executeDbConfigUpdate(action, proposalId) {
  const { key, new_value } = action;
  const newValueJson = JSON.stringify(new_value);

  // Read current
  const cur = await query(`SELECT config_value FROM governance_config WHERE config_key = $1`, [key]);
  if (cur.rows.length === 0) {
    return { ok: false, detail: { error: `unknown_config_key: ${key}` } };
  }
  const currentJson = JSON.stringify(cur.rows[0].config_value);
  if (currentJson === newValueJson) {
    return { ok: true, detail: { skipped: true, reason: "already_at_target_value", current: cur.rows[0].config_value } };
  }

  // Update with previous-value capture, atomically
  await query(
    `UPDATE governance_config
        SET previous_value = config_value,
            config_value = $1::jsonb,
            set_by_proposal_id = $2,
            set_at = NOW()
      WHERE config_key = $3`,
    [newValueJson, proposalId, key],
  );

  // Invalidate the runtime-config cache so the new value is visible to
  // every consumer on the next read instead of waiting up to the cache
  // TTL. Critical when MGP-001 flips holder_reward_bps from 1000 → 7000:
  // accrual on the very next loan fee should use 70%, not 10%.
  try {
    const { invalidateRuntimeConfig } = await import("../services/runtime-config.js");
    invalidateRuntimeConfig(key);
  } catch (err) {
    console.warn("[implementation] runtime-config cache flush failed:", err.message);
  }

  return {
    ok: true,
    detail: {
      key,
      old_value: cur.rows[0].config_value,
      new_value,
    },
  };
}

/**
 * bot_constant_pr — open a GitHub PR with a code-level change.
 * Branch protection blocks autopilot from merging (by design); operator
 * reviews + merges. The PR opens with the diff prepared exactly per
 * the action spec.
 *
 * Idempotent: if a branch with the target name already exists on remote,
 * the action returns ok=true with detail.skipped=true.
 */
async function executeBotConstantPr(action, proposalId) {
  const { file_path, old_string, new_string, branch_name, description } = action;

  // Precheck: working tree must be clean and HEAD must be on main. If the
  // bot's git state is dirty or detached at the moment a vote passes, the
  // sequence of checkout/commit/push below would silently mangle whatever
  // is already there. Halt instead and let the operator clean it up.
  try {
    const statusOut = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
    if (statusOut.length > 0) {
      return {
        ok: false,
        detail: {
          error: "working_tree_dirty",
          hint: "Autopilot refuses to checkout a new branch when the bot's working tree has uncommitted changes. Investigate before resuming.",
          status_porcelain: statusOut.slice(0, 500),
        },
      };
    }
    const headOut = execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
    if (headOut !== "main") {
      return {
        ok: false,
        detail: {
          error: "not_on_main",
          hint: `Autopilot expected HEAD on main but found '${headOut}'. Investigate before resuming.`,
        },
      };
    }
  } catch (err) {
    return { ok: false, detail: { error: "git_precheck_failed", stderr: err.stderr?.toString?.()?.slice(0, 500) } };
  }

  // Check if branch already exists on remote
  let branchExists = false;
  try {
    execSync(`git ls-remote --exit-code --heads origin ${branch_name}`, { stdio: "pipe" });
    branchExists = true;
  } catch {
    // ls-remote exits non-zero when branch missing — desired path
  }
  if (branchExists) {
    return { ok: true, detail: { skipped: true, reason: "branch_already_pushed", branch: branch_name } };
  }

  // Verify file exists locally
  if (!existsSync(file_path)) {
    return { ok: false, detail: { error: `file_not_found: ${file_path}` } };
  }
  const cur = readFileSync(file_path, "utf8");
  if (!cur.includes(old_string)) {
    return {
      ok: false,
      detail: { error: "old_string_not_in_file", file_path, hint: "Was the file already updated?" },
    };
  }

  // Apply edit
  const next = cur.replace(old_string, new_string);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file_path, next);

  // Create branch + commit + push + PR via gh CLI
  // Author always magpiecapital per repo policy
  const cmds = [
    `git checkout -b ${branch_name}`,
    `git add ${file_path}`,
    `git -c user.name=magpiecapital -c user.email=magpiecapital@users.noreply.github.com commit -m "autopilot: ${proposalId} ${description}"`,
    `git push -u origin ${branch_name}`,
    `gh pr create --title "autopilot: ${proposalId} — ${description}" --body "Auto-generated by the governance autopilot following ratification of ${proposalId}. Operator review required before merge."`,
    `git checkout main`,
  ];
  const log = [];
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
      log.push({ cmd, out: out.slice(0, 500) });
    } catch (err) {
      // Best-effort rollback: revert the file change, checkout main
      try { writeFileSync(file_path, cur); } catch {}
      try { execSync("git checkout main", { stdio: "ignore" }); } catch {}
      return {
        ok: false,
        detail: { error: "git_command_failed", failed_cmd: cmd, stderr: err.stderr?.toString?.()?.slice(0, 500), log },
      };
    }
  }
  return { ok: true, detail: { branch: branch_name, log_summary: "pr_opened" } };
}

/**
 * manual_required — log + alert; never marked verified until operator
 * confirms via /gov-confirm-manual.
 */
async function executeManualRequired(action, proposalId) {
  return {
    ok: true,
    detail: {
      manual_required: true,
      description: action.description,
      alert_text: action.alert_text,
      verification_command: `/gov-confirm-manual ${proposalId} <action_idx>`,
    },
  };
}

/**
 * Run the full implementation plan. Returns an array of per-action
 * results in the same order as the plan, with summary stats.
 */
export async function executeImplementationPlan(plan, proposalId) {
  const results = [];
  for (let i = 0; i < plan.length; i++) {
    const action = plan[i];
    let r;
    try {
      switch (action.type) {
        case "db_config_update":
          r = await executeDbConfigUpdate(action, proposalId);
          break;
        case "bot_constant_pr":
          r = await executeBotConstantPr(action, proposalId);
          break;
        case "manual_required":
          r = await executeManualRequired(action, proposalId);
          break;
        default:
          r = { ok: false, detail: { error: `unsupported_action_type: ${action.type}` } };
      }
    } catch (err) {
      r = { ok: false, detail: { error: "handler_threw", message: err.message } };
    }
    results.push({ action_idx: i, action_type: action.type, ...r });
    // Halt the rest of the plan if a non-manual action failed (manual is
    // expected to "succeed" the autopilot step but require operator follow-up).
    if (!r.ok) break;
  }
  return results;
}
