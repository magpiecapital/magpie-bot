/**
 * Community moderation core.
 *
 * Pure logic + DB-backed state. The TG event handlers (in
 * src/handlers/community-handlers.js) call into these helpers and
 * decide what to do based on the verdicts here.
 *
 * Design rules:
 *   1. FAIL OPEN — if anything in here throws or hits a transient
 *      error, the message is allowed through. Better to let a small
 *      amount of spam slip than to silently delete legitimate users'
 *      messages.
 *   2. EXISTING USERS UNAFFECTED — every code path is gated by
 *      community_chats.enabled and only runs in group chats. DMs to
 *      the bot are never touched.
 *   3. NO TRUST OF MESSAGE CONTENT — everything verified from TG's
 *      structured payload (entities, sender, chat type), not regex on
 *      raw text alone.
 */
import { query } from "../db/pool.js";

/* ──────────────────────────── CONFIG ──────────────────────────── */

// STRICT POLICY (operator decision, 2026-06-06):
// Regular users can post NO links in moderated groups EXCEPT tweets
// from the official @MagpieLoans X account. Every other link — including
// magpie.capital, solscan, jup.ag, even the bot's own t.me URL — gets
// auto-deleted from non-admin senders. Rationale: ~every link a random
// member posts in DeFi groups is a phishing attempt. Tighter blast
// radius beats "convenient but accidentally allows a scammer."
//
// Operators, chat admins, and the bot itself are NOT subject to this
// filter (the message handler skips them before the URL check), so
// official links can still be posted by you, pinned messages, and
// Pip's own responses.
//
// Both x.com and twitter.com variants of /MagpieLoans are honored
// because Telegram users paste either depending on their app.
export const URL_ALLOWLIST = new Set([
  "x.com/MagpieLoans",
  "twitter.com/MagpieLoans",
  // Magpie's own properties — must never be auto-deleted as "not on allowlist".
  // (The bare magpie.capital domain is allowed host-level in isAllowedUrl.)
  "github.com/magpiecapital",
  "t.me/magpie_capital_bot",
]);

// Magpie-owned domains allowed at the DOMAIN level (any path) — links to the
// official site should never be deleted by the link filter.
export const OWN_DOMAINS = ["magpie.capital"];

// Quarantine: new members can't post links/forwards and are rate-
// limited for this many days. Captcha must still be passed before
// the timer even starts.
export const QUARANTINE_DAYS = 7;
export const QUARANTINE_MS = QUARANTINE_DAYS * 24 * 3600 * 1000;
export const QUARANTINE_RATE_LIMIT_MS = 30 * 1000; // 1 msg / 30s

// Captcha timeout — fail to confirm in this window = auto-kick.
export const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;

// Display-name / username substrings that smell like impersonation.
// Match is case-insensitive. The check runs only on non-allowlisted
// accounts (the verified-account check excludes the bot + operator).
//
// "magpie" intentionally has NO word boundaries because impersonator
// usernames typically lack separators ("magpiesupport", "magpiemod",
// "magpie_help"). The verified-account allowlist catches the legit bot
// (@magpie_capital_bot) so this doesn't false-positive on us.
//
// Generic terms (support/admin/team/mod) keep word boundaries — too
// many legit names contain "Sam" or "Adam" as substrings.
export const IMPERSONATION_PATTERNS = [
  /magpie/i,                       // any substring — catches magpiesupport, magpiemod
  /\bsupport\b/i,
  /\badmin\b/i,
  /\bteam\b/i,
  /\bmoderator\b/i,
  /\bmod\b/i,
  /\bhelp\s*desk\b/i,
  // 2026-06-13: live impersonator joined with display name "Pip" (no
  // "magpie" substring), slipped past the join-time filter. The bot's
  // AI helper IS named Pip in the community chat, so anyone using
  // that name is impersonating. The verified-account allowlist still
  // exempts @magpie_capital_bot itself and the operator's account.
  /\bpip\b/i,
  // Also lock down "dev"/"founder"/"owner" which scammers love and
  // which a legit member has no reason to put in their display name.
  /\bdev\b/i,
  /\bfounder\b/i,
  /\bowner\b/i,
];

