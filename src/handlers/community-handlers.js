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
  CAPTCHA_TIMEOUT_MS,
} from "../services/community-moderation.js";
import { classifyImage, actionForImageVerdict } from "../services/community-image-ocr.js";

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
async function softWarn(ctx, userId, msg) {
  try {
    await ctx.api.sendMessage(userId, msg);
  } catch { /* user blocked bot — silent */ }
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

    // ── URL allowlist ───────────────────────────────────────
    const urls = extractUrls(msg);
    for (const u of urls) {
      if (!isAllowedUrl(u)) {
        await tryDelete(ctx, msg.message_id);
        await recordModAction(ctx.chat.id, sender.id, "delete_link", "url not on allowlist", u);
        const count = await bumpWarnedCount(ctx.chat.id, sender.id);
        await softWarn(
          sender.id,
          `Your message was removed from the Magpie community group because it contained a link.\n\n` +
          `*Only tweets from the official @MagpieLoans X account are allowed.* This is to keep scammers and phishing links out — almost every other "useful link" in a DeFi community turns out to be a scam.\n\n` +
          `Allowed format: https://x.com/MagpieLoans/... or https://twitter.com/MagpieLoans/...` +
          (count >= 3 ? `\n\nThis is warning #${count}. Repeated removals may result in a temporary mute.` : ``),
        );
        return; // already removed; don't run other checks
      }
    }

    // ── Scam pattern ────────────────────────────────────────
    const scam = matchesScamPattern(msg.text || msg.caption || "");
    if (scam) {
      await tryDelete(ctx, msg.message_id);
      await recordModAction(ctx.chat.id, sender.id, "delete_scam_pattern", scam, msg.text || msg.caption);
      const count = await bumpWarnedCount(ctx.chat.id, sender.id);
      await softWarn(
        sender.id,
        `Your message was removed from the Magpie group — it matched a pattern we automatically flag (asking for seed phrases, "send X SOL", "DM me for free airdrop", etc.). If this was a misunderstanding, just rephrase.` +
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

  const decision = actionForImageVerdict(result);
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
  await recordModAction(
    ctx.chat.id, sender.id,
    `image_${result.verdict}`,
    `confidence=${result.confidence.toFixed(2)} reason=${result.reason}`,
    result.extractedText?.slice(0, 500) || null,
  );

  if (decision.mute_sec > 0) {
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

    await softWarn(
      sender.id,
      `Your image was removed from the Magpie community — our vision moderator flagged it as a *${verdictLabel}*. If this was a mistake, post a plain-text follow-up explaining and someone will review.`,
    );
  }

  if (decision.flag_operator) {
    try {
      const { notifyAdmin } = await import("../services/admin-notify.js");
      await notifyAdmin(
        ctx.api,
        `🖼 *Community image flagged*\n\n` +
        `*Verdict:* ${result.verdict} (conf ${result.confidence.toFixed(2)})\n` +
        `*From:* @${sender.username || sender.first_name || sender.id}\n` +
        `*Reason:* ${result.reason}\n\n` +
        `*Extracted text (first 200 chars):*\n${(result.extractedText || "(none)").slice(0, 200)}`,
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

  const action = actionForVerdict(verdictObj);
  if (action.action === "skip") return;

  if (action.action === "delete") {
    await tryDelete(ctx, msg.message_id);
  }
  if (action.warn) {
    await bumpWarnedCount(ctx.chat.id, sender.id);
    const warnText =
      verdictObj.verdict === "misinformation"
        ? `Your message was removed from the Magpie community group because it contained a factual claim about the protocol that doesn't match reality. If you have a real concern, DM the team via @magpie_capital_bot — we'd rather hear it directly. Repeated removals may result in a mute.`
        : verdictObj.verdict === "harassment"
        ? `Your message was removed for harassment. Personal attacks aren't tolerated, even when the criticism is valid. You've been temporarily muted (24h). After that, you're welcome back if the conversation stays civil.`
        : `Your message was removed by the community moderator. If you think this was a mistake, DM @magpie_capital_bot.`;
    await softWarn(sender.id, warnText);
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
      await notifyAdmin(
        { api: ctx.api },
        [
          `🚨 *FUD-classifier flag* — needs your judgment`,
          ``,
          `Chat: \`${ctx.chat.title || ctx.chat.id}\``,
          `From: ${sender.username ? `@${sender.username}` : `user ${sender.id}`}`,
          `Verdict: *${verdictObj.verdict}* (confidence ${verdictObj.confidence.toFixed(2)})`,
          `Reason: ${verdictObj.reason}`,
          ``,
          `Message:`,
          "```",
          text.slice(0, 800),
          "```",
          ``,
          `Auto-action taken: ${action.action}${action.mute_sec ? ` + ${Math.round(action.mute_sec/3600)}h mute` : ""}`,
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

  // Rate limit per user per chat
  const { checkRateLimit, answerGroupQuestion } = await import("../services/community-pip.js");
  const rl = checkRateLimit(ctx.chat.id, sender.id);
  if (!rl.allowed) {
    await ctx.api.sendMessage(
      ctx.chat.id,
      `⏳ Easy — you've asked me a lot already. Try again in ~${rl.retry_in_min}m.`,
      { reply_to_message_id: msg.message_id, allow_sending_without_reply: true },
    ).catch(() => {});
    return true;
  }

  // Show typing indicator while Anthropic is working
  ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  let answer;
  try {
    answer = await answerGroupQuestion(question);
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

/* ─────────────────────── REGISTRATION ─────────────────────── */

export function registerCommunityHandlers(bot) {
  bot.on("message:new_chat_members", handleNewMembers);
  bot.on("message", handleGroupMessage);
  bot.on("edited_message", handleGroupMessage);
  bot.callbackQuery(/^comm:captcha:(-?\d+)$/, handleCaptchaCallback);
  console.log("[community] handlers registered");
}

/** Convenience exposed for the admin-command module to verify state. */
export { isAdmin };
