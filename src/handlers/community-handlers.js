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

      // Impersonation check on join — fastest way to catch
      // fake-support accounts.
      if (isImpersonationName(m) && !isVerifiedAccount(m)) {
        await recordModAction(
          ctx.chat.id, m.id, "warn_impersonation_join",
          "name contains impersonation pattern",
          JSON.stringify({ username: m.username, first: m.first_name, last: m.last_name }),
        );
        try {
          await ctx.api.sendMessage(
            ctx.chat.id,
            `⚠️ *Heads up:* a new account named "${m.first_name || m.username}" just joined and uses a name that resembles official Magpie support. Never DM strangers about your wallet. The only official account is @magpie_capital_bot.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* permission issue — skip */ }
      }

      // Send a captcha DM (deep-link). If the user blocks the bot, we
      // can't DM, so the kick timer still applies after 5 min.
      const kb = new InlineKeyboard()
        .text("✅ I'm not a bot", `comm:captcha:${ctx.chat.id}`);
      const captchaMsg = [
        `👋 Welcome to the Magpie group.`,
        ``,
        `To keep scammers out, tap the button below in the next ${CAPTCHA_TIMEOUT_MS / 60000} minutes. If you don't, you'll be removed and can rejoin.`,
      ].join("\n");
      let dmFailed = false;
      try {
        await ctx.api.sendMessage(m.id, captchaMsg, { reply_markup: kb });
      } catch {
        dmFailed = true;
      }

      // Schedule the kick. Cancelled in-memory if captcha is passed.
      scheduleCaptchaKick(ctx, m.id, dmFailed);
    }
  } catch (err) {
    console.warn("[community] new-member handler failed (fail-open):", err.message);
  }
}

// In-memory map of pending captcha kicks. Lives only as long as the
// bot process — that's fine. New members on a restart would just need
// to re-join. Memory-bounded by Set of timers we clear after firing.
const pendingKicks = new Map(); // key: `${chatId}:${userId}` → timeout

function kickKey(chatId, userId) { return `${chatId}:${userId}`; }

function scheduleCaptchaKick(ctx, userId, dmFailed) {
  const key = kickKey(ctx.chat.id, userId);
  if (pendingKicks.has(key)) clearTimeout(pendingKicks.get(key));
  const timeout = setTimeout(async () => {
    pendingKicks.delete(key);
    try {
      const member = await getMember(ctx.chat.id, userId);
      if (member?.captcha_passed_at) return; // passed; do nothing
      // Pip's memory: a previously-cleared member (appeal / operator unban)
      // who rejoined is not re-kicked for missing the captcha.
      if (await isUserCleared(ctx.chat.id, userId)) return;
      // Kick (= ban for 30s then unban, lets them rejoin if real)
      const until = Math.floor(Date.now() / 1000) + 30;
      await ctx.api.banChatMember(ctx.chat.id, userId, { until_date: until });
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
    const data = ctx.callbackQuery.data; // "comm:captcha:<chat_id>"
    const m = data.match(/^comm:captcha:(-?\d+)$/);
    if (!m) return;
    const chatId = m[1];
    const userId = ctx.callbackQuery.from.id;
    await markCaptchaPassed(chatId, userId);
    const key = kickKey(chatId, userId);
    if (pendingKicks.has(key)) {
      clearTimeout(pendingKicks.get(key));
      pendingKicks.delete(key);
    }
    await ctx.answerCallbackQuery({
      text: "Welcome to Magpie! You can chat in the group now.",
      show_alert: false,
    });
    // Edit the captcha message to reflect success
    try {
      await ctx.editMessageText("✅ You're verified. Head back to the Magpie group to chat.");
    } catch { /* edit might fail if msg was deleted — silent */ }
    await recordModAction(chatId, userId, "captcha_pass", null, null);

    // Post a warm in-group welcome. Static template, no LLM cost.
    // The captcha message above lives in the user's DM with the bot —
    // they need to see something IN the group too so the rest of the
    // community knows someone new is here, and so the new member feels
    // greeted rather than "you passed a test, now figure it out".
    try {
      const { postCaptchaWelcome } = await import("../services/community-proactive.js");
      await postCaptchaWelcome(ctx.api, chatId, ctx.callbackQuery.from);
    } catch (err) {
      console.warn("[community] welcome post failed (non-critical):", err.message);
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

    // ── URL allowlist ───────────────────────────────────────
    const urls = extractUrls(msg);
    for (const u of urls) {
      if (!isAllowedUrl(u)) {
        await tryDelete(ctx, msg.message_id);
        await recordModAction(ctx.chat.id, sender.id, "delete_link", "url not on allowlist", u);
        const count = await bumpWarnedCount(ctx.chat.id, sender.id);
        await softWarn(
          ctx,
          sender.id,
          `Your message was removed from the Magpie community group because it contained a link.\n\n` +
          `*Only tweets from the official @MagpieLoans X account are allowed.* This is to keep scammers and phishing links out — almost every other "useful link" in a DeFi community turns out to be a scam.\n\n` +
          `Allowed format: https://x.com/MagpieLoans/... or https://twitter.com/MagpieLoans/...` +
          (count >= 3 ? `\n\nThis is warning #${count}. Repeated removals may result in a temporary mute.` : ``),
        );
        return; // already removed; don't run other checks
      }
    }

    // ── Scam pattern (non-impersonator users) ──────────────
    // Impersonators are already banned above, so anyone reaching here
    // is a regular user posting a phishing-shaped phrase. Delete +
    // warn via the strike ladder.
    const scam = matchesScamPattern(msg.text || msg.caption || "");
    if (scam) {
      await tryDelete(ctx, msg.message_id);
      await recordModAction(ctx.chat.id, sender.id, "delete_scam_pattern", scam, msg.text || msg.caption);
      const count = await bumpWarnedCount(ctx.chat.id, sender.id);
      await softWarn(
        ctx,
        sender.id,
        `Your message was removed from the Magpie group — it matched a pattern we automatically flag (seed phrase requests, "send X SOL", "DM me", "claim airdrop", etc.). If this was a misunderstanding, just rephrase.` +
        (count >= 3 ? `\n\n#${count} warning. Repeated matches may result in a mute.` : ``),
      );
      return;
    }

    // ── Verbal handle impersonation ──────────────────────────
    // Catches "DM @MagpieSupport for help" — no link, just text, but
    // routes the user to a scammer. URL filter doesn't see it because
    // it's a bare handle. Strict on Magpie-flavored handles only —
    // legit cross-mentions like "@MagpieLoans posted X" pass.
    const impersonators = findImpersonatingHandles(msg.text || msg.caption || "");
    if (impersonators.length > 0) {
      await tryDelete(ctx, msg.message_id);
      await recordModAction(
        ctx.chat.id, sender.id, "delete_handle_impersonation",
        impersonators.join(","), msg.text || msg.caption,
      );
      const count = await bumpWarnedCount(ctx.chat.id, sender.id);
      await softWarn(
        ctx,
        sender.id,
        `Your message was removed because it referenced an unofficial Magpie-related handle (${impersonators.join(", ")}). The ONLY official Magpie accounts are *@MagpieLoans* on X and *@magpie_capital_bot* on Telegram. Anyone else claiming to be Magpie support is a scammer.` +
        (count >= 3 ? `\n\n#${count} warning. Repeated removals may result in a mute.` : ``),
      );
      return;
    }

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
    answer = await answerGroupQuestion(question, { repliedTo });
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
  bot.callbackQuery(/^comm:captcha:(-?\d+)$/, handleCaptchaCallback);
  bot.callbackQuery(/^appeal:(\d+)$/, handleAppeal);
  console.log("[community] handlers registered");
}

/** Convenience exposed for the admin-command module to verify state. */
export { isAdmin, handleAppealCommand };