// Verified accounts that are allowed to use those words (the bot
// itself + operator IDs from env). Populated lazily at startup.
let _verifiedTgIds = null;
function getVerifiedTgIds() {
  if (_verifiedTgIds) return _verifiedTgIds;
  const s = new Set();
  const adminId = process.env.ADMIN_TG_ID;
  if (adminId) s.add(String(adminId));
  // Operator-trusted community accounts exempt from ALL message moderation
  // (the line-280 early-return in community-handlers). Comma-separated NUMERIC
  // Telegram user IDs in MOD_EXEMPT_TG_IDS — IDs only, never usernames, so no
  // handle is ever stored in code or env.
  const exempt = process.env.MOD_EXEMPT_TG_IDS;
  if (exempt) {
    for (const id of exempt.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (/^\d{4,}$/.test(id)) s.add(String(id));
    }
  }
  // Bot itself: we'll add bot.botInfo.id dynamically at startup.
  // For now, leave caller to add it via setBotId() below.
  _verifiedTgIds = s;
  return s;
}
export function setBotTgId(botId) {
  if (!botId) return;
  getVerifiedTgIds().add(String(botId));
}
export function addVerifiedTgId(id) {
  if (!id) return;
  getVerifiedTgIds().add(String(id));
}

// Scam-pattern phrases that almost always = phishing or honeypot.
// Tested against BOTH the raw text and a unicode-normalized version
// (see normalizeUnicode below) so attackers can't bypass by writing
// 𝑫𝑴 𝒎𝒆 𝒏𝒐𝒘 in mathematical-italic letters.
export const SCAM_PHRASES = [
  /seed\s*phrase/i,
  /private\s*key/i,
  /send\s+(?:me\s+)?\d+\s*sol/i,
  // DM-solicitation — broader than the original "...for" suffix. Catches
  // "DM me now" / "message me" / "PM me" / "hit me up" patterns common
  // in distress-scammer setups ("if you're still holding my token...
  // message me now").
  /\b(?:dm|direct\s*message|pm|private\s*message|message|msg|text)\s+me\b/i,
  /\bhit\s+me\s+up\b/i,
  /\bsend\s+me\s+a\s+(?:dm|message|pm)\b/i,
  // Distress-scammer framing — VERY narrow now: requires "holding MY"
  // (not "the") + a specific noun (token/coin/project/nft, NOT "bag"
  // since "holding the bag" / "holding my bag" are common crypto
  // idioms). This catches the canonical "if you are still holding
  // my token message me now" scammer pattern without false-positiving
  // on normal hodl culture.
  /\bstill\s+holding\s+my\s+(?:token|coin|project|nft)\b/i,
  /\bif\s+you(?:'re|\s+are)\s+(?:still\s+)?holding\s+my\s+(?:token|coin|project|nft)\b/i,
  /\b(?:my|the)\s+token\s+(?:holder|holders)\b/i,
  // Free/airdrop/claim scams
  /\bfree\s+(?:airdrop|magpie|sol)\b/i,
  /\bclaim\s+(?:your\s+)?(?:airdrop|reward|refund|compensation)\b/i,
  /\bguarantee[ds]?\s+\d+%/i,
  // Recovery / refund scams
  /\b(?:lost|recover|refund)\s+(?:your|my)\s+(?:funds?|sol|tokens?|wallet)\b/i,
  /\b(?:rug(?:ged|pull)?|scammed|lost)\b.*\b(?:dm|message|pm|contact)\s+me\b/i,
];

/**
 * Map Unicode "fancy" letterforms back to ASCII so pattern matching can
 * catch obfuscated scam text like 𝑫𝑴 𝒎𝒆 𝒏𝒐𝒘 (mathematical bold-italic).
 * Covers every Latin variant Unicode defines:
 *   - Mathematical bold / italic / bold-italic / script / bold script
 *   - Mathematical fraktur / bold fraktur
 *   - Mathematical double-struck / sans-serif / sans-serif bold / sans italic
 *   - Mathematical monospace
 *   - Fullwidth Latin
 *   - Circled / squared / parenthesized Latin
 *
 * The output is the same string with each fancy letter replaced by its
 * plain ASCII equivalent. Non-letter characters pass through unchanged.
 */
export function normalizeUnicode(text) {
  if (!text) return "";
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    // Plain ASCII passes through
    if (cp < 0x80) { out += ch; continue; }

    // Mathematical alphanumeric blocks: U+1D400..U+1D7FF
    // Layout: each block is 26 uppercase + 26 lowercase (some have
    // digit subblocks). We map the letter ranges by computing offsets.
    // Bold (1D400) · Italic (1D434) · Bold-Italic (1D468) · Script (1D49C)
    // Bold Script (1D4D0) · Fraktur (1D504) · Double-struck (1D538)
    // Bold Fraktur (1D56C) · Sans-serif (1D5A0) · Sans-bold (1D5D4)
    // Sans-italic (1D608) · Sans-bold-italic (1D63C) · Monospace (1D670)
    const blocks = [
      0x1D400, 0x1D434, 0x1D468, 0x1D49C, 0x1D4D0,
      0x1D504, 0x1D538, 0x1D56C, 0x1D5A0, 0x1D5D4,
      0x1D608, 0x1D63C, 0x1D670,
    ];
    let mapped = null;
    for (const base of blocks) {
      if (cp >= base && cp < base + 26) {           // uppercase A..Z
        mapped = String.fromCharCode(65 + (cp - base));
        break;
      }
      if (cp >= base + 26 && cp < base + 52) {      // lowercase a..z
        mapped = String.fromCharCode(97 + (cp - base - 26));
        break;
      }
    }
    // Math bold/sans/monospace digit ranges (U+1D7CE..U+1D7FF)
    if (mapped == null && cp >= 0x1D7CE && cp <= 0x1D7FF) {
      mapped = String.fromCharCode(48 + ((cp - 0x1D7CE) % 10));
    }
    // Fullwidth Latin (U+FF21..U+FF3A uppercase, U+FF41..U+FF5A lowercase)
    if (mapped == null && cp >= 0xFF21 && cp <= 0xFF3A) {
      mapped = String.fromCharCode(65 + (cp - 0xFF21));
    }
    if (mapped == null && cp >= 0xFF41 && cp <= 0xFF5A) {
      mapped = String.fromCharCode(97 + (cp - 0xFF41));
    }
    // Circled Latin (U+24B6..U+24E9)
    if (mapped == null && cp >= 0x24B6 && cp <= 0x24CF) {
      mapped = String.fromCharCode(65 + (cp - 0x24B6));
    }
    if (mapped == null && cp >= 0x24D0 && cp <= 0x24E9) {
      mapped = String.fromCharCode(97 + (cp - 0x24D0));
    }
    out += mapped ?? ch;
  }
  return out;
}

