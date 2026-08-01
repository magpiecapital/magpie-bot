#!/usr/bin/env node
/**
 * sweep-ban-impersonators.mjs — one-off admin sweep + permanent ban.
 *
 * Scans the FULL membership of every enabled community chat, runs the LIVE
 * isImpersonationName() detector on each member's current display name, and
 * (with --ban) PERMANENTLY bans every impersonator that isn't verified,
 * cleared-by-appeal, or a chat admin. Reuses the deployed bot's own detector
 * + DB, so it stays perfectly in sync with join/message enforcement.
 *
 * Runs via Railway so it uses the bot's own token + DB — secrets are read from
 * the injected env and NEVER printed:
 *   railway run --service magpie-bot node scripts/sweep-ban-impersonators.mjs            # DRY-RUN (report only)
 *   railway run --service magpie-bot node scripts/sweep-ban-impersonators.mjs --ban      # execute permanent bans
 *   railway run --service magpie-bot node scripts/sweep-ban-impersonators.mjs --chat -100xxxx --ban
 *
 * Default is DRY-RUN. Always dry-run first, eyeball the hit list, THEN --ban.
 * Bans are permanent (banChatMember with no until_date). Admins/creator, the
 * bot/operator (verified), and appeal-cleared members are never touched.
 */
import { Api } from "grammy";
import { query } from "../src/db/pool.js";
import {
  isImpersonationName,
  isHardImpersonation,
  isVerifiedAccount,
  isUserCleared,
  nameKey,
  recordModAction,
} from "../src/services/community-moderation.js";

const DO_BAN = process.argv.includes("--ban") || process.env.SWEEP_BAN === "true";
const chatArgIdx = process.argv.indexOf("--chat");
const CHAT_OVERRIDE = chatArgIdx > -1 ? process.argv[chatArgIdx + 1] : null;
const FETCH_GAP_MS = 60; // stay under Telegram's ~30 req/s
const MAX_MEMBERS = 8000;

function nameOf(u) {
  const parts = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  const un = u.username ? `@${u.username}` : "";
  return [parts, un].filter(Boolean).join(" ") || `id ${u.id}`;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not set — run this under `railway run --service magpie-bot`.");
    process.exit(1);
  }
  const api = new Api(token);

  let chats;
  if (CHAT_OVERRIDE) {
    chats = [{ chat_id: CHAT_OVERRIDE }];
  } else {
    const { rows } = await query(
      `SELECT chat_id FROM community_chats WHERE enabled = TRUE ORDER BY enabled_at DESC NULLS LAST`,
    );
    chats = rows;
  }
  if (!chats.length) {
    console.error("No enabled community chat found. Pass --chat <id>.");
    process.exit(1);
  }

  console.log(`\n=== Impersonator sweep — mode: ${DO_BAN ? "BAN (PERMANENT)" : "DRY-RUN"} — ${chats.length} chat(s) ===\n`);

  let totalHits = 0;
  let totalBanned = 0;
  for (const { chat_id: chatId } of chats) {
    const { rows: members } = await query(
      `SELECT user_id FROM community_members WHERE chat_id = $1 LIMIT $2`,
      [String(chatId), MAX_MEMBERS],
    );
    console.log(`Chat ${chatId}: scanning ${members.length} members…`);
    let scanned = 0;
    let errors = 0;
    for (const row of members) {
      try {
        const m = await api.getChatMember(chatId, Number(row.user_id));
        scanned++;
        const u = m?.user;
        if (!u) continue;
        if (m.status === "left" || m.status === "kicked") continue; // gone already
        if (m.status === "creator" || m.status === "administrator") continue; // never touch admins
        if (isVerifiedAccount(u)) continue; // bot + operator
        if (!isImpersonationName(u)) continue;
        // A clearance never shields a HARD impersonation name (exact brand /
        // homoglyph / bare-or-spaced role word) — matches the deployed
        // join/message/watchdog policy.
        if (!isHardImpersonation(u) && (await isUserCleared(chatId, Number(row.user_id), nameKey(u)))) {
          console.log(`  ~ appeal-cleared (soft match), skipping: ${nameOf(u)} [${u.id}]`);
          continue;
        }
        totalHits++;
        if (DO_BAN) {
          await api.banChatMember(chatId, Number(row.user_id)); // no until_date = permanent
          await recordModAction(
            chatId,
            Number(row.user_id),
            "sweep_ban_impersonator",
            "sweep: display name matches the impersonation filter",
            JSON.stringify({ username: u.username, first: u.first_name, last: u.last_name, status: m.status }),
          );
          totalBanned++;
          console.log(`  BANNED (permanent): ${nameOf(u)} [${u.id}] — was ${m.status}`);
        } else {
          console.log(`  HIT: ${nameOf(u)} [${u.id}] (${m.status}) — would ban with --ban`);
        }
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`  getChatMember/ban failed for ${row.user_id}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    }
    console.log(
      `Chat ${chatId}: scanned ${scanned} · hits ${totalHits}` +
        (DO_BAN ? ` · banned ${totalBanned}` : " · dry-run") +
        (errors ? ` · skipped ${errors}` : "") +
        "\n",
    );
  }

  console.log(
    `=== Done. ${
      DO_BAN
        ? `Permanently banned ${totalBanned} impersonator(s).`
        : `${totalHits} impersonator(s) found (DRY-RUN). Re-run with --ban to remove.`
    } ===\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("sweep failed:", e);
  process.exit(1);
});
