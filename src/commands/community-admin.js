/**
 * Operator-facing commands to control community moderation. None of
 * these are user-facing; every command requires admin auth.
 *
 *   /community_enable     — turn moderation ON for the current chat
 *                           (must be invoked inside the group)
 *   /community_disable    — turn it off (also must be inside the group)
 *   /community_status     — show recent action counts + member stats
 *   /community_allowlist  — list current URL allowlist
 */
import { isAdmin } from "../services/admin.js";
import {
  enableChat,
  disableChat,
  isChatEnabled,
  recentStats,
  URL_ALLOWLIST,
  listEnabledChats,
  markUserCleared,
} from "../services/community-moderation.js";

/**
 * Operator-command gate. Non-admins hit this when they try
 * /community_enable, /community_repost_guidelines, etc. — usually because
 * they saw the command in another user's message or in autocomplete.
 *
 * Curt "Not authorized" replies make Pip feel hostile and confuse new
 * members. Instead: silently remove the command from the public chat
 * (operator commands shouldn't clutter the feed), DM the user a friendly
 * explainer with what they CAN do, and only fall back to a brief in-group
 * reply if the DM bounces.
 */
async function requireAdmin(ctx) {
  if (isAdmin(ctx.from?.id)) return true;

  const commandText = (ctx.message?.text || "").split(/\s+/)[0] || "an operator command";
  const inGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // 1. Best-effort: delete the original command message from the group
  //    so the public chat isn't filled with admin-command attempts.
  if (inGroup) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch { /* fail-open — bot may lack perms; not critical */ }
  }

  // 2. DM the user a warm, useful explainer.
  const friendlyDm = [
    `Hey 👋 — \`${commandText}\` is an *operator-only* command (used by the Magpie team to configure moderation). It's not something the community uses directly, so I didn't run it.`,
    ``,
    `*Here's what you can do in the community group (@magpietalk):*`,
    `• \`/ask <question>\` — ask me anything about Magpie, the protocol, your loans, fees, tiers, etc.`,
    `• Chat with other Magpie users — discussion, questions, memes are all welcome`,
    `• React to / reply to others' messages normally`,
    ``,
    `*And here in your private bot (@magpie\\_capital\\_bot):*`,
    `• \`/borrow\` — take a loan against your tokens`,
    `• \`/positions\` — see your active loans + health`,
    `• \`/repay\` — close out a loan and get your collateral back`,
    `• \`/help\` — full command list`,
    ``,
    `If you have feedback or noticed something off in the community group, just \`/support\` and the team will see it. 🙏`,
  ].join("\n");

  let dmDelivered = true;
  try {
    await ctx.api.sendMessage(ctx.from.id, friendlyDm, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (err) {
    // User probably hasn't /start'd the bot yet; we can't DM them.
    dmDelivered = false;
    console.warn(`[community-admin] could not DM user ${ctx.from?.id}: ${err.message}`);
  }

  // 3. Brief fallback reply if we couldn't DM and we're in a group.
  if (!dmDelivered && inGroup) {
    try {
      await ctx.api.sendMessage(
        ctx.chat.id,
        `Hey @${ctx.from.username || ctx.from.first_name || "there"} — \`${commandText}\` is operator-only. ` +
        `Open me in DM and tap *Start* to get your wallet + the full command list. Or use \`/ask <question>\` here in the group anytime. 🙏`,
        {
          parse_mode: "Markdown",
          reply_to_message_id: ctx.message?.message_id,
        },
      );
    } catch { /* group post may fail; non-critical */ }
  }

  // 4. Direct invocation (operator command tried in DM by a non-admin)
  //    — they're already in a 1:1 with the bot, just answer there too.
  if (!inGroup && dmDelivered === false) {
    try {
      await ctx.reply(friendlyDm, { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch { /* nothing more we can do */ }
  }

  return false;
}

function isGroup(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/** The pinned community guidelines. Edit GUIDELINES_MESSAGE below to
 *  change copy; re-run /community_repost_guidelines to update the pin. */
const GUIDELINES_MESSAGE = [
  "👋 *Welcome to the Magpie community.*",
  "",
  "I'm Pip — Magpie's AI agent. I moderate this group, answer questions, and surface protocol updates. Tap `/ask` or `@magpie_capital_bot` followed by your question and I'll do my best.",
  "",
  "🛡 *Safety basics — please read once*",
  "• *Never* share your seed phrase or private key. Anyone asking is a scammer. No exceptions.",
  "• *Never* DM strangers about your wallet, even if they say they're \"Magpie support\". Real Magpie comms come ONLY through this bot in a group setting, or via the official X handle.",
  "• Official accounts: [X · @MagpieLoans](https://x.com/MagpieLoans) · [Bot · @magpie_capital_bot](https://t.me/magpie_capital_bot) · [Community · @magpietalk](https://t.me/magpietalk) · [Site · magpie.capital](https://magpie.capital). Anything else is impersonation. *Full canonical list:* [magpie.capital/links](https://magpie.capital/links)",
  "• If someone offers you \"free $MAGPIE\", \"claim your airdrop\", or wants you to send SOL to an address — it's a scam. Always.",
  "",
  "🔗 *No links — period. One exception only.*",
  "The *only* links allowed in this group are tweets from the official [@MagpieLoans](https://x.com/MagpieLoans) X account. Everything else — even our own site, even Solscan, even other useful tools — gets auto-removed. Why? Because in DeFi groups, ~every \"helpful link\" a stranger drops turns out to be a phishing site. We'd rather be over-strict than have one user lose their wallet.",
  "",
  "🤖 *Other auto-moderation*",
  "• Phishing-pattern phrases → deleted (\"seed phrase\", \"send me X SOL\", \"free airdrop\", \"DM me for\", etc.)",
  "• Impersonators with `magpie/support/admin/team` in their name → flagged",
  "• New members are quarantined for 7 days (no images / forwards / fast-posting) — this isn't personal, it's how we keep scammer bots out",
  "",
  "💬 *To get help*",
  "• `/ask <question>` — ask me anything about Magpie",
  "• Personal stuff (your loans, credit score, balance) — DM me at @magpie_capital_bot. I can't see who's asking from this group.",
  "",
  "🛠 *Public commands* (no LLM cost, instant)",
  "*Protocol*",
  "• `/stats`   — live numbers (total borrowed, active loans, LP)",
  "• `/tiers`   — the three loan tiers + trade-offs",
  "• `/fees`    — fee breakdown",
  "• `/how`     — how Magpie works in 5 steps",
  "• `/tokens`  — approved collateral list",
  "• `/wallet`  — what a Magpie wallet is",
  "• `/credit`  — on-chain credit score 300-850",
  "• `/lend`    — deposit SOL to the LP pool",
  "• `/keeper`  — keeper network (open to anyone)",
  "• `/tvl`     — live pool TVL + book size",
  "• `/apy`     — 30d rolling APR estimate for LPs",
  "• `/liquidations` — liquidation history + why it stays low",
  "*$MAGPIE token*",
  "• `/ca`      — contract address (copy-paste safe)",
  "• `/magpie`  — token details + holder benefits",
  "• `/buy`     — how to buy",
  "• `/chart`   — DEXScreener / Birdeye / Pump.fun",
  "• `/holders` — $MAGPIE holder rewards (70% of fees)",
  "*Get involved*",
  "• `/refer`   — earn 10% of friends' loan fees, lifetime",
  "*Links*",
  "• `/website` — magpie.capital",
  "• `/links`   — all four official surfaces",
  "• `/x`       — @MagpieLoans on X",
  "• `/docs`    — documentation",
  "• `/whitepaper` — full design + mechanics",
  "*Transparency*",
  "• `/audit`   — audit status (honest)",
  "• `/risk`    — what could go wrong",
  "• `/team`    — who's behind Magpie",
  "*Safety + support*",
  "• `/faq`     — common questions answered",
  "• `/scam`    — Magpie-themed scam patterns",
  "• `/support` — personal help (redirects to DM)",
  "• `/phantom` — Phantom dApp known-issue status",
  "",
  "_Verify any protocol claim on-chain at [solscan.io](https://solscan.io) or [magpie.capital/stats](https://magpie.capital/stats)._",
].join("\n");

async function postAndPinGuidelines(ctx) {
  try {
    const sent = await ctx.api.sendMessage(ctx.chat.id, GUIDELINES_MESSAGE, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    await ctx.api.pinChatMessage(ctx.chat.id, sent.message_id, {
      disable_notification: false, // do notify; users should see this once
    }).catch((err) => {
      console.warn("[community-enable] pin failed:", err.message);
    });
    return true;
  } catch (err) {
    console.warn("[community-enable] post-guidelines failed:", err.message);
    return false;
  }
}

export async function handleCommunityEnable(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply("Run this *inside* the group you want to moderate, not in DM.", { parse_mode: "Markdown" });
  }
  const alreadyOn = await isChatEnabled(ctx.chat.id);
  await enableChat(ctx.chat.id, ctx.chat.title, ctx.from.id);
  await ctx.reply(
    `✅ Community moderation *enabled* for "${ctx.chat.title}".\n\n` +
    `Make sure the bot has *Delete Messages*, *Ban Users*, AND *Pin Messages* ` +
    `permissions in the group admin settings, or some rules will silently fail.\n\n` +
    `Use \`/community_status\` for recent stats, \`/community_disable\` to turn off.`,
    { parse_mode: "Markdown" },
  );
  // Auto-post + pin guidelines on FIRST enable. Re-runs of /community_enable
  // don't re-pin (operator can /community_repost_guidelines to refresh).
  if (!alreadyOn) {
    const ok = await postAndPinGuidelines(ctx);
    if (ok) {
      await ctx.reply(
        `📌 Posted + pinned the community guidelines. New members will see them at the top of the chat. ` +
        `Edit copy in src/commands/community-admin.js and run \`/community_repost_guidelines\` to refresh.`,
      );
    } else {
      await ctx.reply(
        `⚠️ Moderation is on, but I couldn't auto-pin the guidelines (likely missing *Pin Messages* permission). ` +
        `Grant the permission and run \`/community_repost_guidelines\`.`,
        { parse_mode: "Markdown" },
      );
    }
  }
}

export async function handleCommunityRepostGuidelines(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply("Run this inside the group.");
  }
  const ok = await postAndPinGuidelines(ctx);
  if (ok) await ctx.reply("📌 Guidelines reposted + pinned.");
  else await ctx.reply("⚠️ Failed — check Pin Messages permission.");
}

export async function handleCommunityDisable(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply("Run this inside the group.");
  }
  await disableChat(ctx.chat.id);
  await ctx.reply("✋ Community moderation disabled for this chat.");
}

export async function handleCommunityStatus(ctx) {
  if (!(await requireAdmin(ctx))) return;
  // If invoked in DM, show all enabled chats. If in a group, show that group.
  if (isGroup(ctx)) {
    const on = await isChatEnabled(ctx.chat.id);
    const stats = await recentStats(ctx.chat.id, 24);
    const lines = [
      `*${ctx.chat.title}*`,
      `Moderation: ${on ? "🟢 ON" : "⚪️ OFF"}`,
      ``,
      `Last 24h actions:`,
      stats.length === 0 ? "  (none)" : stats.map(s => `  • ${s.action.padEnd(28)} ${s.n}`).join("\n"),
    ];
    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }
  // DM mode: list every enabled chat
  const chats = await listEnabledChats();
  if (chats.length === 0) {
    return ctx.reply("No chats currently have moderation enabled. Run /community_enable inside a group to start.");
  }
  const lines = ["*Active moderated chats:*", ""];
  for (const c of chats) {
    const stats = await recentStats(c.chat_id, 24);
    const total = stats.reduce((sum, s) => sum + s.n, 0);
    lines.push(`• ${c.title || c.chat_id} — ${total} action(s) in last 24h`);
  }
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

export async function handleCommunityBroadcastNow(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { fireDigestNow } = await import("../services/community-broadcast.js");
  try {
    // In DM → preview to operator only. In group → post to that group.
    const target = isGroup(ctx) ? ctx.chat.id : ctx.from.id;
    await fireDigestNow({ api: ctx.api }, target);
    if (!isGroup(ctx)) await ctx.reply("✅ Digest preview sent (just to you). Run inside a moderated group to post there.");
  } catch (err) {
    await ctx.reply(`❌ Broadcast failed: ${err.message?.slice(0, 200)}`);
  }
}

export async function handleCommunityAllowlist(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const items = [...URL_ALLOWLIST];
  await ctx.reply(
    `*URL allowlist* (${items.length} entries):\n\n` +
    items.map(u => `  • \`${u}\``).join("\n") +
    `\n\nTo change, edit \`URL_ALLOWLIST\` in src/services/community-moderation.js and redeploy.`,
    { parse_mode: "Markdown" },
  );
}

/* ──────────────── Operator ops: /unban, /strikes, /clear_strikes ──────────────── */

/**
 * Parse a user reference from a command argument. Accepts:
 *   - numeric user_id (the Telegram API needs this for unbans)
 *   - @username — resolves via the bot's `users` table if the user
 *     ever DM'd the bot; otherwise fails with a helpful message
 *   - reply-to: if the command is a reply to a message, use that
 *     message's sender. Convenient for "unban this person right here".
 */
async function resolveUserRef(ctx, arg) {
  // Reply-to wins if present
  if (ctx.message?.reply_to_message?.from?.id) {
    return { userId: ctx.message.reply_to_message.from.id, label: ctx.message.reply_to_message.from.username || ctx.message.reply_to_message.from.first_name };
  }
  if (!arg) return { error: "no user specified" };
  const trimmed = arg.trim();
  // Numeric user_id
  if (/^\d{4,}$/.test(trimmed)) {
    return { userId: Number(trimmed), label: trimmed };
  }
  // @username form
  const usernameMatch = trimmed.match(/^@?([A-Za-z0-9_]{4,32})$/);
  if (usernameMatch) {
    const handle = usernameMatch[1].toLowerCase();
    try {
      const { rows } = await (await import("../db/pool.js")).query(
        `SELECT telegram_id FROM users WHERE LOWER(telegram_username) = $1 LIMIT 1`,
        [handle],
      );
      if (rows[0]?.telegram_id) {
        return { userId: Number(rows[0].telegram_id), label: `@${handle}` };
      }
      return {
        error:
          `Couldn't resolve @${handle} from the bot's user records (they may not have ever started the wallet bot). ` +
          `Open the group's removed-users list in TG and use the numeric user_id, OR ask the user to /start @magpie_capital_bot once and re-run this command.`,
      };
    } catch (err) {
      return { error: `Lookup error: ${err.message}` };
    }
  }
  return { error: "expected a numeric user_id or @username" };
}

export async function handleCommunityUnban(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply(
      "Run `/unban` *inside* the community group whose user you want to unban (not in DM).",
      { parse_mode: "Markdown" },
    );
  }
  const arg = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  const ref = await resolveUserRef(ctx, arg);
  if (ref.error) {
    return ctx.reply(`❌ ${ref.error}`);
  }
  try {
    // unbanChatMember will not auto-readd them — they need to rejoin
    // via the group link. only_if_banned avoids errors when the user
    // wasn't actually banned (e.g. they just left).
    await ctx.api.unbanChatMember(ctx.chat.id, ref.userId, { only_if_banned: false });
    // Optional: also clear their strike history so they truly start fresh.
    const { clearStrikes } = await import("../services/community-strikes.js");
    const cleared = await clearStrikes(ctx.chat.id, ref.userId);
    // Pip's memory: remember this clearance so the name-ban / captcha-kick /
    // watchdog don't immediately re-remove them on their next message.
    await markUserCleared(ctx.chat.id, ref.userId, "operator_unban", `manual /unban by operator`);
    await ctx.reply(
      `✅ Unbanned ${ref.label} (user ${ref.userId}). Cleared ${cleared} prior strike(s) + added to Pip's cleared list so they won't be auto-removed for their name again.\n\n` +
      `They'll need to *re-join via the group invite link*. Consider sending it to them.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    await ctx.reply(`❌ Unban failed: ${err.message?.slice(0, 200)}`);
  }
}

export async function handleCommunityStrikes(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const arg = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  const ref = await resolveUserRef(ctx, arg);
  if (ref.error) return ctx.reply(`❌ ${ref.error}`);
  const { countStrikes, listRecentStrikes, isTrustedMember } = await import("../services/community-strikes.js");
  const inThisChat = isGroup(ctx) ? await countStrikes(ctx.chat.id, ref.userId) : null;
  const recent = await listRecentStrikes(ref.userId, 90);
  const trusted = await isTrustedMember(ref.userId);
  const lines = [
    `📋 *Strike report* for ${ref.label} (user ${ref.userId})`,
    ``,
    trusted ? `🦅 Trusted member (has a Magpie wallet) — gets a one-strike grace.` : `Untrusted — full strike scale applies.`,
    inThisChat != null ? `In this chat (last 30d): *${inThisChat}* strike(s)` : null,
    ``,
    `*Last 90 days across all chats:*`,
  ].filter(Boolean);
  if (recent.length === 0) {
    lines.push(`  (no strike history)`);
  } else {
    for (const r of recent.slice(0, 15)) {
      const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
      lines.push(`  • ${when} — ${r.action} — ${(r.reason || "").slice(0, 60)}`);
    }
    if (recent.length > 15) lines.push(`  • + ${recent.length - 15} more`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

export async function handleCommunityClearStrikes(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!isGroup(ctx)) {
    return ctx.reply("Run inside the group whose strike history you want to clear.");
  }
  const arg = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  const ref = await resolveUserRef(ctx, arg);
  if (ref.error) return ctx.reply(`❌ ${ref.error}`);
  const { clearStrikes } = await import("../services/community-strikes.js");
  const n = await clearStrikes(ctx.chat.id, ref.userId);
  await ctx.reply(`✅ Cleared ${n} strike(s) for ${ref.label}. They start fresh.`);
}

/* ──────────────── /crosspost — operator: post a @MagpieLoans tweet to the community ──────────────── */

export async function handleCommunityCrosspost(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const arg = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  if (!arg) {
    return ctx.reply(
      "Usage: `/crosspost <tweet-url>` — any https://x.com/<handle>/status/... URL (Magpie's or anyone's).\n\n" +
      "Posts the tweet to every enabled community chat with a Pip-flavored engagement prompt. " +
      "Telegram's OG-card preview renders the tweet content inline automatically.",
      { parse_mode: "Markdown" },
    );
  }
  try {
    const { crosspostTweet } = await import("../services/community-x-crosspost.js");
    const result = await crosspostTweet(ctx.api, arg, "manual");
    if (result.skipped) {
      return ctx.reply(`ℹ️ Already cross-posted (reason: ${result.reason}). Use /clear_crosspost_cache if you need to repost.`);
    }
    return ctx.reply(`✅ Cross-posted to ${result.chats} community chat(s).`);
  } catch (err) {
    return ctx.reply(`❌ Cross-post failed: ${err.message?.slice(0, 200)}`);
  }
}