/**
 * Returns true if a message contains more than N "fancy" unicode letters
 * (math/styled/fullwidth). Real users essentially never use these; it's
 * a high-signal scam tell on its own.
 */
export function hasObfuscatedUnicode(text, threshold = 8) {
  if (!text) return false;
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    if (
      (cp >= 0x1D400 && cp <= 0x1D7FF) ||  // mathematical alphanumeric
      (cp >= 0xFF21 && cp <= 0xFF5A) ||    // fullwidth Latin
      (cp >= 0x24B6 && cp <= 0x24E9)       // circled Latin
    ) {
      count++;
      if (count > threshold) return true;
    }
  }
  return false;
}

// Handles that legitimately represent Magpie. Anything else in a
// @MagpieXxx form is treated as impersonation.
const OFFICIAL_MAGPIE_HANDLES = new Set([
  "magpieloans",         // official X
  "magpie_capital_bot",  // official TG bot
  "magpiecapital",       // org GitHub + reserved
  "magpietalk",          // the community group itself
]);

/**
 * Find @handles in text that LOOK Magpie-related but aren't on the
 * official list. Catches verbal impersonation that bypasses the URL
 * filter (someone posting "DM @MagpieSupport for help" — no link, just
 * a handle reference, but routes the user to a scammer).
 *
 * Returns the array of offending handles, or [] if none. The handle
 * does NOT need to be on Telegram specifically — we flag ANY @ token
 * because X and TG impersonators are equally dangerous.
 *
 * Case-insensitive. The official list is lowercased above.
 */
export function findImpersonatingHandles(text) {
  if (!text) return [];
  const found = [];
  // Match @ followed by 4-32 word chars (TG + X handle constraints).
  const handlePattern = /@([a-zA-Z0-9_]{4,32})/g;
  for (const m of text.matchAll(handlePattern)) {
    const handle = m[1].toLowerCase();
    // Only flag if it CONTAINS "magpie" (otherwise we'd false-positive
    // on every legit cross-mention of other projects/people).
    if (!handle.includes("magpie")) continue;
    if (OFFICIAL_MAGPIE_HANDLES.has(handle)) continue;
    found.push(m[0]); // include the leading @ for clarity
  }
  return found;
}

/* ───────────────────────── URL HANDLING ──────────────────────── */

