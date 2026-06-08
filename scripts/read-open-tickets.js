#!/usr/bin/env node
/**
 * Operator-authorized read of currently-open support tickets.
 * Used by the agent to triage and reply to tickets autonomously.
 *
 * Reads support_tickets where status is not closed/resolved, including
 * a specific ticket id when --id <N> is passed.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REPO_ROOT, ".env") });
const { query } = await import("../src/db/pool.js");

const idArg = process.argv.indexOf("--id");
const targetId = idArg >= 0 ? Number(process.argv[idArg + 1]) : null;

const where = targetId
  ? `t.id = $1`
  : `t.status IN ('open','pending','waiting_user','escalated','awaiting_user')`;
const params = targetId ? [targetId] : [];

const { rows } = await query(
  `SELECT t.id, t.user_id, t.status, t.created_at, t.message,
          t.last_alerted_tier, t.admin_reply, t.admin_replied_at,
          t.auto_resolved_at, t.last_user_followup_at, t.followup_count,
          t.closed_at,
          u.telegram_id, u.telegram_username,
          EXTRACT(EPOCH FROM (NOW() - t.created_at))::int / 3600.0 AS age_hours,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(t.last_user_followup_at, t.created_at)))::int / 3600.0 AS age_since_user_h
     FROM support_tickets t
     LEFT JOIN users u ON u.id = t.user_id
    WHERE ${where}
    ORDER BY t.created_at ASC`,
  params,
);

for (const r of rows) {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`TICKET #${r.id} · status=${r.status} · age=${Number(r.age_hours).toFixed(1)}h`);
  console.log(`User #${r.user_id} @${r.telegram_username ?? "?"} (tg ${r.telegram_id})`);
  console.log(`Since-user-touch: ${Number(r.age_since_user_h).toFixed(1)}h · last_alerted_tier=${r.last_alerted_tier ?? "null"}`);
  if (r.auto_resolved_at) console.log(`AI auto-resolved at: ${r.auto_resolved_at}`);
  console.log("─── user message ───");
  console.log(String(r.message || "(empty)").slice(0, 2000));
  if (r.admin_reply) {
    console.log(`─── last admin/AI reply (replied at: ${r.admin_replied_at ?? "?"}) ───`);
    console.log(String(r.admin_reply).slice(0, 1500));
  }
  console.log(`followup_count=${r.followup_count} closed_at=${r.closed_at ?? "null"}`);
}
console.log("═══════════════════════════════════════════════════════");
console.log(`Total in scope: ${rows.length}`);
process.exit(0);
