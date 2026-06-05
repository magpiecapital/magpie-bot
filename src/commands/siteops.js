/**
 * /siteops — operator-only read of site-action telemetry.
 *
 * Quick at-a-glance view of what the website surface has been doing:
 *
 *   - Currently locked accounts (count + the most recent few)
 *   - Last 24h site withdraws (count + total SOL + any failures)
 *   - Last 24h nonces consumed by purpose (rough "what was the site
 *     doing" trend without parsing logs)
 *   - Site tickets created in the last 24h
 *
 * Useful at 3 AM during an incident, useful daily for spot-checking
 * that nothing weird is happening.
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

function fmtSol(lamports) {
  if (lamports == null) return "0";
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleSiteOps(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const [
    { rows: lockedRows },
    { rows: lockedSample },
    { rows: withdrawAgg },
    { rows: withdrawFailures },
    { rows: noncesByPurpose },
    { rows: ticketsAgg },
  ] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS n
         FROM users WHERE site_locked_until IS NOT NULL AND site_locked_until > NOW()`,
    ),
    query(
      `SELECT id, telegram_username, site_locked_until
         FROM users
        WHERE site_locked_until IS NOT NULL AND site_locked_until > NOW()
        ORDER BY site_locked_until DESC
        LIMIT 5`,
    ),
    query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'confirmed')::int AS ok,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS fail,
              COUNT(DISTINCT user_id)::int AS distinct_users,
              COALESCE(SUM(CASE WHEN asset = 'SOL' THEN raw_amount ELSE 0 END), 0)::text AS sol_lamports
         FROM site_withdrawals
        WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query(
      `SELECT id, user_id, asset, raw_amount::text AS amount, error_text, created_at
         FROM site_withdrawals
        WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 5`,
    ),
    query(
      `SELECT purpose, COUNT(*)::int AS n
         FROM used_nonces
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY purpose
        ORDER BY n DESC`,
    ),
    query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE auto_resolved_at IS NOT NULL)::int AS auto_resolved
         FROM support_tickets
        WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
  ]);

  const locked = lockedRows[0]?.n ?? 0;
  const w = withdrawAgg[0] || { n: 0, ok: 0, fail: 0, distinct_users: 0, sol_lamports: "0" };
  const t = ticketsAgg[0] || { n: 0, auto_resolved: 0 };

  const lines = [
    "*🔭 Site Ops — last 24h*",
    "",
    `*Locked accounts:* ${locked}`,
  ];
  for (const r of lockedSample) {
    const until = new Date(r.site_locked_until).toISOString().slice(0, 16).replace("T", " ");
    const who = r.telegram_username ? `@${r.telegram_username}` : `user #${r.id}`;
    lines.push(`  • ${who} → until ${until} UTC`);
  }

  lines.push("");
  lines.push("*Site withdraws:*");
  lines.push(
    `  ${w.n} total · ${w.ok} ok · ${w.fail} failed · ${w.distinct_users} users`,
  );
  lines.push(`  SOL out: ${fmtSol(w.sol_lamports)} SOL`);
  if (withdrawFailures.length > 0) {
    lines.push("  Recent failures:");
    for (const f of withdrawFailures) {
      const amt = f.asset === "SOL" ? `${fmtSol(f.amount)} SOL` : `${f.amount} ${f.asset.slice(0, 6)}…`;
      const why = (f.error_text || "").slice(0, 80);
      lines.push(`    • #${f.id} user ${f.user_id} · ${amt} · ${why}`);
    }
  }

  lines.push("");
  lines.push("*Signed actions (by purpose):*");
  if (noncesByPurpose.length === 0) {
    lines.push("  (none in 24h)");
  } else {
    for (const n of noncesByPurpose) {
      lines.push(`  • ${n.purpose}: ${n.n}`);
    }
  }

  lines.push("");
  lines.push("*Tickets opened (24h):*");
  lines.push(`  ${t.n} total · ${t.auto_resolved} auto-resolved by AI`);

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
