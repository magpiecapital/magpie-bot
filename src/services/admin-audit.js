/**
 * Admin command audit log writer + reader.
 *
 * Security audit F-4 (2026-06-12, MEDIUM): every admin command must be
 * recorded so a TG-account compromise leaves a forensic trail. Two-step
 * approval for the most sensitive commands is a separate follow-up; this
 * module ships the foundation (logging + reader) that approval will build on.
 *
 * Usage at a handler:
 *
 *   import { logAdminCommand } from "../services/admin-audit.js";
 *
 *   bot.command("enablemint", async (ctx) => {
 *     if (!isAdmin(ctx.from?.id)) {
 *       await logAdminCommand(ctx, "enablemint", { outcome: "denied" });
 *       return ctx.reply("admin only");
 *     }
 *     try {
 *       await doEnable(...);
 *       await logAdminCommand(ctx, "enablemint", { outcome: "success", args: mint });
 *     } catch (err) {
 *       await logAdminCommand(ctx, "enablemint", { outcome: "error", error: err.message });
 *       throw err;
 *     }
 *   });
 *
 * The log is append-only; never UPDATE/DELETE rows here. Operator-facing
 * /admincmds reads the most recent N rows.
 */
import { query } from "../db/pool.js";

const ARGS_MAX_LEN = 200;

/**
 * Strip known-secret patterns + cap length. We never want a full pubkey,
 * signature, or long base58 blob in the log — too useful to an attacker
 * who later gains DB read access, and too privacy-invasive even for
 * routine ops.
 */
function redactArgs(args) {
  if (args == null) return null;
  let s = String(args);
  // Solana pubkeys / signatures are 32-88 char base58. Replace anything
  // 32+ chars of [1-9A-HJ-NP-Za-km-z] with a short hash-marker.
  s = s.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, (m) => `<base58:${m.slice(0, 4)}…${m.slice(-4)}>`);
  // Long hex blobs (signatures, hashes).
  s = s.replace(/[0-9a-fA-F]{40,}/g, (m) => `<hex:${m.slice(0, 4)}…${m.slice(-4)}>`);
  if (s.length > ARGS_MAX_LEN) s = s.slice(0, ARGS_MAX_LEN - 1) + "…";
  return s;
}

/**
 * Record an admin command attempt. Never throws — logging failures must
 * not break the command flow.
 *
 * outcome ∈ {'success', 'denied', 'error'}
 *   - 'success': command authorized + executed without error
 *   - 'denied' : isAdmin() rejected the caller (UNAUTHORIZED ATTEMPT)
 *   - 'error'  : authorized but execution threw
 */
