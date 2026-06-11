/**
 * Raid-related TG commands.
 *
 *   /raided [evidence_url]   — public, anyone in the chat. Records a
 *                              claim against the currently-live raid.
 *                              Replies with the running tally
 *                              (X / GOAL). When the GOAL is hit, the
 *                              command itself posts the celebration
 *                              message into the chat.
 *
 *   /raidstatus              — public. Shows the live raid (if any),
 *                              the goal, and progress.
 *
 *   /raidadd <handle>        — operator-only. Adds a new X handle to
 *                              the raid_targets table.
 *
 *   /raidremove <handle>     — operator-only. Disables (does not
 *                              delete) a handle.
 *
 *   /raidlist                — operator-only. Lists enabled targets.
 */
import { query } from "../db/pool.js";
import { recordRaidClaim, getLiveRaidStatus } from "../services/raid-monitor.js";
import { isAdmin } from "../services/admin.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("Operator-only.");
    return false;
  }
  return true;
}

/* ─── /raided ────────────────────────────────────────────────────── */

export async function handleRaided(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  // Optional evidence URL as the argument.
  const text = ctx.message?.text || "";
  const argMatch = text.match(/^\/raided(?:@\w+)?\s+(\S+)/);
  const evidenceUrl = argMatch ? argMatch[1].trim() : null;

  let result;
  try {
    result = await recordRaidClaim({
      tgUserId: userId,
      tgUsername: ctx.from?.username || null,
      tgChatId: ctx.chat?.id || null,
      evidenceUrl,
    });
  } catch (err) {
    console.error("[raided] failed:", err.message);
    await ctx.reply("Couldn't record your raid claim right now — try again in a sec.");
    return;
  }

  if (!result.ok) {
    await ctx.reply(result.message || "No active raid right now.");
    return;
  }

  if (result.duplicate) {
    await ctx.reply(
      `Already counted you for this raid — sit tight.\n` +
      `Progress: ${result.claims_now} / ${result.goal}`,
    );
    return;
  }

  const remaining = Math.max(0, result.goal - result.claims_now);
  await ctx.reply(
    `Counted. Thanks for the raid.\n` +
    `Progress: ${result.claims_now} / ${result.goal}` +
    (remaining > 0 ? ` — ${remaining} more to hit the floor.` : ""),
  );

  if (result.just_hit_goal) {
    await ctx.reply(
      `GOAL HIT — ${result.goal} raid claims locked in.\n` +
      `Magpie's reply section is yours now. Keep pushing if you've got more in the tank.`,
    );
  }
}

/* ─── /raidstatus ────────────────────────────────────────────────── */

export async function handleRaidStatus(ctx) {
  const live = await getLiveRaidStatus();
  if (!live) {
    await ctx.reply("No raid live right now. Pip will ping the chat when the next one drops.");
    return;
  }
  const remaining = Math.max(0, live.goal_claims - live.claims_now);
  const lines = [
    `Live raid: @${live.handle}`,
    live.tweet_url,
    ``,
    `Progress: ${live.claims_now} / ${live.goal_claims}` +
      (remaining > 0 ? ` — ${remaining} more to clear it.` : ""),
    ``,
    `Run /raided after you've replied + liked + reposted.`,
  ];
  await ctx.reply(lines.join("\n"), { disable_web_page_preview: false });
}

/* ─── /raidadd <handle>  (operator-only) ─────────────────────────── */

export async function handleRaidAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const m = text.match(/^\/raidadd(?:@\w+)?\s+@?([A-Za-z0-9_]{1,15})/);
  if (!m) {
    await ctx.reply("Usage: /raidadd <handle>   (X handle, no @)");
    return;
  }
  const handle = m[1].toLowerCase();
  const display = m[1];
  try {
    await query(
      `INSERT INTO raid_targets (handle, display_name, added_by, notes)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (handle) DO UPDATE SET enabled = TRUE, display_name = EXCLUDED.display_name`,
      [handle, display, String(ctx.from?.id || "operator"), `added via /raidadd ${new Date().toISOString().slice(0,10)}`],
    );
    await ctx.reply(`Watching @${display}. New posts will broadcast to @magpietalk.`);
  } catch (err) {
    await ctx.reply(`Couldn't add @${display}: ${err.message?.slice(0, 100)}`);
  }
}

/* ─── /raidremove <handle>  (operator-only) ──────────────────────── */

export async function handleRaidRemove(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const m = text.match(/^\/raidremove(?:@\w+)?\s+@?([A-Za-z0-9_]{1,15})/);
  if (!m) {
    await ctx.reply("Usage: /raidremove <handle>");
    return;
  }
  const handle = m[1].toLowerCase();
  const { rowCount } = await query(
    `UPDATE raid_targets SET enabled = FALSE WHERE handle = $1`,
    [handle],
  );
  if (rowCount > 0) {
    await ctx.reply(`Stopped watching @${m[1]}.`);
  } else {
    await ctx.reply(`@${m[1]} wasn't on the watch list.`);
  }
}

/* ─── /raidlist  (operator-only) ─────────────────────────────────── */

export async function handleRaidList(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { rows } = await query(
    `SELECT handle, display_name, enabled, added_at FROM raid_targets ORDER BY enabled DESC, handle`,
  );
  if (rows.length === 0) {
    await ctx.reply("No raid targets configured.");
    return;
  }
  const lines = ["Raid targets:"];
  for (const r of rows) {
    lines.push(`  ${r.enabled ? "✓" : "✗"}  @${r.display_name || r.handle}`);
  }
  await ctx.reply(lines.join("\n"));
}
