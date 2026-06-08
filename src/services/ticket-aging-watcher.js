/**
 * Ticket aging watcher — DMs admin about stale open tickets.
 *
 * Runs every hour. For each open ticket, computes age and alerts admin
 * once per tier crossing (2h, 8h, 24h). This way you don't get spammed
 * every hour about the same ticket, but you DO get a nudge when it
 * escalates into a new urgency tier.
 *
 * The `last_alerted_tier` column on support_tickets tracks which tier
 * was last alerted for that ticket. Set to NULL by /reply (admin
 * replied, no longer stale) and by user follow-up (clock resets).
 */
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";

const ADMIN_TG_ID = getAdminId() || null;
const POLL_INTERVAL_MS = Number(process.env.TICKET_AGE_WATCH_MS) || 10 * 60 * 1000; // 10min — every-10 cadence per operator directive

// 2026-06-08 — reinstated multi-tier alerting after a ticket sat 12h+
// without admin notice (user complained publicly in TG). Previously the
// watcher relied on the AI auto-resolver doing everything, with admin
// alert only at 24h. That left a gap when the resolver didn't fire or
// the ticket needed human judgment. Now alerts compound — admin sees
// the ticket at 2h, again at 6h, again at 12h, again at 24h. Each tier
// is one-shot per ticket so no spam, just visibility.
const TIERS = [
  { idx: 1, mins: 2 * 60,  emoji: "🟡", label: "2h+ open — AI may still be working but admin should be aware" },
  { idx: 2, mins: 6 * 60,  emoji: "🟠", label: "6h+ open — AI auto-resolver hasn't closed this" },
  { idx: 3, mins: 12 * 60, emoji: "🔴", label: "12h+ open — user is likely getting frustrated" },
  { idx: 4, mins: 24 * 60, emoji: "🚨", label: "24h+ open — DEAD LETTER, handle ASAP" },
];

function tierForAge(ageMins) {
  // Walk tiers from highest to lowest, return the first match
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (ageMins >= TIERS[i].mins) return TIERS[i];
  }
  return null;
}

async function tick(bot) {
  if (!bot || !ADMIN_TG_ID) return;

  // Pull all open tickets with their age (using GREATEST of created_at
  // and last_user_followup_at — the clock resets on user follow-ups).
  const { rows } = await query(
    `SELECT id, last_alerted_tier,
            EXTRACT(EPOCH FROM (NOW() - GREATEST(created_at, COALESCE(last_user_followup_at, created_at))))::int AS age_secs
       FROM support_tickets
      WHERE status = 'open'`,
  );

  const newlyEscalated = []; // { ticket_id, tier }
  for (const r of rows) {
    const ageMins = Math.floor(Number(r.age_secs) / 60);
    const tier = tierForAge(ageMins);
    if (!tier) continue;
    const lastAlerted = r.last_alerted_tier ?? 0;
    if (tier.idx > lastAlerted) {
      newlyEscalated.push({ id: r.id, tier });
      // Persist so we don't re-alert this ticket at the same tier
      await query(
        `UPDATE support_tickets SET last_alerted_tier = $2 WHERE id = $1`,
        [r.id, tier.idx],
      );
    }
  }

  if (newlyEscalated.length === 0) return;

  // Group by tier for a tidy summary
  const byTier = {};
  for (const e of newlyEscalated) {
    const key = e.tier.idx;
    if (!byTier[key]) byTier[key] = { tier: e.tier, ids: [] };
    byTier[key].ids.push(e.id);
  }

  const sections = [];
  for (const k of Object.keys(byTier).sort((a, b) => Number(b) - Number(a))) {
    const t = byTier[k];
    sections.push(`${t.tier.emoji} *${t.tier.label}* · #${t.ids.join(", #")}`);
  }

  try {
    await bot.api.sendMessage(
      ADMIN_TG_ID,
      [
        "🚨 *Stale tickets need attention*",
        "",
        ...sections,
        "",
        "Use `/tickets` for the full list with messages, `/reply <#> <text>` to respond, `/close <#>` to resolve.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    console.log(`[ticket-age] Alerted admin: ${newlyEscalated.length} ticket(s) escalated`);
  } catch (err) {
    console.warn("[ticket-age] admin alert failed:", err.message);
  }
}

export function startTicketAgingWatcher(bot) {
  if (!ADMIN_TG_ID) {
    console.log("[ticket-age] No ADMIN_TG_ID — watcher disabled");
    return;
  }
  console.log(`[ticket-age] Starting (interval=${POLL_INTERVAL_MS}ms)`);
  // First sweep 90s after boot — gives DB patches time to apply
  setTimeout(() => tick(bot), 90 * 1000);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}
