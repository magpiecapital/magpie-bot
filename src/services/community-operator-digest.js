/**
 * Daily operator digest — once per day, DM the operator with a summary
 * of the past 24h of community moderation activity. Helps the operator
 * stay informed without scrolling chat or checking /community_status.
 *
 * Triggers a DM only on real activity. If the past 24h had ZERO mod
 * actions across all enabled chats, the digest is silent — no point
 * paging the operator with "nothing happened."
 *
 * Schedule:
 *   - Fires at DIGEST_HOUR_UTC every day (default: 14:00 UTC = 9am CDT /
 *     8am CST). Operator-configurable via env: COMMUNITY_DIGEST_HOUR_UTC
 *   - Self-throttled via a tiny row in community_anomaly_alerts so a
 *     restart in the same UTC day doesn't double-send
 *
 * Operator-private:
 *   - Sends ONLY to the configured admin TG ID (via notifyAdmin)
 *   - Never posts to the community chat
 */
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DIGEST_HOUR_UTC = Number(process.env.COMMUNITY_DIGEST_HOUR_UTC ?? "14");

function fmtAction(actionKey) {
  // Action keys are snake_case enums like "delete_link", "captcha_kick",
  // "image_scam_screenshot". Make them human-readable.
  return actionKey
    .replace(/^image_/, "image · ")
    .replace(/^delete_/, "deleted ")
    .replace(/_/g, " ");
}

async function build24hDigest() {
  // 1. All mod actions in the last 24h, grouped by action type
  const { rows: actionsByType } = await query(
    `SELECT action, COUNT(*)::int AS n
       FROM community_mod_actions
      WHERE created_at > NOW() - INTERVAL '24 hours'
   GROUP BY action
   ORDER BY n DESC`,
  );

  // 2. Per-chat breakdown (top 3 most-active)
  const { rows: byChat } = await query(
    `SELECT c.chat_id, c.title, COUNT(a.id)::int AS n
       FROM community_chats c
       LEFT JOIN community_mod_actions a
         ON a.chat_id = c.chat_id
        AND a.created_at > NOW() - INTERVAL '24 hours'
      WHERE c.enabled = TRUE
   GROUP BY c.chat_id, c.title
   ORDER BY n DESC NULLS LAST
      LIMIT 3`,
  );

  // 3. New members joined in last 24h
  const { rows: [memberStats] } = await query(
    `SELECT COUNT(*)::int AS joined,
            COUNT(*) FILTER (WHERE captcha_passed_at IS NOT NULL)::int AS passed,
            COUNT(*) FILTER (WHERE captcha_passed_at IS NULL
                          AND joined_at < NOW() - INTERVAL '10 minutes')::int AS failed
       FROM community_members
      WHERE joined_at > NOW() - INTERVAL '24 hours'`,
  );

  // 4. Recent serious flags (operator-attention items)
  const { rows: seriousFlags } = await query(
    `SELECT action, reason, created_at
       FROM community_mod_actions
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND action IN (
          'image_scam_screenshot', 'image_impersonation_screenshot',
          'image_nsfw_or_violence', 'flag_fud_harassment',
          'flag_fud_coordinated_fud', 'flag_fud_ban_worthy'
        )
   ORDER BY created_at DESC
      LIMIT 5`,
  );

  return { actionsByType, byChat, memberStats, seriousFlags };
}

function formatDigest({ actionsByType, byChat, memberStats, seriousFlags }) {
  const totalActions = actionsByType.reduce((s, r) => s + r.n, 0);
  if (totalActions === 0 && memberStats.joined === 0) {
    return null; // silent — nothing to report
  }

  const lines = [
    `🦅 *Magpie Community — 24h digest*`,
    ``,
    `*Members*`,
    `  • ${memberStats.joined ?? 0} joined (${memberStats.passed ?? 0} passed CAPTCHA, ${memberStats.failed ?? 0} kicked)`,
    ``,
    `*Moderation actions: ${totalActions}*`,
  ];

  if (actionsByType.length === 0) {
    lines.push(`  • none`);
  } else {
    for (const r of actionsByType.slice(0, 8)) {
      lines.push(`  • ${r.n}× ${fmtAction(r.action)}`);
    }
    if (actionsByType.length > 8) {
      lines.push(`  • + ${actionsByType.length - 8} more action types`);
    }
  }

  if (byChat.length > 1) {
    lines.push(``, `*Per chat*`);
    for (const c of byChat) {
      lines.push(`  • ${c.title}: ${c.n ?? 0} actions`);
    }
  }

  if (seriousFlags.length > 0) {
    lines.push(``, `*🚩 Flags worth your eyes:*`);
    for (const f of seriousFlags) {
      const when = new Date(f.created_at).toISOString().slice(11, 16);
      lines.push(`  • ${when} — ${fmtAction(f.action)}: ${(f.reason || "").slice(0, 100)}`);
    }
  } else {
    lines.push(``, `_No high-severity flags in the last 24h._`);
  }

  lines.push(
    ``,
    `Run \`/community_status\` in the group for live state.`,
    `Tune the digest hour via \`COMMUNITY_DIGEST_HOUR_UTC\` on Railway.`,
  );

  return lines.join("\n");
}

// Self-throttling: write a row keyed by date so a restart in the same
// UTC day doesn't re-send.
async function alreadySentToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows: [r] } = await query(
    `SELECT 1 FROM community_anomaly_alerts
      WHERE chat_id = 0 AND rule_key = $1
      LIMIT 1`,
    [`operator_digest:${today}`],
  );
  return !!r;
}

async function markSentToday() {
  const today = new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO community_anomaly_alerts (chat_id, rule_key, n_actions)
     VALUES (0, $1, 0)`,
    [`operator_digest:${today}`],
  );
}

export function startCommunityOperatorDigest(bot) {
  console.log(
    `[community-operator-digest] starting (DM fires at ${DIGEST_HOUR_UTC}:00 UTC daily)`,
  );

  async function tick() {
    try {
      const now = new Date();
      // Fire only in the matching UTC hour
      if (now.getUTCHours() !== DIGEST_HOUR_UTC) return;
      if (await alreadySentToday()) return;

      const data = await build24hDigest();
      const message = formatDigest(data);
      if (!message) {
        // No activity to report. Still mark as sent so we don't keep
        // re-checking every 15 min for the rest of the hour.
        await markSentToday();
        return;
      }

      const ok = await notifyAdmin(bot, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      if (ok) {
        await markSentToday();
        console.log("[community-operator-digest] digest DM sent");
      }
    } catch (err) {
      console.warn("[community-operator-digest] tick failed (will retry):", err.message);
    }
  }

  // Run immediately on startup (cheap if not the right hour), then every 15 min
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}
