/**
 * Community-moderation TG event handlers.
 *
 * Registers with the bot to listen for:
 *   - new_chat_members → quarantine + DM-captcha
 *   - chat:message (text + caption) → URL filter, impersonation, scam pattern
 *   - message edits → re-check links (edit-to-insert-scam-link is common)
 *   - callback "comm:captcha:pass" → mark captcha passed
 *
 * Critically: every handler short-circuits when:
 *   - the chat isn't a group/supergroup
 *   - the chat isn't in community_chats with enabled=TRUE
 *   - the actor IS the bot itself or an admin / operator
 *
 * Fail-open semantics: any throw inside a handler is caught and
 * logged. Default to "let the message through" rather than blocking.
 */
import { InlineKeyboard } from "grammy";
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";
import {
  isChatEnabled,
  isVerifiedAccount,
  isImpersonationName,
  matchesScamPattern,
  matchesDmSolicitation,
  findImpersonatingHandles,
  extractUrls,
  isAllowedUrl,
  recordNewMember,
  getMember,
  markCaptchaPassed,
  touchLastMessage,
  inQuarantine,
  quarantineRateLimit,
  bumpWarnedCount,
  recordModAction,
  markUserCleared,
  isUserCleared,
  nameKey,
  CAPTCHA_TIMEOUT_MS,
} from "../services/community-moderation.js";
import { classifyImage, actionForImageVerdict } from "../services/community-image-ocr.js";
import {
  judgeCommunityPost,
  hasSolicitationSignal,
  isConfidentRemoval,
  HARD_SCAM_RE,
} from "../services/community-intent-classifier.js";
import { findUserByTelegramId } from "../services/users.js";

/**
 * Escape Telegram legacy-Markdown control chars before injecting any
 * user-controlled string (username, first_name, message body) into an
 * operator alert that uses parse_mode: "Markdown". A username like
 * `@user_with_underscores` would otherwise render as italic, and a
 * malicious first_name with backticks could smuggle code blocks. The
 * operator is the only audience here, but ugly DMs are annoying and
 * a hostile actor could exploit Markdown parsing edge cases to hide
 * parts of a flag message from the operator's eye. Defensive escape
 * fixes all of that.
 */
