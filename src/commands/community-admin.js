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
  "*$MAGPIE token*",
  "• `/ca`      — contract address (copy-paste safe)",
  "• `/magpie`  — token details + holder benefits",
  "• `/buy`     — how to buy",
  "• `/chart`   — DEXScreener / Birdeye / Pump.fun",
  "• `/holders` — $MAGPIE holder rewards (10% of fees)",
  "*Get involved*",
  "• `/refer`   — earn 5% of friends' loan fees, lifetime",
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
