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