function escMd(s) {
  if (s == null) return "";
  return String(s).replace(/([_*`\[\]()])/g, "\\$1");
}

/**
 * Trusted members are TG users who already have a Magpie wallet through
 * the bot. They're known good actors — auto-muting them on a misread is
 * the worst outcome. We DOWNGRADE any mute action against a trusted
 * member to a delete + warn + operator flag, and leave the human call
 * to the operator. Deletion of the offending message still happens —
 * it's mute / restrict that we skip.
 *
 * Op directive: "use your best judgement when removing members.
 * Sometimes a good member's post may be misinterpreted. I don't want
 * Pip to penalize them." This is the leniency tier that implements
 * that judgement.
 */
async function isTrustedMember(telegramId) {
  if (!telegramId) return false;
  try {
    const user = await findUserByTelegramId(telegramId);
    // Any row in `users` means they've /start'd the bot and have a
    // wallet. That's the bar — a real Magpie user, not a drive-by.
    return !!user;
  } catch (err) {
    console.warn("[community] trusted-member lookup failed (default: not trusted):", err.message);
    return false;
  }
}

/**
 * Apply the trusted-member leniency override to a decision returned
 * by the FUD or image classifier. If the user is trusted, any mute is
 * stripped — we still delete + warn + flag the operator, but we never
 * auto-restrict them.
 */
function applyTrustedLeniency(decision, trusted) {
  if (!trusted) return decision;
  if (decision.mute_sec > 0) {
    return {
      ...decision,
      mute_sec: 0,
      flag_operator: true, // always alert operator on trusted-member edge cases
      _trusted_downgrade: true,
    };
  }
  return decision;
}

function isGroupChat(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

async function isChatAdmin(ctx, userId) {
  try {
    const m = await ctx.api.getChatMember(ctx.chat.id, userId);
    return m.status === "administrator" || m.status === "creator";
  } catch {
    return false;
  }
}

/** Soft warning DM. If the user blocks the bot, falls back silent. */
async function softWarn(ctx, userId, msg, replyMarkup) {
  // The whole point of a soft-warn is that the user LEARNS why their message
  // was actioned — so delivery must be reliable. Try Markdown for nice
  // formatting; if the body has a stray markup char that 400s the parse, retry
  // as plain text so the notice ALWAYS lands. Only a hard block (user never
  // started the bot) is allowed to silently drop.
  const base = { disable_web_page_preview: true };
  if (replyMarkup) base.reply_markup = replyMarkup;
  try {
    await ctx.api.sendMessage(userId, msg, { ...base, parse_mode: "Markdown" });
  } catch (e1) {
    try {
      await ctx.api.sendMessage(userId, msg, base);
    } catch { /* user blocked bot / never opened DM — nothing we can do */ }
  }
}

/** Inline keyboard offering a one-tap appeal that Pip reviews. The button
 *  carries the originating mod-action id so the callback can pull full
 *  context. Only attached to actions that actually restrict the user. */
function appealKeyboard(modActionId) {
  if (!modActionId) return undefined;
  return new InlineKeyboard().text("⚖️ Appeal this decision", `appeal:${modActionId}`);
}

/* ────────────────── NEW MEMBER HANDLER ───────────────────── */

async function handleNewMembers(ctx) {
  try {
    if (!isGroupChat(ctx)) return;
    if (!(await isChatEnabled(ctx.chat.id))) return;
    const newMembers = ctx.message?.new_chat_members || [];
    for (const m of newMembers) {
      // Skip the bot itself joining
      if (m.is_bot && m.username === ctx.me?.username) continue;
      await recordNewMember(ctx.chat.id, m.id);

      // Pip's memory: a previously-cleared member (same name) rejoining via
      // their appeal invite is not re-shamed on join or captcha-kicked again.
      if (await isUserCleared(ctx.chat.id, m.id, nameKey(m))) continue;

      // Impersonation check on join — BAN immediately, don't just warn.
      // Impersonation IS the attack (there's no legitimate reason to join
      // named "Magpie Matt" / "Mapgie Support"), so we remove them BEFORE
      // they can post a single scam message — closing the join→first-post
      // window (and the case where the bot misses the first message during a
      // restart). Verified accounts + appeal-cleared users are already exempt
      // (isVerifiedAccount here; isUserCleared checked at the top of the loop).
      // False positives recover instantly via the /appeal path in softWarn.
      if (isImpersonationName(m) && !isVerifiedAccount(m)) {
        try { await ctx.api.banChatMember(ctx.chat.id, m.id); }
        catch (err) { console.warn("[community] impersonator join-ban failed:", err.message); }
        await recordModAction(
          ctx.chat.id, m.id, "ban_impersonator_join",
          "name matches impersonation pattern (banned on join)",
          JSON.stringify({ username: m.username, first: m.first_name, last: m.last_name }),
        );
        await softWarn(
          ctx, m.id,
          `You were removed from the Magpie community because your name matched our Magpie-staff impersonation filter.\n\n` +
          `If you're a real member and this was a mistake, reply /appeal and Pip will review it instantly and let you back in if it was wrong.`,
        );
        try {
          const { notifyAdmin } = await import("../services/admin-notify.js");
          await notifyAdmin(
            { api: ctx.api },
            `🛡 *Magpie impersonator banned on JOIN*\n\n` +
            `*Name:* ${m.username ? `@${m.username}` : (m.first_name || m.id)}\n` +
            `*ID:* \`${m.id}\`\n\n` +
            `Removed before they could post. \`/unban ${m.id}\` if a false positive.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* silent */ }
        continue; // banned — don't captcha-challenge them
      }

      // Captcha. Post it IN THE GROUP so the new member can actually SEE
      // and pass it. Most new joiners have NOT started the bot, so a
      // DM-only captcha silently fails (dmFailed) and they get booted
      // having never seen a captcha — the #1 false-kick / churn source and
      // exactly why real users complain they "got kicked for no reason."
      // The button is scoped to THIS user's id so only they can pass it;
      // we auto-delete it on pass/timeout to keep the group tidy. A DM is
      // still attempted as a bonus for users who have started the bot.
      const escHtml = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      const kb = new InlineKeyboard()
        .text("✅ I'm not a bot", `comm:captcha:${ctx.chat.id}:${m.id}`);
      const mins = CAPTCHA_TIMEOUT_MS / 60000;
      const mention = `<a href="tg://user?id=${m.id}">${escHtml(m.first_name || m.username || "there")}</a>`;
      const groupCaptcha =
        `👋 Welcome ${mention}! Tap "✅ I'm not a bot" within ${mins} min to verify you're human and start chatting — this just keeps scammers out.`;
      const dmCaptcha =
        `👋 Welcome to the Magpie group.\n\nTap the button below within ${mins} minutes to verify you're human. If you miss it you'll be briefly removed and can rejoin any time.`;

      let groupPosted = false;
      try {
        const sent = await ctx.api.sendMessage(ctx.chat.id, groupCaptcha, {
          reply_markup: kb,
          parse_mode: "HTML",
          reply_to_message_id: ctx.message?.message_id,
        });
        captchaGroupMsgs.set(kickKey(ctx.chat.id, m.id), sent.message_id);
        groupPosted = true;
      } catch (err) {
        console.warn("[community] in-group captcha post failed:", err.message);
      }
      let dmOk = false;
      try {
        await ctx.api.sendMessage(m.id, dmCaptcha, { reply_markup: kb });
        dmOk = true;
      } catch { /* expected for users who haven't started the bot */ }

      // Fail-OPEN: only schedule a kick if the member actually had a way to
      // see the captcha (in-group post or a delivered DM). If we couldn't
      // reach them at all, booting them is hostile and pointless — message
      // moderation + the impersonator ban still cover real abuse. Growing
      // the community beats over-zealous gatekeeping.
      if (groupPosted || dmOk) {
        scheduleCaptchaKick(ctx, m.id, !dmOk);
      } else {
        console.warn(`[community] captcha unreachable for ${m.id} — failing open (no kick).`);
      }
    }
  } catch (err) {
    console.warn("[community] new-member handler failed (fail-open):", err.message);
  }
}

// In-memory map of pending captcha kicks. Lives only as long as the
// bot process — that's fine. New members on a restart would just need
// to re-join. Memory-bounded by Set of timers we clear after firing.
const pendingKicks = new Map(); // key: `${chatId}:${userId}` → timeout
// In-group captcha message ids, so we can delete the captcha post once the
// member passes or is timed out — keeps the group clean. key → message_id.
const captchaGroupMsgs = new Map();

function kickKey(chatId, userId) { return `${chatId}:${userId}`; }

/** Delete the in-group captcha post for a member (best-effort, idempotent). */
async function clearGroupCaptcha(api, chatId, userId) {
  const key = kickKey(chatId, userId);
  const msgId = captchaGroupMsgs.get(key);
  if (msgId == null) return;
  captchaGroupMsgs.delete(key);
  try { await api.deleteMessage(chatId, msgId); } catch { /* already gone */ }
}

function scheduleCaptchaKick(ctx, userId, dmFailed) {
  const key = kickKey(ctx.chat.id, userId);
  if (pendingKicks.has(key)) clearTimeout(pendingKicks.get(key));
  const timeout = setTimeout(async () => {
    pendingKicks.delete(key);
    try {
      const member = await getMember(ctx.chat.id, userId);
      if (member?.captcha_passed_at) { await clearGroupCaptcha(ctx.api, ctx.chat.id, userId); return; } // passed
      // Pip's memory: a previously-cleared member (appeal / operator unban)
      // who rejoined is not re-kicked for missing the captcha.
      if (await isUserCleared(ctx.chat.id, userId)) { await clearGroupCaptcha(ctx.api, ctx.chat.id, userId); return; }
      // Kick the captcha-misser but DO NOT leave them banned — a real member
      // who missed it must be able to rejoin and retry. CRITICAL BUG (fixed
      // 2026-06-30): a short until_date is unsafe — Telegram treats a ban of
      // < 30s (or > 366 days) as PERMANENT, so the old `now + 30` silently
      // PERMABANNED users under any processing latency (it false-permabanned 11
      // real members, incl. @Jmackbjm). Ban-then-unban is the reliable "kick":
      // it removes them with NO lingering ban so the invite link works on retry.
      await ctx.api.banChatMember(ctx.chat.id, userId);
      await ctx.api.unbanChatMember(ctx.chat.id, userId, { only_if_banned: true });
      await clearGroupCaptcha(ctx.api, ctx.chat.id, userId);
      await recordModAction(
        ctx.chat.id, userId, "kick_captcha_timeout",
        dmFailed ? "no_dm_response (DM blocked)" : "captcha not solved in time",
        null,
      );
    } catch (err) {
      console.warn("[community] captcha kick failed:", err.message);
    }
  }, CAPTCHA_TIMEOUT_MS);
  pendingKicks.set(key, timeout);
}

/* ────────────────── CAPTCHA CALLBACK ─────────────────────── */

async function handleCaptchaCallback(ctx) {
  try {
    const data = ctx.callbackQuery.data; // "comm:captcha:<chat_id>[:<user_id>]"
    const m = data.match(/^comm:captcha:(-?\d+)(?::(\d+))?$/);
    if (!m) return;
    const chatId = m[1];
    const targetUserId = m[2] ? Number(m[2]) : null;
    const userId = ctx.callbackQuery.from.id;
    // The in-group captcha is scoped to one specific new member — only THEY
    // can pass it. If another member taps it, gently decline (don't pass them,
    // and crucially don't cancel/trigger anyone's kick).
    if (targetUserId != null && userId !== targetUserId) {
      try { await ctx.answerCallbackQuery({ text: "This welcome check isn't for you 🙂", show_alert: false }); } catch { /* silent */ }
      return;
    }
    await markCaptchaPassed(chatId, userId);
    const key = kickKey(chatId, userId);
    if (pendingKicks.has(key)) {
      clearTimeout(pendingKicks.get(key));
      pendingKicks.delete(key);
    }
    await clearGroupCaptcha(ctx.api, chatId, userId);
    await ctx.answerCallbackQuery({
      text: "Welcome to Magpie! You can chat in the group now.",
      show_alert: false,
    });
    // Edit the captcha message to reflect success
    try {
      await ctx.editMessageText("✅ You're verified. Head back to the Magpie group to chat.");
    } catch { /* edit might fail if msg was deleted — silent */ }
    await recordModAction(chatId, userId, "captcha_pass", null, null);

    // Warm welcome — sent PRIVATELY to the new member (operator 2026-06-30:
    // no longer broadcast to the whole group, which was noise for everyone
    // else). The user already saw the per-user pass toast above; this DM is a
    // bonus greeting and silently skips if they haven't started the bot.
    try {
      const { postCaptchaWelcome } = await import("../services/community-proactive.js");
      await postCaptchaWelcome(ctx.api, chatId, ctx.callbackQuery.from);
    } catch (err) {
      console.warn("[community] welcome DM failed (non-critical):", err.message);
    }
  } catch (err) {
    console.warn("[community] captcha callback failed:", err.message);
    try { await ctx.answerCallbackQuery({ text: "Something went wrong — try again.", show_alert: true }); } catch { /* silent */ }
  }
}

/* ────────────────── MESSAGE HANDLER ───────────────────────── */

async function handleGroupMessage(ctx) {
  try {
    if (!isGroupChat(ctx)) return;
    if (!(await isChatEnabled(ctx.chat.id))) return;
    const msg = ctx.message || ctx.editedMessage;
    if (!msg) return;
    const sender = msg.from;
    if (!sender) return;

    // Skip the bot itself
    if (sender.id === ctx.me?.id) return;

    // ── Public utility commands (ZERO LLM cost) ────────────────
    // /stats /tiers /fees /how /tokens — templated or DB-driven.
    // Runs BEFORE Pip Q&A so the cheap path always wins. Returning
    // true short-circuits everything below including the LLM call.
    {
      const { maybeHandlePublicCommand } = await import("../services/community-public-cmds.js");
      if (await maybeHandlePublicCommand(ctx, msg)) return;
    }

    // ── Pip Q&A trigger ────────────────────────────────────────
    // Triggers (any one):
    //   1. Message starts with /ask
    //   2. Message mentions the bot by @username
    //   3. Message is a reply to a previous bot message
    // We run this BEFORE the admin-skip below so even admins can /ask
    // and get a public answer (helps demo the feature in-group).
    if (await maybeAnswerPipQuestion(ctx, msg, sender)) return;

    // Skip operator / chat admins
    if (isVerifiedAccount(sender)) return;
    if (await isChatAdmin(ctx, sender.id)) return;

    // ── IMPERSONATOR AUTO-BAN ───────────────────────────────
    // Operator-approved policy 2026-06-07: any user whose display name
    // or username impersonates Magpie (contains "magpie" anywhere, or
    // is named "Support"/"Admin"/"Team"/"Moderator"/etc.) gets their
    // message deleted AND they get banned from the group. No grace,
    // no strike ladder.
    //
    // Why this overrides the "never auto-ban" rule in
    // project_magpie_strike_policy.md: impersonation IS the entire
    // attack. Anyone naming themselves "Magpie Matt" in @magpietalk
    // is doing it to deceive — there's no legitimate use case. The
    // operator (verified-account) and existing admins are exempt
    // above, so this rule cannot accidentally hit Magpie's own team.
    //
    // Operator gets paged so they can /unban if it's a false positive
    // (e.g., a real user named "MagpieFan42"). False-positive recovery
    // is one tap; the cost of letting a scammer linger is much higher.
    // Pip's MEMORY: a user already cleared by an appeal (or operator /unban)
    // is never re-banned for their name — otherwise re-admitting them would be
    // pointless (they'd be banned again on their next message). Name-scoped:
    // if a cleared user RENAMES into a fresh impersonation pattern, the
    // clearance no longer applies and the ban fires.
    if (isImpersonationName(sender) && !(await isUserCleared(ctx.chat.id, sender.id, nameKey(sender)))) {
      await tryDelete(ctx, msg.message_id);
      try {
        await ctx.api.banChatMember(ctx.chat.id, sender.id);
      } catch (err) {
        console.warn("[community] impersonator ban failed:", err.message);
      }
      await recordModAction(
        ctx.chat.id, sender.id, "ban_impersonator",
        `name="${sender.username || sender.first_name || sender.id}"`,
        msg.text || msg.caption || null,
      );
      // Best-effort: tell the banned user how to appeal. Most impersonators
      // never started the bot so this silently no-ops, but a real member
      // caught by mistake gets an instant path back. softWarn handles the
      // "user hasn't DM'd the bot" case gracefully.
      await softWarn(
        ctx, sender.id,
        `You were removed from the Magpie community because your name matched our Magpie-staff impersonation filter.\n\n` +
        `If you're a real member and this was a mistake, reply with /appeal and Pip will review it instantly and let you back in if it was wrong.`,
      );
      // Educational moment — turn every ban into a teachable post in
      // the group so members see Pip actively defending them. Templated
      // (zero LLM cost), throttled per chat so we don't spam during a
      // bot-driven scam wave.
      try {
        const { maybePostScamBanEducation } = await import("../services/community-proactive.js");
        await maybePostScamBanEducation(ctx.api, ctx.chat.id);
      } catch (err) {
        console.warn("[community] scam-ban education post failed:", err.message);
      }
      try {
        const { notifyAdmin } = await import("../services/admin-notify.js");
        await notifyAdmin(
          { api: ctx.api },
          `🛡 *Magpie impersonator banned*\n\n` +
          `*Name:* ${sender.username ? `@${sender.username}` : (sender.first_name || sender.id)}\n` +
          `*ID:* \`${sender.id}\`\n` +
          `*Their message:* ${(msg.text || msg.caption || "(no text)").slice(0, 300)}\n\n` +
          `Auto-deleted + auto-banned. If this is a false positive ` +
          `(real user named something like "MagpieFan"), run ` +
          `\`/unban ${sender.id}\` in the group.`,
          { parse_mode: "Markdown" },
        );
      } catch (err) {
        console.warn("[community] impersonator alert failed:", err.message);
      }
      return;
    }

    // ── Links are no longer auto-deleted ────────────────────
    // A non-allowlisted link is now just ONE signal into Pip's judgement
    // block below — a real user asking "are you on the App Store? <link>"
    // must never be removed merely for including a link. (operator
    // 2026-06-30: "we cant just delete their posts or boot them.")

    // ── Screenshot + "DM me" → PERMANENT BAN (operator-mandated 2026-06-30) ──
    // A photo whose caption solicits a DM ("DM me to claim", "message admin")
    // is the canonical screenshot-phishing setup: an image for credibility +
    // a redirect to a scammer DM. Unlike a plain-text "DM me" (deleted + warned
    // below), the screenshot form is a deliberate scam → delete + PERMANENT
    // ban. (In-image text with no caption is caught by the vision classifier.)
    {
      const hasImage = !!(msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || "")));
      const dmSolicit = hasImage ? matchesDmSolicitation(msg.caption || msg.text || "") : null;
      if (dmSolicit && !(await isUserCleared(ctx.chat.id, sender.id, nameKey(sender)))) {
        await tryDelete(ctx, msg.message_id);
        try { await ctx.api.banChatMember(ctx.chat.id, sender.id); }
        catch (err) { console.warn("[community] screenshot-DM ban failed:", err.message); }
        await recordModAction(
          ctx.chat.id, sender.id, "ban_screenshot_dm_solicitation",
          dmSolicit, msg.caption || msg.text || null,
        );
        await softWarn(
          ctx, sender.id,
          `You were removed from the Magpie community for posting a screenshot soliciting DMs — a classic phishing pattern. If this was a genuine mistake, reply /appeal and Pip will review it.`,
        );
        try {
          const { notifyAdmin } = await import("../services/admin-notify.js");
          await notifyAdmin(
            { api: ctx.api },
            `🛡 *Screenshot-DM scammer banned*\n\n` +
            `*Name:* ${sender.username ? `@${sender.username}` : (sender.first_name || sender.id)}\n` +
            `*ID:* \`${sender.id}\`\n` +
            `*Caption:* ${(msg.caption || msg.text || "(none)").slice(0, 200)}\n\n` +
            `Auto-deleted + banned. \`/unban ${sender.id}\` if a false positive.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* silent */ }
        return;
      }
    }

    // ── Pip's judgement on flagged content (operator 2026-06-30) ──
    // Coarse signals — a non-allowlisted link, scam-shaped phrasing, an
    // unofficial Magpie handle, or service-solicitation markers — DO NOT
    // auto-delete. They only FLAG the post; Pip then judges whether it's a
    // genuine user (question / idea / interest / criticism → KEEP) or a
    // scam / solicitation (→ remove). Operator mandate, verbatim: "if they
    // are asking clear questions or giving ideas or showing interest in
    // the Magpie platform, we cant just delete their posts or boot them.
    // Pip really needs to use their best judgement with every single post."
    {
      const bodyText = msg.text || msg.caption || "";
      const badUrls = extractUrls(msg).filter((u) => !isAllowedUrl(u));
      const scamHit = matchesScamPattern(bodyText);
      const handleHits = findImpersonatingHandles(bodyText);
      const solicits = hasSolicitationSignal(bodyText);
      const flagged = badUrls.length || scamHit || handleHits.length || solicits;

      if (flagged && !(await isUserCleared(ctx.chat.id, sender.id, nameKey(sender)))) {
        const signalParts = [];
        if (badUrls.length) signalParts.push(`link not on allowlist: ${badUrls.join(", ").slice(0, 180)}`);
        if (scamHit) signalParts.push(`scam-phrase: ${scamHit}`);
        if (handleHits.length) signalParts.push(`unofficial handle: ${handleHits.join(", ")}`);
        if (solicits) signalParts.push(`possible solicitation`);

        const member = await getMember(ctx.chat.id, sender.id);
        const memberAgeHours = member?.joined_at
          ? (Date.now() - new Date(member.joined_at).getTime()) / 3_600_000
          : null;

        const verdict = await judgeCommunityPost(bodyText, {
          signal: signalParts.join(" · "),
          member_age_hours: memberAgeHours,
          has_link: badUrls.length > 0,
        });

        // Heavy ALLOW bias. On LLM failure (verdict == null) fail OPEN
        // (keep) for soft signals; fail CLOSED (remove) ONLY for an
        // unambiguous hard-scam phrase, which a real user essentially never
        // types — so a wallet-drainer can't slip through during an LLM
        // outage, yet a genuine post is never deleted on uncertainty.
        const remove = verdict
          ? isConfidentRemoval(verdict)
          : HARD_SCAM_RE.test(bodyText);

        if (remove) {
          await tryDelete(ctx, msg.message_id);
          const cat = verdict?.category || (scamHit ? "scam" : solicits ? "solicitation" : "scam");
          await recordModAction(
            ctx.chat.id, sender.id, `judge_remove_${cat}`,
            `${verdict ? `conf=${verdict.confidence.toFixed(2)} · ${verdict.reason}` : "LLM down → hard-scam fallback"} · ${signalParts.join(" · ")}`,
            bodyText.slice(0, 500),
          );
          const count = await bumpWarnedCount(ctx.chat.id, sender.id);
          const isSolicit = cat === "solicitation" || cat === "spam";
          const notice = isSolicit
            ? `Hey — your message was removed because it read as solicitation/promotion (offering services, shilling another project, etc.), which we keep out of the group. Genuine questions and ideas about Magpie are always welcome — feel free to ask! 🙂`
            : `Hey — your message was removed because it matched a scam/phishing pattern we filter (seed-phrase or private-key asks, "DM me to claim", fake airdrops, drainer links, etc.). If that was a genuine misunderstanding, just rephrase — real questions are always welcome. 🙂`;
          await softWarn(
            ctx, sender.id,
            notice + (count >= 3 ? `\n\n(Heads up: warning #${count} — repeated removals may lead to a temporary mute.)` : ``),
          );
          return; // removed; skip remaining checks
        }

        // KEPT — log Pip's rescue so the operator can see judgement at work.
        await recordModAction(
          ctx.chat.id, sender.id, "judge_keep",
          `${verdict ? `${verdict.category} · conf=${verdict.confidence.toFixed(2)} · ${verdict.reason}` : "LLM unavailable → kept (favor the user)"} · ${signalParts.join(" · ")}`,
          bodyText.slice(0, 300),
        );
      }
    }

    // (Verbal handle impersonation — e.g. "DM @MagpieSupport for help" —
    // is now folded into the Pip-judgement block above: findImpersonatingHandles
    // is one of the signals it weighs, so a scam handle is removed while a
    // legit cross-mention like "@MagpieLoans posted X" is kept.)

    // ── Impersonation (re-check per-message in case they rename) ─
    if (isImpersonationName(sender)) {
      await recordModAction(ctx.chat.id, sender.id, "flag_impersonation_msg", "name pattern", sender.username || sender.first_name || "");
      // Don't delete here — naming alone isn't a scam, but tag so
      // the operator anomaly report shows it.
    }

    // ── Quarantine rules ────────────────────────────────────
    if (await inQuarantine(ctx.chat.id, sender.id)) {
      // No images / forwards / extra links during quarantine
      if (msg.forward_origin || msg.photo || msg.video || msg.animation) {
        await tryDelete(ctx, msg.message_id);
        await recordModAction(ctx.chat.id, sender.id, "delete_quarantine_media", "media/forward during quarantine", null);
        await softWarn(
          ctx,
          sender.id,
          `Heads up — new members can't post images / videos / forwards for the first 7 days. This is to keep scammers out. Plain-text messages still work.`,
        );
        return;
      }
      // Rate limit
      const wait = await quarantineRateLimit(ctx.chat.id, sender.id);
      if (wait > 0) {
        await tryDelete(ctx, msg.message_id);
        await recordModAction(ctx.chat.id, sender.id, "delete_quarantine_rate", `wait_ms=${wait}`, null);
        return;
      }
    }

    // ── Captcha auto-pass on genuine activity (operator 2026-06-30) ──
    // The message survived every removal gate above, so it's a real,
    // non-scam post. A human who actually chats has proven they're human
    // far better than a button tap — so if a captcha kick is still pending
    // for this user, cancel it. We NEVER boot someone for asking a question
    // or sharing an idea. ("my chat keeps getting removed" was a brand-new
    // member kicked by the 5-min captcha timer before they tapped verify.)
    try {
      const pendingKey = kickKey(ctx.chat.id, sender.id);
      if (pendingKicks.has(pendingKey)) {
        clearTimeout(pendingKicks.get(pendingKey));
        pendingKicks.delete(pendingKey);
        await markCaptchaPassed(ctx.chat.id, sender.id);
        await clearGroupCaptcha(ctx.api, ctx.chat.id, sender.id);
        await recordModAction(ctx.chat.id, sender.id, "captcha_pass_via_message", "genuine message = proof of human", null);
      }
    } catch (err) {
      console.warn("[community] captcha auto-pass-on-message failed (non-critical):", err.message);
    }

    // ── Image vision classifier ─────────────────────────────────
    // If the message includes a photo (or image-document), run it
    // through Haiku vision to catch screenshot-based scams,
    // impersonation, and FUD that the text pipeline would miss.
    // Same conservative bar as the text classifier (0.75 confidence,
    // never auto-bans). Skips silently on any failure (fail-open).
    if (msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || ""))) {
      await maybeRunImageCheck(ctx, msg, sender);
      // maybeRunImageCheck deletes the message if it took action,
      // so if we reach the next line, the image was either OK or the
      // classifier failed. Either way, run subsequent checks normally
      // (text caption may still trigger the FUD classifier below).
    }

    // ── FUD / bad-intent classifier ─────────────────────────────
    // Runs ONLY when the message contains a negative-sentiment marker
    // (scam/rug/fake/etc) — that pre-filter keeps LLM cost on ~5-10%
    // of group messages instead of 100%. Conservative by design:
    // confidence below 0.75 → no action. "criticism" → never acted on.
    await maybeRunFudCheck(ctx, msg, sender);

    // ── Proactive Pip: track public questions ───────────────────
    // Two flows, both cheap (no LLM cost here):
    //   (a) If this message looks like a Magpie-relevant question,
    //       record it as a candidate for proactive answering later.
    //   (b) If it's a reply to a previous message that's in our
    //       pending-questions table, mark that question "answered by
    //       chat" so Pip doesn't double-up. Reply tracking is what
    //       prevents Pip from talking over a human who already helped.
    try {
      const { trackInboundForProactivePip, noteCommunityActivity, noteHumanActivity } = await import("../services/community-proactive.js");
      await trackInboundForProactivePip(ctx.chat.id, msg, sender);
      noteCommunityActivity(ctx.chat.id);
      // Vibe poster reads this to back off when humans are chatting
      noteHumanActivity(ctx.chat.id);
    } catch (err) {
      console.warn("[community] proactive-track failed (non-critical):", err.message);
    }

    // Touch last_message_at for rate-limit tracking
    await touchLastMessage(ctx.chat.id, sender.id);
  } catch (err) {
    console.warn("[community] message handler failed (fail-open):", err.message);
  }
}

