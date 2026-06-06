/**
 * Community anomaly watcher — DMs the operator when mod-action volume
 * spikes in any moderated chat. Catches coordinated scammer waves
 * before they overwhelm.
 *
 * Triggers (any one):
 *   - >5 delete actions in a single chat in last 10 min
 *   - >3 captcha-timeout kicks in last 10 min (bot army)
 *   - >3 impersonation flags in last 30 min (coordinated naming)
 *   - first-ever mod action in a chat (heads-up: "moderation is alive")
 *
 * Cooldown per (chat, trigger) so the operator doesn't get DM'd
 * every 5 min on the same incident. Persisted via community_anomaly_alerts
 * table so a bot restart doesn't reset the cooldown.
 */
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";
import { listEnabledChats } from "./community-moderation.js";

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // every 2 min — fine-grained
const ALERT_COOLDOWN_MIN = 60;

const RULES = [
  {
    key: "delete_burst",
    windowMin: 10,
    threshold: 5,
    actions: ["delete_link", "delete_scam_pattern", "delete_quarantine_media", "delete_quarantine_rate"],
    label: (n) => `🚨 *Delete burst*: ${n} messages auto-deleted in the last 10 min — possible coordinated scammer wave`,
  },
  {
    key: "captcha_kick_burst",
    windowMin: 10,
    threshold: 3,
    actions: ["kick_captcha_timeout"],
    label: (n) => `🤖 *Bot wave*: ${n} captcha-timeout kicks in the last 10 min — likely automated join`,
  },
  {
    key: "impersonation_cluster",
    windowMin: 30,
    threshold: 3,
    actions: ["warn_impersonation_join", "flag_impersonation_msg"],
    label: (n) => `🕵️ *Impersonation cluster*: ${n} accounts with admin/support/team-style names in the last 30 min — coordinated push`,
  },
];

async function shouldAlert(chatId, ruleKey) {
  const { rows } = await query(
    `SELECT created_at FROM community_anomaly_alerts
      WHERE chat_id = $1 AND rule_key = $2
      ORDER BY created_at DESC LIMIT 1`,
    [String(chatId), ruleKey],
  );
  if (!rows[0]) return true;
  const lastMs = new Date(rows[0].created_at).getTime();
  return Date.now() - lastMs > ALERT_COOLDOWN_MIN * 60_000;
}

async function recordAlert(chatId, ruleKey, count) {
  await query(
    `INSERT INTO community_anomaly_alerts (chat_id, rule_key, n_actions, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [String(chatId), ruleKey, count],
  );
}

async function tick(bot) {
  if (!bot) return;
  const chats = await listEnabledChats();
  for (const c of chats) {
    for (const rule of RULES) {
      try {
        const { rows: [{ n }] } = await query(
          `SELECT COUNT(*)::int AS n FROM community_mod_actions
             WHERE chat_id = $1
               AND action = ANY($2::text[])
               AND created_at > NOW() - ($3 || ' minutes')::interval`,
          [String(c.chat_id), rule.actions, String(rule.windowMin)],
        );
        if (n < rule.threshold) continue;
        if (!(await shouldAlert(c.chat_id, rule.key))) continue;
        const chatRef = c.title ? `*${c.title}*` : `chat \`${c.chat_id}\``;
        await notifyAdmin(
          bot,
          [
            rule.label(n),
            ``,
            `Where: ${chatRef}`,
            ``,
            `Quick actions:`,
            `  • \`/community_status\` in DM — recent action breakdown`,
            `  • \`/community_disable\` inside the group if it's a false-positive flood`,
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        await recordAlert(c.chat_id, rule.key, n);
      } catch (err) {
        console.warn(`[anomaly] rule ${rule.key} on ${c.chat_id} failed:`, err.message);
      }
    }
  }
}

export function startCommunityAnomalyWatcher(bot) {
  console.log("[community-anomaly] watcher starting (every 2 min)");
  setInterval(() => tick(bot).catch((err) => console.error("[community-anomaly] tick failed:", err.message)), CHECK_INTERVAL_MS);
}
