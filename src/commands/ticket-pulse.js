/**
 * /ticket_pulse — counts + IDs of the open ticket queue. NO message
 * contents, NO user PII beyond ticket IDs. Operator-only.
 *
 * Designed to be safe to surface in admin DMs every few minutes
 * (via ticket-aging-watcher or a Monitor task) without leaking
 * customer data. The actual ticket reading is via /tickets, which
 * is admin-only and shows full content.
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

/**
 * Compute the pulse — small, PII-free struct describing open queue
 * health. Exported separately so the heartbeat watcher can reuse it
 * without going through a TG context.
 */
export async function getTicketPulse() {
  const { rows: openRows } = await query(
    `SELECT id,
            status,
            EXTRACT(EPOCH FROM (NOW() - GREATEST(created_at, COALESCE(last_user_followup_at, created_at))))::int / 60 AS age_min
       FROM support_tickets
      WHERE status IN ('open', 'awaiting_user')
      ORDER BY age_min DESC`,
  );

  const buckets = {
    open_total: 0,
    awaiting_user_total: 0,
    over_2h: [],
    over_6h: [],
    over_12h: [],
    over_24h: [],
  };
  for (const r of openRows) {
    if (r.status === "open") buckets.open_total++;
    if (r.status === "awaiting_user") buckets.awaiting_user_total++;
    const m = Number(r.age_min);
    if (m >= 24 * 60) buckets.over_24h.push(r.id);
    else if (m >= 12 * 60) buckets.over_12h.push(r.id);
    else if (m >= 6 * 60) buckets.over_6h.push(r.id);
    else if (m >= 2 * 60) buckets.over_2h.push(r.id);
  }
  return buckets;
}

export async function handleTicketPulse(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const p = await getTicketPulse();
  const lines = [
    "📨 *Ticket pulse*",
    "",
    `Open (waiting on us): *${p.open_total}*`,
    `Awaiting user response: *${p.awaiting_user_total}*`,
    "",
    "*By age (open + awaiting):*",
    p.over_24h.length ? `🚨 24h+: #${p.over_24h.join(", #")}` : "🚨 24h+: (none)",
    p.over_12h.length ? `🔴 12h+: #${p.over_12h.join(", #")}` : "🔴 12h+: (none)",
    p.over_6h.length ? `🟠 6h+:  #${p.over_6h.join(", #")}` : "🟠 6h+:  (none)",
    p.over_2h.length ? `🟡 2h+:  #${p.over_2h.join(", #")}` : "🟡 2h+:  (none)",
    "",
    "Use `/tickets` for the full list with messages, `/reply <#> <text>` to respond.",
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