export async function logAdminCommand(ctx, command, opts = {}) {
  const outcome = opts.outcome || "success";
  if (!["success", "denied", "error"].includes(outcome)) {
    console.warn(`[admin-audit] bad outcome "${outcome}" for command "${command}"`);
    return;
  }
  try {
    await query(
      `INSERT INTO admin_command_log
         (admin_tg_id, admin_username, command, args_redacted, outcome, error_excerpt, chat_id, chat_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        Number(ctx?.from?.id) || 0,
        ctx?.from?.username || null,
        String(command).slice(0, 64),
        redactArgs(opts.args),
        outcome,
        opts.error ? String(opts.error).slice(0, 200) : null,
        ctx?.chat?.id ? Number(ctx.chat.id) : null,
        ctx?.chat?.type || null,
      ],
    );
  } catch (err) {
    // Log to stderr only — never break the command.
    console.error(`[admin-audit] write failed for ${command}/${outcome}: ${err.message}`);
  }
}

/**
 * Read the most recent N command attempts. Returns rows in reverse
 * chronological order. Default 25; cap at 200.
 */
export async function recentAdminCommands({ limit = 25, command = null, adminTgId = null } = {}) {
  const cappedLimit = Math.max(1, Math.min(200, Number(limit) || 25));
  const params = [];
  let where = "WHERE 1=1";
  if (command) {
    params.push(String(command).slice(0, 64));
    where += ` AND command = $${params.length}`;
  }
  if (adminTgId) {
    params.push(Number(adminTgId));
    where += ` AND admin_tg_id = $${params.length}`;
  }
  params.push(cappedLimit);
  const { rows } = await query(
    `SELECT id, admin_tg_id, admin_username, command, args_redacted, outcome, error_excerpt, chat_id, chat_type, created_at
       FROM admin_command_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Count unauthorized attempts (outcome=denied) in the last N hours.
 * Useful for proactive alerting on a recon-style probe pattern.
 */
export async function countDeniedAttempts({ hours = 24 } = {}) {
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS n
       FROM admin_command_log
      WHERE outcome = 'denied'
        AND created_at > NOW() - ($1 || ' hours')::interval`,
    [String(hours)],
  );
  return r?.n || 0;
}

/* ════════════════════════════════════════════════════════════════
 *  MULTI-STEP APPROVAL (audit F-4, migration 042)
 * ════════════════════════════════════════════════════════════════
 *
 * Sensitive admin commands route through requireApproval(). When two
 * admins are configured, the first admin's invocation creates a
 * pending row + DMs the others; a different admin executes the action
 * via /approve <id>. Solo-admin deployments bypass the gate (no second
 * admin exists) and the bypass is logged for visibility.
 *
 * Default commands gated:
 *   enablemint, disablemint, broadcast
 *
 * Tunable via ADMIN_COMMAND_APPROVAL_REQUIRED env var
 * (comma-separated). Empty value disables the gate entirely.
 */

const APPROVAL_TTL_MS = Number(process.env.ADMIN_APPROVAL_TTL_MS || 5 * 60_000);

// Parse the gated-command list once at import. Empty string OR "none"
// disables the gate entirely (useful for staging).
function gatedCommandSet() {
  const env = process.env.ADMIN_COMMAND_APPROVAL_REQUIRED;
  if (env === undefined || env === null) {
    return new Set(["enablemint", "disablemint", "broadcast"]);
  }
  if (env === "" || env.toLowerCase() === "none") return new Set();
  return new Set(env.split(",").map((s) => s.trim()).filter(Boolean));
}

export function isApprovalGated(command) {
  return gatedCommandSet().has(String(command));
}

/**
 * Snapshot the configured admin IDs at call time. Mirrors how
 * src/services/admin.js builds its in-memory Set, but re-reads env so a
 * mid-session ADMIN_TELEGRAM_IDS change is honored without a restart.
 */
function adminTgIds() {
  return new Set(
    (process.env.ADMIN_TELEGRAM_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
}

/**
 * Create a pending approval row + return its id. Caller is responsible
 * for DM'ing the other admins (we don't import grammy here to keep
 * this module bot-framework-free).
 *
 * args object is stored verbatim as JSONB. It MUST contain everything
 * the executor needs to replay the command — the original ctx is gone
 * by the time the second admin approves.
 */
export async function requestApproval({ command, args, requesterCtx }) {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  const { rows: [row] } = await query(
    `INSERT INTO admin_command_approvals
       (command, args_json, requester_tg_id, requester_username, requester_chat_id, expires_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6)
     RETURNING id, expires_at`,
    [
      String(command).slice(0, 64),
      JSON.stringify(args || {}),
      Number(requesterCtx?.from?.id) || 0,
      requesterCtx?.from?.username || null,
      requesterCtx?.chat?.id ? Number(requesterCtx.chat.id) : null,
      expiresAt,
    ],
  );
  return { approvalId: Number(row.id), expiresAt: row.expires_at };
}

/**
 * Look up a pending approval by id, with full row fields. Returns null
 * if not found OR if the row's status is no longer pending.
 */
export async function getPendingApproval(approvalId) {
  const { rows: [row] } = await query(
    `SELECT id, command, args_json, requester_tg_id, requester_username,
            requested_at, expires_at, status
       FROM admin_command_approvals
      WHERE id = $1 AND status = 'pending'`,
    [Number(approvalId)],
  );
  return row || null;
}

/**
 * Mark a pending approval as approved by approverTgId. Rejects:
 *   - id not found / not pending
 *   - approver is the same admin who requested it (self-approval block)
 *   - expired (status → 'expired' as a side-effect)
 *
 * Returns { ok: true, row } on success or { ok: false, reason } on reject.
 * The row return is the post-update state so the caller can dispatch
 * to the executor with the original args_json.
 */
export async function approveAndClaim({ approvalId, approverCtx }) {
  const approverTgId = Number(approverCtx?.from?.id) || 0;
  const approverUsername = approverCtx?.from?.username || null;

  // Read first to validate same-admin + expiry. A bad actor could try to
  // race the UPDATE so we follow with a CAS-like conditional UPDATE that
  // only succeeds if the row is still pending AND not expired AND not
  // requested by the approver.
  const pending = await getPendingApproval(approvalId);
  if (!pending) return { ok: false, reason: "not_found_or_not_pending" };
  if (Number(pending.requester_tg_id) === approverTgId) {
    return { ok: false, reason: "self_approval_blocked" };
  }
  if (new Date(pending.expires_at) < new Date()) {
    // Lazy expiry: mark expired so /pending doesn't show it again.
    await query(
      `UPDATE admin_command_approvals SET status='expired' WHERE id=$1 AND status='pending'`,
      [Number(approvalId)],
    );
    return { ok: false, reason: "expired" };
  }
  const { rows: [updated] } = await query(
    `UPDATE admin_command_approvals
        SET status='approved', approver_tg_id=$2, approver_username=$3, approved_at=NOW()
      WHERE id = $1
        AND status = 'pending'
        AND expires_at > NOW()
        AND requester_tg_id <> $2
      RETURNING id, command, args_json, requester_tg_id`,
    [Number(approvalId), approverTgId, approverUsername],
  );
  if (!updated) return { ok: false, reason: "race_lost_or_invalid" };
  return { ok: true, row: updated };
}

/**
 * Mark a pending approval as denied. Same validation as approve except
 * we allow self-deny (an admin can cancel their own pending request —
 * useful if they realize they typo'd before another admin sees it).
 */
export async function denyApproval({ approvalId, denierCtx }) {
  const { rows: [updated] } = await query(
    `UPDATE admin_command_approvals
        SET status='denied', denied_at=NOW(),
            approver_tg_id=$2, approver_username=$3
      WHERE id = $1 AND status = 'pending'
      RETURNING id, command, requester_tg_id`,
    [
      Number(approvalId),
      Number(denierCtx?.from?.id) || 0,
      denierCtx?.from?.username || null,
    ],
  );
  if (!updated) return { ok: false, reason: "not_found_or_not_pending" };
  return { ok: true, row: updated };
}

/**
 * Mark an approved request as executed. Caller invokes after the real
 * command finishes; passes any error message for forensic logging.
 */
export async function markExecuted(approvalId, errorMessage = null) {
  await query(
    `UPDATE admin_command_approvals
        SET status='executed', executed_at=NOW(), execute_error=$2
      WHERE id = $1 AND status = 'approved'`,
    [Number(approvalId), errorMessage ? String(errorMessage).slice(0, 200) : null],
  );
}

/**
 * List pending approvals. Cap 50.
 */
export async function listPendingApprovals({ limit = 25 } = {}) {
  const cappedLimit = Math.max(1, Math.min(50, Number(limit) || 25));
  const { rows } = await query(
    `SELECT id, command, args_json, requester_tg_id, requester_username,
            requested_at, expires_at
       FROM admin_command_approvals
      WHERE status = 'pending' AND expires_at > NOW()
      ORDER BY requested_at DESC
      LIMIT $1`,
    [cappedLimit],
  );
  return rows;
}

/**
 * Operator-facing helper used by the approval gate. Returns the list of
 * admin TG ids EXCLUDING the requester — that's who should be DM'd.
 */
export function otherAdminTgIds(requesterTgId) {
  const all = adminTgIds();
  all.delete(Number(requesterTgId));
  return [...all];
}

/**
 * Solo-admin? Returns true when there's exactly ONE configured admin
 * AND that admin is the requester. In that case, the approval gate
 * cannot meaningfully require a second approver, so we short-circuit.
 */
export function isSoloAdmin(requesterTgId) {
  const all = adminTgIds();
  return all.size <= 1 && all.has(Number(requesterTgId));
}
