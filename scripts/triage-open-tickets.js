#!/usr/bin/env node
/**
 * Read-only ticket triage: lists every ticket that is still status='open'
 * or has a user follow-up the auto-resolver hasn't picked up yet.
 *
 * Outputs a structured summary the operator can act on. Does NOT send
 * any replies, does NOT change any state. Safe to run any time.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const SKIP_REASONS = ["security_incident", "bug_report", "refund_request"];

function classifyReason(message) {
  if (!message) return null;
  for (const r of SKIP_REASONS) {
    if (message.includes(`Reason: ${r}`)) return r;
  }
  return null;
}

function unwrapMessage(message) {
  if (!message) return "";
  if (message.startsWith("[AI-escalated]")) {
    return message
      .replace(/^\[AI-escalated\]\s*/, "")
      .split("\n")[0]
      .trim();
  }
  return message;
}

async function main() {
  const { rows } = await query(
    `SELECT s.id, s.user_id, s.status, s.message, s.created_at,
            s.admin_reply, s.admin_replied_at,
            s.auto_resolved_at, s.followup_count,
            s.last_user_followup_at, s.last_alerted_tier,
            s.closed_at,
            u.telegram_id, u.telegram_username,
            EXTRACT(EPOCH FROM (NOW() - s.created_at))::int AS age_secs
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('open','awaiting_user')
      ORDER BY s.created_at ASC`,
  );

  console.log(`\nFound ${rows.length} open/awaiting tickets.\n`);

  for (const r of rows) {
    const ageH = (r.age_secs / 3600).toFixed(1);
    const reason = classifyReason(r.message);
    const clean = unwrapMessage(r.message);

    console.log(`──── Ticket #${r.id} ────`);
    console.log(`  status:            ${r.status}`);
    console.log(`  age:               ${ageH}h`);
    console.log(`  user:              @${r.telegram_username || "?"} (tg:${r.telegram_id})`);
    console.log(`  reason:            ${reason || "general"}`);
    console.log(`  followup_count:    ${r.followup_count}`);
    console.log(`  auto_resolved_at:  ${r.auto_resolved_at || "(never)"}`);
    console.log(`  admin_replied_at:  ${r.admin_replied_at || "(never)"}`);
    console.log(`  last_alerted_tier: ${r.last_alerted_tier ?? "none"}`);
    console.log(`  ── user message (first 600 chars) ──`);
    console.log("  " + (clean || "").slice(0, 600).split("\n").join("\n  "));
    if (r.admin_reply) {
      console.log(`  ── last admin/AI reply (first 400 chars) ──`);
      console.log("  " + (r.admin_reply || "").slice(0, 400).split("\n").join("\n  "));
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