/** Conservative image classifier — runs Haiku vision on photos /
 *  image-documents to catch screenshot scams that the text pipeline
 *  would miss. Same 0.75 confidence floor and never auto-permabans. */
async function maybeRunImageCheck(ctx, msg, sender) {
  const result = await classifyImage(ctx, msg);
  if (!result) return; // fail-open: classifier unavailable or returned nothing

  // Classifier decides "is this image policy-violating" (verdict +
  // confidence); strike policy decides the escalation level. Same
  // pattern as the text/FUD path.
  const member = await getMember(ctx.chat.id, sender.id);
  const trusted = await isTrustedMember(sender.id);

  // Operator-mandated 2026-06-30: a HIGH-confidence phishing / Magpie-
  // impersonation screenshot (e.g. a "DM me to claim" solicitation INSIDE the
  // image) is a deliberate scam → delete + PERMANENT ban, bypassing the strike
  // ladder. Conservative bar: confidence >= 0.95 AND not a trusted member (real
  // borrowers fall through to delete + warn), so a vision misread can't ban a
  // genuine user; /unban recovers a false positive either way.
  if (!trusted && result.confidence >= 0.95 &&
      (result.verdict === "scam_screenshot" || result.verdict === "impersonation_screenshot")) {
    await tryDelete(ctx, msg.message_id);
    try { await ctx.api.banChatMember(ctx.chat.id, sender.id); }
    catch (err) { console.warn("[image-mod] screenshot scam ban failed:", err.message); }
    await recordModAction(
      ctx.chat.id, sender.id, `ban_image_${result.verdict}`,
      `confidence=${result.confidence.toFixed(2)} reason=${result.reason}`,
      result.extractedText?.slice(0, 500) || null,
    );
    await softWarn(
      ctx, sender.id,
      `You were removed from the Magpie community — your image was flagged as a phishing / impersonation screenshot. If this was a genuine mistake, reply /appeal and Pip will review it.`,
    );
    try {
      const { notifyAdmin } = await import("../services/admin-notify.js");
      await notifyAdmin(
        { api: ctx.api },
        `🛡 *Scam-screenshot scammer banned* (vision ${result.confidence.toFixed(2)})\n\n` +
        `*Name:* ${sender.username ? `@${sender.username}` : (sender.first_name || sender.id)}\n` +
        `*ID:* \`${sender.id}\`\n*Verdict:* ${result.verdict}\n\n` +
        `Auto-deleted + banned. \`/unban ${sender.id}\` if a false positive.`,
        { parse_mode: "Markdown" },
      );
    } catch { /* silent */ }
    return;
  }

  const baseDecision = actionForImageVerdict(result, {
    warned_count: member?.warned_count ?? 0,
  });
  let decision = baseDecision;
  if (baseDecision.action !== "skip") {
    const { applyStrike } = await import("../services/community-strikes.js");
    const strikeAction = await applyStrike(ctx.chat.id, sender.id, result.reason || result.verdict, {
      actionLabel: `image_${result.verdict}`,
      trusted,
    });
    decision = {
      action: baseDecision.action,
      warn: strikeAction.warn,
      mute_sec: strikeAction.mute_sec,
      flag_operator: strikeAction.flag_operator,
      _trusted_downgrade: trusted,
      _strike: strikeAction,
    };
  }
  if (decision.action === "skip") {
    // Still log the inspection for audit/trend analysis
    await recordModAction(
      ctx.chat.id, sender.id,
      `image_inspected:${result.verdict}`,
      `confidence=${result.confidence.toFixed(2)} reason=${result.reason}`,
      result.extractedText?.slice(0, 200) || null,
    );
    return;
  }

  // Take the action
  if (decision.action === "delete") {
    await tryDelete(ctx, msg.message_id);
  }
  const imageActionId = await recordModAction(
    ctx.chat.id, sender.id,
    `image_${result.verdict}`,
    `confidence=${result.confidence.toFixed(2)} reason=${result.reason}`,
    result.extractedText?.slice(0, 500) || null,
  );

  const wasMuted = decision.mute_sec > 0;
  if (wasMuted) {
    try {
      await ctx.api.restrictChatMember(ctx.chat.id, sender.id, {
        until_date: Math.floor(Date.now() / 1000) + decision.mute_sec,
        permissions: { can_send_messages: false },
      });
    } catch (err) {
      console.warn("[image-mod] mute failed (fail-open):", err.message);
    }
  }

  if (decision.warn) {
    const verdictLabel = {
      scam_screenshot: "phishing screenshot",
      impersonation_screenshot: "Magpie impersonation",
      fud_screenshot: "coordinated FUD",
      nsfw_or_violence: "NSFW or violent imagery",
    }[result.verdict] || "policy violation";

    // A mute is appealable (Pip re-reviews and can lift it). A delete-only
    // warn has nothing to restore, so it gets no button.
    const appealLine = wasMuted
      ? ` If you think this was a mistake, tap *Appeal* below — Pip will re-review it and lift the mute if it was wrong.`
      : ` If this was a mistake, post a plain-text follow-up explaining and someone will review.`;
    await softWarn(
      ctx,
      sender.id,
      `Your image was removed from the Magpie community — our vision moderator flagged it as a *${verdictLabel}*.${appealLine}`,
      wasMuted ? appealKeyboard(imageActionId) : undefined,
    );
  }

  if (decision.flag_operator) {
    try {
      const { notifyAdmin } = await import("../services/admin-notify.js");
      await notifyAdmin(
        { api: ctx.api },
        `🖼 *Community image flagged*\n\n` +
        `*Verdict:* ${escMd(result.verdict)} (conf ${result.confidence.toFixed(2)})\n` +
        `*From:* ${sender.username ? `@${escMd(sender.username)}` : escMd(sender.first_name || sender.id)}\n` +
        `*Reason:* ${escMd(result.reason)}${decision._trusted_downgrade ? "\n\n⚠️ User has a Magpie wallet — auto-mute SKIPPED. Your call." : ""}\n\n` +
        `*Extracted text (first 200 chars):*\n${escMd((result.extractedText || "(none)").slice(0, 200))}`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      console.warn("[image-mod] operator DM failed:", err.message);
    }
  }
}

/** Conservative FUD classifier — see community-fud-classifier.js for
 *  the action mapping. NEVER auto-bans. Flags operator on edge cases. */
async function maybeRunFudCheck(ctx, msg, sender) {
  const text = msg.text || msg.caption || "";
  const { hasSentimentSignal, classifyMessage, actionForVerdict } =
    await import("../services/community-fud-classifier.js");
  if (!hasSentimentSignal(text)) return;

  // Pull member context to help the classifier
  const member = await getMember(ctx.chat.id, sender.id);
  const memberAgeHours = member?.joined_at
    ? (Date.now() - new Date(member.joined_at).getTime()) / 3_600_000
    : null;

  let verdictObj;
  try {
    verdictObj = await classifyMessage(text, {
      member_age_hours: memberAgeHours,
      warned_count: member?.warned_count ?? 0,
      in_quarantine: !!(member?.quarantine_until && new Date(member.quarantine_until) > new Date()),
    });
  } catch (err) {
    console.warn("[community] FUD classify error:", err.message);
    return;
  }
  if (!verdictObj) return; // fail-open

  // Always LOG the classification, even when we don't act on it.
  // Gives the operator audit visibility.
  await recordModAction(
    ctx.chat.id, sender.id,
    `fud_${verdictObj.verdict}`,
    `confidence=${verdictObj.confidence.toFixed(2)} · ${verdictObj.reason}`,
    text.slice(0, 500),
  );

  const trusted = await isTrustedMember(sender.id);
  // Classifier decides "should we act at all" (confidence + verdict).
  const baseAction = actionForVerdict(verdictObj, {
    warned_count: member?.warned_count ?? 0,
  });
  if (baseAction.action === "skip") return;

  // From here, the STRIKE POLICY is the single source of truth for
  // whether to mute / warn / flag. The classifier's verdict tells us
  // the DELETE happens; strikes tell us the escalation level.
  if (baseAction.action === "delete") {
    await tryDelete(ctx, msg.message_id);
  }
  const { applyStrike, strikeFooter } = await import("../services/community-strikes.js");
  const strikeAction = await applyStrike(ctx.chat.id, sender.id, verdictObj.reason || verdictObj.verdict, {
    actionLabel: `fud_${verdictObj.verdict}`,
    trusted,
  });
  // The action object the rest of the handler reads from. We compose
  // the strike-policy decision with the classifier's delete decision.
  let action = {
    action: baseAction.action,
    warn: strikeAction.warn,
    mute_sec: strikeAction.mute_sec,
    flag_operator: strikeAction.flag_operator,
    _strike_level: strikeAction.level,
    _strike_in_window: strikeAction.strike_in_window,
    _trusted_downgrade: trusted,
  };
  if (action.warn) {
    await bumpWarnedCount(ctx.chat.id, sender.id);
    const wasMuted = action.mute_sec > 0;
    const verdictHuman = {
      misinformation: "a factual claim about the protocol that doesn't match reality",
      harassment: "harassment / personal attacks",
      spam: "spam",
      coordinated_fud: "what looks like coordinated FUD",
      ban_worthy: "egregious behavior",
    }[verdictObj.verdict] || "a policy violation";
    const muteLine = wasMuted
      ? `\n\nYou've been muted for ${Math.round(action.mute_sec / 3600)}h. After it expires you're welcome back if the conversation stays civil.`
      : ``;
    // When we mute, record an appealable action that captures the verdict +
    // the flagged text so Pip has full context to re-review on appeal.
    let appealActionId = null;
    if (wasMuted) {
      appealActionId = await recordModAction(
        ctx.chat.id, sender.id,
        `fud_${verdictObj.verdict}`,
        verdictObj.reason || verdictObj.verdict,
        JSON.stringify({ verdict: verdictObj.verdict, confidence: verdictObj.confidence, text: text.slice(0, 600) }),
      );
    }
    const appealOrDmLine = wasMuted
      ? `\n\nIf you think this was a mistake, tap *Appeal* below — Pip will re-review it thoroughly and lift the mute if it was wrong.`
      : `\n\nIf this was a misread, DM @magpie_capital_bot and an operator will review.`;
    const warnText =
      `Your message was removed from the Magpie community — our moderator flagged it as *${verdictHuman}*.` +
      muteLine +
      appealOrDmLine +
      strikeFooter(strikeAction);
    await softWarn(ctx, sender.id, warnText, wasMuted ? appealKeyboard(appealActionId) : undefined);
  }
  if (action.mute_sec > 0) {
    try {
      const until = Math.floor(Date.now() / 1000) + action.mute_sec;
      await ctx.api.restrictChatMember(ctx.chat.id, sender.id, {
        permissions: { can_send_messages: false },
        until_date: until,
      });
    } catch (err) {
      console.warn("[community] mute failed:", err.message);
    }
  }
  if (action.flag_operator) {
    try {
      const { notifyAdmin } = await import("../services/admin-notify.js");
      // Strip triple-backticks from the user's message so it can't
      // break out of the code-block fence below. Other Markdown chars
      // inside ``` blocks are inert, so they don't need escaping.
      const safeBody = text.slice(0, 800).replace(/```/g, "'''");
      await notifyAdmin(
        { api: ctx.api },
        [
          `🚨 *FUD-classifier flag* — needs your judgment`,
          ``,
          `Chat: \`${escMd(ctx.chat.title || String(ctx.chat.id))}\``,
          `From: ${sender.username ? `@${escMd(sender.username)}` : `user ${escMd(String(sender.id))}`}`,
          `Verdict: *${escMd(verdictObj.verdict)}* (confidence ${verdictObj.confidence.toFixed(2)})`,
          `Reason: ${escMd(verdictObj.reason)}`,
          ``,
          `Message:`,
          "```",
          safeBody,
          "```",
          ``,
          `Auto-action taken: ${action.action}${action.mute_sec ? ` + ${Math.round(action.mute_sec/3600)}h mute` : ""}${action._trusted_downgrade ? " (mute SKIPPED — user has a Magpie wallet)" : ""}`,
          trusted ? `\n⚠️ This user has a Magpie wallet — Pip skipped the auto-mute. Your call on whether this is a real issue.` : "",
          ``,
          `If you want to ban this user, do it via the group's admin UI (Telegram → group → user → Ban). I will not auto-ban.`,
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      console.warn("[community] operator flag DM failed:", err.message);
    }
  }
}

/** Detect + answer a Pip-question trigger in a group. Returns true if
 *  we handled it (caller should short-circuit other moderation rules). */
async function maybeAnswerPipQuestion(ctx, msg, sender) {
  const text = (msg.text || msg.caption || "").trim();
  if (!text) return false;

  const botUsername = ctx.me?.username || "magpie_capital_bot";
  const botMentionRe = new RegExp(`@${botUsername}\\b`, "i");

  // Trigger detection (one of three):
  let question = null;
  // 1. /ask <question> command
  const askMatch = text.match(/^\/ask(?:@\w+)?\s+([\s\S]+)$/i);
  if (askMatch) {
    question = askMatch[1].trim();
  }
  // 2. Direct @-mention (anywhere in the message)
  else if (botMentionRe.test(text)) {
    question = text.replace(botMentionRe, "").trim();
  }
  // 3. Reply to a previous bot message
  else if (msg.reply_to_message && msg.reply_to_message.from?.id === ctx.me?.id) {
    question = text;
  }
  if (!question) return false;

  // Rate limit + safety gate
  const { checkRateLimit, answerGroupQuestion, looksLikePromptInjection } =
    await import("../services/community-pip.js");

  // Short-circuit obvious prompt-injection attempts BEFORE the LLM call.
  // Saves Anthropic credits AND avoids accidentally engaging with an
  // attacker's framing even briefly.
  if (looksLikePromptInjection(question)) {
    await ctx.api.sendMessage(
      ctx.chat.id,
      `I just answer Magpie questions in here — what would you like to know about the protocol?`,
      { reply_to_message_id: msg.message_id, allow_sending_without_reply: true },
    ).catch(() => {});
    await recordModAction(ctx.chat.id, sender.id, "pip_injection_blocked", null, question.slice(0, 200));
    return true;
  }

  const rl = checkRateLimit(ctx.chat.id, sender.id);
  if (!rl.allowed) {
    const reasonText = {
      disabled:    `Pip's taking a quick break. Try /stats or /how for now.`,
      daily_cap:   `I've answered a lot today — try again tomorrow, or check /stats now.`,
      chat_hourly: `Pip's getting flooded right now. Try again in ~${rl.retry_in_min}m, or run /stats for live numbers.`,
      user_hourly: `⏳ Easy — you've asked me a lot already. Try again in ~${rl.retry_in_min}m.`,
    }[rl.reason] || `⏳ Try again in ~${rl.retry_in_min}m.`;
    await ctx.api.sendMessage(
      ctx.chat.id,
      reasonText,
      { reply_to_message_id: msg.message_id, allow_sending_without_reply: true },
    ).catch(() => {});
    return true;
  }

  // Show typing indicator while Anthropic is working
  ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  // If the user is replying to a Magpie-bot message (announcement,
  // crosspost, prior Pip answer), pass that as context so Pip can
  // react to reactions instead of asking "which X?". The
  // looksLikePromptInjection check above already covers the new
  // question text; the parent message comes from our own bot, so its
  // instruction-injection risk is low — but answerGroupQuestion's
  // wrapping explicitly tells the model not to follow instructions in
  // the context block, belt + suspenders.
  const repliedTo =
    msg.reply_to_message && msg.reply_to_message.from?.id === ctx.me?.id
      ? msg.reply_to_message.text ||
        msg.reply_to_message.caption ||
        null
      : null;

  let answer;
  try {
    answer = await answerGroupQuestion(question, { repliedTo, chatId: ctx.chat?.id });
  } catch (err) {
    console.warn("[community] Pip group answer failed:", err.message);
    answer = null;
  }
  if (!answer) {
    // Fail-quiet: don't post a stub. The model may have been blocked by
    // rate limit / outage. User can try again.
    return true;
  }

  try {
    await ctx.api.sendMessage(ctx.chat.id, answer, {
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
      // No markdown parse — group text could include unbalanced *_`
      // and we don't want a Pip answer to crash on parse.
    });
    await recordModAction(ctx.chat.id, sender.id, "pip_group_answer", null, question.slice(0, 200));
  } catch (err) {
    console.warn("[community] Pip group reply failed:", err.message);
  }
  return true;
}

async function tryDelete(ctx, messageId) {
  try {
    await ctx.api.deleteMessage(ctx.chat.id, messageId);
    return true;
  } catch (err) {
    // Usually = bot doesn't have delete permission. Log once, don't spam.
    if (!err.__loggedDelete) {
      console.warn(`[community] could not delete msg in ${ctx.chat.id}: ${err.message}`);
      err.__loggedDelete = true;
    }
    return false;
  }
}

/* ─────────────────────── APPEALS ─────────────────────── */

// Full posting permissions — used to LIFT a mute on an overturned appeal.
const FULL_SEND_PERMS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_invite_users: true,
  can_pin_messages: false,
  can_change_info: false,
};

/** Page the operator only when Pip couldn't decide (model down / low
 *  confidence). This is the ONLY path that still needs a human. */
async function escalateAppealToOperator(ctx, modAction, review, flaggedText) {
  try {
    const { notifyAdmin } = await import("../services/admin-notify.js");
    await notifyAdmin(
      { api: ctx.api },
      [
        `⚖️ *Appeal needs your call* — Pip wasn't confident enough to auto-decide`,
        ``,
        `User: \`${escMd(String(modAction.user_id))}\``,
        `Original verdict: *${escMd(modAction.action)}*`,
        `Reason: ${escMd(modAction.reason || "—")}`,
        review ? `Pip leaned: *${escMd(review.decision)}* (conf ${review.confidence.toFixed(2)}) — ${escMd(review.explanation)}` : `Pip: model unavailable`,
        ``,
        `Flagged content:`,
        "```",
        (flaggedText || "(image / no text)").slice(0, 600).replace(/```/g, "'''"),
        "```",
        ``,
        `To lift: unmute the user in the group admin UI. To uphold: do nothing (a temporary mute expires on its own).`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.warn("[appeals] operator escalation failed:", err.message);
  }
}

/** A member tapped "⚖️ Appeal" on a mute DM. Re-review the original action
 *  with Pip and act: overturn → lift the mute; uphold → explain; unsure →
 *  escalate to the operator. Idempotent per mod action. */
function appealStatusMsg(status) {
  return {
    overturned: "✅ Already reviewed — you were cleared and let back in.",
    upheld: "Already reviewed — the original action stands.",
    escalated: "Already with a human reviewer — hang tight.",
    reviewing: "Your appeal is already being reviewed — hang tight.",
  }[status] || "Your appeal is already on file.";
}

/** Shared appeal engine: review with Pip + act. Used by BOTH the inline
 *  Appeal button (mutes) and the /appeal DM command (bans/kicks/mutes). The
 *  appeal row must already be opened ('reviewing'). DMs the user the outcome.
 *   - overturned REMOVAL → unban + REMEMBER the clearance + single-use invite
 *   - overturned MUTE    → lift the restriction + clear quarantine
 *   - uphold             → explain; unsure/model-down → escalate to operator */
async function applyAppealOutcome(ctx, modAction, userReason) {
  const {
    resolveAppeal, reviewAppealWithPip, extractFlaggedText,
    APPEAL_ESCALATE_BELOW, REMOVAL_ACTIONS,
  } = await import("../services/community-appeals.js");

  const modActionId = String(modAction.id);
  const isRemoval = REMOVAL_ACTIONS.has(modAction.action);

  // OPERATOR POLICY (hard gate, no LLM, no benefit of the doubt): a user whose
  // CURRENT display name impersonates Magpie / Pip / a protocol persona
  // ("Magpie Support", "MagpieMatt", etc.) is NEVER appealed back in. Appeals
  // exist for BEHAVIOURAL misreads (something they SAID), not to launder an
  // impostor name. They're welcome back only with a clean name.
  if (isImpersonationName(ctx.from)) {
    await recordModAction(modAction.chat_id, modAction.user_id, "appeal_upheld",
      "impersonation display name — no benefit of the doubt", modActionId);
    await resolveAppeal(modActionId, {
      status: "upheld", decision: "uphold",
      reason: "display name impersonates Magpie/protocol", confidence: 1,
    });
    await softWarn(ctx, modAction.user_id,
      `Your appeal was reviewed and the removal stands.\n\nYour display name impersonates official Magpie / Pip / protocol staff, which is never allowed here. If you're a genuine member, change your display name so it no longer resembles Magpie, MagpieMatt, or any protocol/staff name, and you're welcome to rejoin.`);
    return;
  }

  const member = await getMember(modAction.chat_id, modAction.user_id).catch(() => null);
  const trusted = await isTrustedMember(modAction.user_id).catch(() => false);
  // For a name-based ban the "flagged content" is mostly the NAME (in `reason`)
  // plus any message text — give Pip both so it can tell "Magpie Support"
  // (impersonator → uphold) from "MagpieFan"/"CryptoDev" (member → overturn).
  const flaggedText = [modAction.reason, extractFlaggedText(modAction.payload)].filter(Boolean).join(" | ");

  const review = await reviewAppealWithPip({
    verdict: modAction.action,
    reason: modAction.reason,
    flaggedText,
    warnedCount: member?.warned_count ?? 0,
    trusted,
    userReason,
  });

  // Defense-in-depth against prompt injection: re-admitting an IMPERSONATION
  // ban grants a name-scoped clearance, so a low-confidence overturn there is
  // routed to a human instead of auto-readmitting. Captcha-kicks (real people)
  // keep the normal bar.
  const isImpersonationBan =
    modAction.action === "ban_impersonator" || modAction.action === "watchdog_auto_ban_impersonation";
  const lowConfidenceOverturn =
    review && review.decision === "overturn" && isImpersonationBan && review.confidence < 0.8;

  // Model unavailable or genuinely unsure → a human makes the final call.
  if (!review || review.confidence < APPEAL_ESCALATE_BELOW || lowConfidenceOverturn) {
    await resolveAppeal(modActionId, {
      status: "escalated",
      decision: review?.decision || null,
      reason: review?.explanation || "model unavailable / low confidence",
      confidence: review?.confidence ?? null,
    });
    await escalateAppealToOperator(ctx, modAction, review, flaggedText);
    await softWarn(ctx, modAction.user_id,
      "Thanks — your appeal needs a closer look, so a human reviewer has been notified. You'll hear back here shortly.");
    return;
  }

  if (review.decision === "overturn" && isRemoval) {
    // Lift the ban, REMEMBER the clearance (so the name-ban won't instantly
    // re-fire), and hand them a fresh single-use invite to rejoin.
    try {
      await ctx.api.unbanChatMember(modAction.chat_id, Number(modAction.user_id), { only_if_banned: true });
    } catch (err) {
      console.warn("[appeals] unban failed:", err.message);
    }
    // Scope the clearance to the name we just reviewed (ctx.from = the
    // appealing user, current name) so they can't later rename into an
    // impersonation handle and keep immunity.
    await markUserCleared(modAction.chat_id, modAction.user_id, "pip_appeal", review.explanation, nameKey(ctx.from));
    let invite = null;
    try {
      const link = await ctx.api.createChatInviteLink(modAction.chat_id, {
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 3600,
        name: `appeal-${modAction.user_id}`.slice(0, 32),
      });
      invite = link?.invite_link || null;
    } catch (err) {
      console.warn("[appeals] invite link failed:", err.message);
    }
    await recordModAction(modAction.chat_id, modAction.user_id, "appeal_overturned", review.explanation, modActionId);
    await resolveAppeal(modActionId, { status: "overturned", decision: "overturn", reason: review.explanation, confidence: review.confidence });
    await softWarn(ctx, modAction.user_id,
      `✅ *Appeal approved.* ${review.explanation}\n\n` +
      (invite
        ? `Here's your one-time invite back into the Magpie community (expires in 1 hour):\n${invite}\n\nYou won't be removed for your name again.`
        : `You're cleared to rejoin via the group invite link. You won't be removed for your name again.`));
  } else if (review.decision === "overturn") {
    // Muted → lift the restriction + clear quarantine.
    let lifted = false;
    try {
      await ctx.api.restrictChatMember(modAction.chat_id, Number(modAction.user_id), { permissions: FULL_SEND_PERMS });
      lifted = true;
    } catch (err) {
      console.warn("[appeals] unmute failed:", err.message);
    }
    await query(
      `UPDATE community_members SET quarantine_until = NULL WHERE chat_id = $1 AND user_id = $2`,
      [String(modAction.chat_id), String(modAction.user_id)],
    ).catch(() => {});
    await recordModAction(modAction.chat_id, modAction.user_id, "appeal_overturned", review.explanation, modActionId);
    await resolveAppeal(modActionId, { status: "overturned", decision: "overturn", reason: review.explanation, confidence: review.confidence });
    await softWarn(ctx, modAction.user_id,
      `✅ *Appeal approved.* ${review.explanation}` +
      (lifted ? `\n\nYou can post in the group again — sorry for the mix-up.` : `\n\nYour mute should lift momentarily.`));
  } else {
    await recordModAction(modAction.chat_id, modAction.user_id, "appeal_upheld", review.explanation, modActionId);
    await resolveAppeal(modActionId, { status: "upheld", decision: "uphold", reason: review.explanation, confidence: review.confidence });
    await softWarn(ctx, modAction.user_id,
      `Your appeal was reviewed and the original action stands.\n\n${review.explanation}\n\n` +
      `If this action was temporary it will expire on its own. If you still believe this is wrong, reply here and a human will take a final look.`);
  }
}

/** Inline "⚖️ Appeal" button on a mute DM. */
async function handleAppeal(ctx) {
  try {
    const m = ctx.callbackQuery?.data?.match(/^appeal:(\d+)$/);
    if (!m) return;
    const modActionId = m[1];
    const tapperId = ctx.from?.id;
    const { loadModAction, openAppeal } = await import("../services/community-appeals.js");

    const modAction = await loadModAction(modActionId);
    if (!modAction) {
      await ctx.answerCallbackQuery({ text: "This appeal link has expired.", show_alert: true });
      return;
    }
    if (String(modAction.user_id) !== String(tapperId)) {
      await ctx.answerCallbackQuery({ text: "Only the affected member can appeal this.", show_alert: true });
      return;
    }
    const { isNew, row } = await openAppeal(modActionId, modAction.chat_id, modAction.user_id);
    if (!isNew) {
      await ctx.answerCallbackQuery({ text: appealStatusMsg(row?.status), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "⚖️ Pip is reviewing your appeal now…" });
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* msg too old */ }
    await applyAppealOutcome(ctx, modAction, null);
  } catch (err) {
    console.warn("[appeals] button handler error:", err.message);
    try { await ctx.answerCallbackQuery({ text: "Something went wrong — please try again in a moment." }); } catch { /* ignore */ }
  }
}

/** /appeal in a DM — for REMOVED users (banned/kicked) who have no button.
 *  Finds their most recent moderation action and reviews it instantly.
 *  `/appeal <optional reason>` lets them state their case. */
async function handleAppealCommand(ctx) {
  try {
    if (ctx.chat?.type !== "private") {
      try { await ctx.reply("DM me /appeal in a private chat and Pip will review it instantly."); } catch { /* no perms */ }
      return;
    }
    const userId = ctx.from?.id;
    if (!userId) return;
    const userReason = (ctx.message?.text || "").replace(/^\/appeal(@\w+)?/i, "").trim() || null;

    // Light per-user cooldown: stop a re-kick loop (rejoin → fail captcha →
    // new kick row → /appeal) from spamming paid LLM reviews.
    const recent = await query(
      `SELECT created_at FROM community_appeals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [String(userId)],
    ).catch(() => ({ rows: [] }));
    if (recent.rows[0] && (Date.now() - new Date(recent.rows[0].created_at).getTime()) < 90_000) {
      await ctx.reply("Pip just reviewed an appeal for you — give it a minute, then send /appeal again.");
      return;
    }

    const { findRecentAppealableAction, openAppeal } = await import("../services/community-appeals.js");
    const modAction = await findRecentAppealableAction(userId);
    if (!modAction) {
      await ctx.reply(
        "I don't see any recent Magpie moderation action on your account. If you were removed, make sure you're messaging from the same Telegram account that was affected.",
      );
      return;
    }
    const { isNew, row } = await openAppeal(String(modAction.id), modAction.chat_id, modAction.user_id);
    if (!isNew) {
      await ctx.reply(appealStatusMsg(row?.status));
      return;
    }
    await ctx.reply("⚖️ Pip is reviewing your appeal now…");
    await applyAppealOutcome(ctx, modAction, userReason);
  } catch (err) {
    console.warn("[appeals] /appeal command error:", err.message);
    try { await ctx.reply("Something went wrong — please try again in a moment."); } catch { /* ignore */ }
  }
}

/* ─────────────────────── REGISTRATION ─────────────────────── */

export function registerCommunityHandlers(bot) {
  bot.on("message:new_chat_members", handleNewMembers);
  bot.on("message", handleGroupMessage);
  bot.on("edited_message", handleGroupMessage);
  // NOTE: the button data is `comm:captcha:<chat>:<user>` (user-scoped), so the
  // registration regex MUST allow the optional :<user> suffix — otherwise the
  // `$` after the chat id makes grammY's .test() fail and the callback NEVER
  // fires (tap does nothing → user kicked at timeout despite verifying). Keep
  // this in sync with the parser regex in handleCaptchaCallback.
  bot.callbackQuery(/^comm:captcha:(-?\d+)(?::(\d+))?$/, handleCaptchaCallback);
  bot.callbackQuery(/^appeal:(\d+)$/, handleAppeal);
  console.log("[community] handlers registered");
}

/** Convenience exposed for the admin-command module to verify state. */
export { isAdmin, handleAppealCommand };