/** Extract every URL the user sent — both via TG entities + plain text */
export function extractUrls(msg) {
  const urls = new Set();
  const text = msg.text || msg.caption || "";
  // 1. TG-parsed URL entities (most reliable)
  const entities = msg.entities || msg.caption_entities || [];
  for (const e of entities) {
    if (e.type === "url") {
      urls.add(text.slice(e.offset, e.offset + e.length));
    } else if (e.type === "text_link" && e.url) {
      urls.add(e.url);
    }
  }
  // 2. Bare-text fallback (catches anything TG didn't auto-detect)
  const bareRegex = /(?:https?:\/\/|www\.|t\.me\/|x\.com\/|twitter\.com\/)[^\s<>'"`]+/gi;
  for (const m of text.matchAll(bareRegex)) urls.add(m[0]);
  return [...urls];
}

/** Decide if a URL is on the allowlist.
 *
 * STRICT-MATCH semantics: every allowlist entry MUST include a path
 * (host + "/handle"). A bare-host entry would let a scammer post
 * x.com/RandomScammer and slip through. Each entry is matched as a
 * path prefix at a path boundary so x.com/MagpieLoans/status/... is
 * allowed but x.com/MagpieLoans2 (impersonation typo) is not.
 *
 * The host comparison strips an optional leading "www." so users
 * pasting www.x.com/MagpieLoans don't get blocked.
 */
export function isAllowedUrl(rawUrl) {
  try {
    let u = rawUrl.trim();
    if (!/^https?:\/\//i.test(u) && !u.startsWith("t.me/")) {
      u = "https://" + u;
    }
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    // Magpie's own domains are always allowed (any path) — official links
    // (magpie.capital, docs.magpie.capital, …) must never be auto-deleted.
    if (OWN_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return true;
    // Twitter/X handles are case-insensitive (x.com/MagpieLoans ==
    // x.com/magpieloans on Twitter's side). Compare both sides
    // lowercased to avoid false rejects on case variants.
    const path = (parsed.pathname || "/").toLowerCase();
    const candidate = host + path;          // e.g. "x.com/magpieloans/status/123"
    const candidateBase = host + path.replace(/\/+$/, ""); // strip trailing /

    for (const allowed of URL_ALLOWLIST) {
      if (!allowed.includes("/")) continue; // guard — bare hosts rejected
      const a = allowed.toLowerCase();
      if (candidate === a) return true;
      if (candidateBase === a) return true;
      // Path-boundary prefix: "x.com/magpieloans/" but NOT "x.com/magpieloans2/"
      if (candidate.startsWith(a + "/")) return true;
      if (candidate.startsWith(a + "?")) return true;
    }
    return false;
  } catch {
    return false; // unparseable = unsafe
  }
}

/* ──────────────────── IMPERSONATION + SCAM ───────────────────── */

export function isImpersonationName(user) {
  if (!user) return false;
  const candidates = [
    user.username || "",
    user.first_name || "",
    user.last_name || "",
  ].filter(Boolean);
  for (const c of candidates) {
    for (const re of IMPERSONATION_PATTERNS) {
      if (re.test(c)) return true;
    }
  }
  return false;
}

export function isVerifiedAccount(user) {
  if (!user?.id) return false;
  return getVerifiedTgIds().has(String(user.id));
}

/**
 * Match against the scam-phrase regex set. Tests both the raw text AND
 * a unicode-normalized version so attackers can't bypass with math-bold
 * letters (𝑫𝑴 𝒎𝒆 𝒏𝒐𝒘 → "DM me now"). Also flags pure-obfuscation
 * messages: if a post has >8 fancy unicode letters and the user has
 * an impersonation-flavored name, that's basically always a scam tell.
 */
export function matchesScamPattern(text) {
  if (!text) return null;
  // Try raw first — most legit hits land here
  for (const re of SCAM_PHRASES) {
    if (re.test(text)) return re.source;
  }
  // Then normalize and try again — catches unicode-obfuscated scams
  const normalized = normalizeUnicode(text);
  if (normalized !== text) {
    for (const re of SCAM_PHRASES) {
      if (re.test(normalized)) return `[obfuscated] ${re.source}`;
    }
    // Pure obfuscation with no other signal — still suspicious enough
    // to flag on its own (real users don't write whole sentences in
    // mathematical-italic letters).
    if (hasObfuscatedUnicode(text, 8)) {
      return "[obfuscated text — math/styled unicode characters]";
    }
  }
  return null;
}

/* ─────────────────────── DB-BACKED STATE ─────────────────────── */

/** True if community moderation is active for the given chat. */
export async function isChatEnabled(chatId) {
  if (!chatId) return false;
  try {
    const { rows } = await query(
      `SELECT enabled FROM community_chats WHERE chat_id = $1 LIMIT 1`,
      [String(chatId)],
    );
    return !!rows[0]?.enabled;
  } catch {
    return false; // fail closed for the "is moderation on" check
  }
}

export async function enableChat(chatId, title, byUserId) {
  await query(
    `INSERT INTO community_chats (chat_id, title, enabled, enabled_by_user_id, enabled_at, updated_at)
       VALUES ($1, $2, TRUE, $3, NOW(), NOW())
     ON CONFLICT (chat_id) DO UPDATE
       SET enabled = TRUE, title = EXCLUDED.title, updated_at = NOW()`,
    [String(chatId), title || null, String(byUserId)],
  );
}

export async function disableChat(chatId) {
  await query(
    `UPDATE community_chats SET enabled = FALSE, updated_at = NOW() WHERE chat_id = $1`,
    [String(chatId)],
  );
}

export async function listEnabledChats() {
  const { rows } = await query(
    `SELECT chat_id, title, enabled_at FROM community_chats WHERE enabled = TRUE ORDER BY enabled_at ASC`,
  );
  return rows;
}

/** Get the moderation record for a member; null if never seen here. */
export async function getMember(chatId, userId) {
  const { rows } = await query(
    `SELECT * FROM community_members WHERE chat_id = $1 AND user_id = $2`,
    [String(chatId), String(userId)],
  );
  return rows[0] || null;
}

/** Insert a member with quarantine set; idempotent. */
export async function recordNewMember(chatId, userId) {
  await query(
    `INSERT INTO community_members
       (chat_id, user_id, joined_at, quarantine_until)
     VALUES ($1, $2, NOW(), NOW() + INTERVAL '${QUARANTINE_DAYS} days')
     ON CONFLICT (chat_id, user_id) DO NOTHING`,
    [String(chatId), String(userId)],
  );
}

export async function markCaptchaPassed(chatId, userId) {
  await query(
    `UPDATE community_members
       SET captcha_passed_at = NOW()
     WHERE chat_id = $1 AND user_id = $2`,
    [String(chatId), String(userId)],
  );
}

export async function touchLastMessage(chatId, userId) {
  await query(
    `INSERT INTO community_members (chat_id, user_id, last_message_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chat_id, user_id) DO UPDATE SET last_message_at = NOW()`,
    [String(chatId), String(userId)],
  );
}

export async function bumpWarnedCount(chatId, userId) {
  const { rows } = await query(
    `UPDATE community_members
       SET warned_count = warned_count + 1
     WHERE chat_id = $1 AND user_id = $2
     RETURNING warned_count`,
    [String(chatId), String(userId)],
  );
  return rows[0]?.warned_count ?? 0;
}

/** True if member is still in quarantine. Treats non-members (e.g.
 *  was in chat before moderation existed) as NOT-quarantined. */
export async function inQuarantine(chatId, userId) {
  const m = await getMember(chatId, userId);
  if (!m) return false;
  if (!m.quarantine_until) return false;
  return new Date(m.quarantine_until) > new Date();
}

/** Rate limit for quarantined members. Returns ms-until-allowed
 *  if limited, else 0. */
export async function quarantineRateLimit(chatId, userId) {
  const m = await getMember(chatId, userId);
  if (!m || !m.last_message_at) return 0;
  const sinceLast = Date.now() - new Date(m.last_message_at).getTime();
  if (sinceLast >= QUARANTINE_RATE_LIMIT_MS) return 0;
  return QUARANTINE_RATE_LIMIT_MS - sinceLast;
}

export async function recordModAction(chatId, userId, action, reason, payload) {
  await query(
    `INSERT INTO community_mod_actions (chat_id, user_id, action, reason, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [String(chatId), String(userId), action, reason || null, payload?.slice?.(0, 2000) || null],
  );
}

/** Recent mod-action stats for the operator dashboard / anomaly alerts. */
export async function recentStats(chatId, sinceHours = 24) {
  const { rows } = await query(
    `SELECT action, COUNT(*)::int AS n
       FROM community_mod_actions
      WHERE chat_id = $1 AND created_at > NOW() - ($2 || ' hours')::interval
      GROUP BY action ORDER BY n DESC`,
    [String(chatId), String(sinceHours)],
  );
  return rows;
}
