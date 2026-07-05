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

// Well-known platforms a legit user naturally references when asking product
// questions (app stores, official Solana / Seeker, the major wallets, the
// router Magpie sells through, common explorers). These are NOT phishing
// vectors, so a question like "are you on the App Store / Seeker?" with a link
// must never be auto-deleted — and we don't even spend an LLM call judging it.
// Operator-mandated 2026-06-30: users should feel comfortable asking questions.
export const SAFE_REFERENCE_DOMAINS = [
  "apps.apple.com", "apple.com",        // Apple App Store
  "play.google.com",                    // Google Play
  "solanamobile.com",                   // Solana Mobile / Seeker (SKR)
  "solana.com",                         // official Solana
  "phantom.app", "solflare.com",        // official wallets users ask about
  "backpack.app", "jup.ag",             // Backpack wallet · Jupiter (our router)
  "solscan.io", "explorer.solana.com", "solana.fm", // block explorers
];

// Quarantine: new members can't post links/forwards and are rate-
// limited for this many days. Captcha must still be passed before
// the timer even starts.
export const QUARANTINE_DAYS = 7;
export const QUARANTINE_MS = QUARANTINE_DAYS * 24 * 3600 * 1000;
export const QUARANTINE_RATE_LIMIT_MS = 30 * 1000; // 1 msg / 30s

// Captcha timeout — fail to confirm in this window = auto-kick.
export const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;

// Display-name / username patterns that indicate someone is posing as
// official Magpie / Pip STAFF. Match is case-insensitive. The check runs only
// on non-allowlisted accounts (verified-account check excludes the bot +
// operator; cleared-user check excludes appeal winners).
//
// SCOPED DOWN 2026-06-27 (operator: "don't kick out regular users so freely").
// The old list auto-PERMABANNED on any of: a bare "magpie" substring (caught
// every fan — "MagpieFan42"), or a standalone generic word (support / admin /
// team / mod / dev / founder / owner — caught "CryptoDev", "Team Solana",
// real people). That nuked regular users. Now we ONLY flag clear BRAND
// impersonation: the (near-)exact brand name, OR the brand word adjacent to a
// staff/official role, OR "Pip" used in a staff capacity. A brand word ALONE
// or a generic role word ALONE is NOT enough. Residual edge cases self-heal
// via the instant /appeal flow + the cleared-users memory.
// Named Magpie protocol personas that must never be impersonated (e.g.
// "MagpieMatt"). Env-extensible (comma-separated PROTECTED_PERSONA_NAMES) so a
// new persona can be protected without a code change; "matt" is the default.
// Baseline personas are ALWAYS protected. The env var can ADD to them but must
// never be able to REPLACE/drop them — a stale or partial PROTECTED_PERSONA_NAMES
// silently un-protecting "matt" is exactly how a "Magpie Matt" impersonator can
// slip through (operator-flagged 2026-07-04). So we UNION baseline + env.
const PERSONA_BASELINE = ["matt"];
const PROTECTED_PERSONA_NAMES = [...new Set([
  ...PERSONA_BASELINE,
  ...(process.env.PROTECTED_PERSONA_NAMES || "")
    .split(",").map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean),
])];
const PERSONA_ALT = (PROTECTED_PERSONA_NAMES.length ? PROTECTED_PERSONA_NAMES : ["matt"]).join("|");

export const IMPERSONATION_PATTERNS = [
  // (Near-)exact brand name as the whole display name — no legitimate use.
  // Includes the GROUP name "Magpie Talk" + news/announcement/dev/exec poses.
  /^\s*magpie(\s*(capital|loans?|lending|finance|labs?|team|support|admin|official|mod|help|talk|news|bot|dev(?:eloper)?|cto|ceo|announce(?:ment)?s?))?\s*[.!]*$/i,
  // Brand word adjacent (any separator) to a staff / official / support role.
  // \b after the role so a FAN name ("Magpie Supporter", "Magpie Teammate")
  // does NOT match while staff poses ("Magpie Support", "Magpie Admin") do.
  /magpie[\s._@-]*(support|admin|team|mod(?:erator)?|official|help(?:\s*desk)?|staff|service|founder|owner|ceo|cto|dev(?:eloper)?|customer|talk|news|announce(?:ment)?s?|bot)\b/i,
  /\b(support|admin|official|staff|mod(?:erator)?|help\s*desk|customer\s*service)[\s._@-]*magpie\b/i,
  /\bofficial\s+magpie\b/i,
  // NOTE (operator 2026-06-30, "calm down on kicks"): we deliberately do NOT
  // name-ban a STANDALONE role word ("CTO", "Dev", "Support") with no "magpie"
  // — that over-banned real members (a "$Merlin CTO" / "Dev Dan" who never
  // impersonated Magpie). The rename attack the operator hit is specifically
  // "Magpie Talk" / "Magpie Dev" style (brand + role), which the brand-adjacent
  // patterns above already catch. A non-brand account that ACTUALLY scams
  // (DM-solicitation, screenshot, phishing link) is still caught + banned by
  // the behavior pipeline in handleGroupMessage — intent, not just a role word.
  // Impersonating a named protocol persona — "MagpieMatt", "Magpie Matt".
  new RegExp(`magpie[\\s._@-]*(${PERSONA_ALT})\\b`, "i"),
  new RegExp(`\\b(${PERSONA_ALT})[\\s._@-]*magpie\\b`, "i"),
  // Posing as the in-chat assistant "Pip" in a staff/bot capacity (bare "Pip"
  // is a real nickname, so it alone no longer triggers a ban).
  /\bpip[\s._@-]*(support|admin|official|bot|team|mod|help)\b/i,
  /\b(support|admin|official)[\s._@-]*pip\b/i,
];

// Homoglyphs / leetspeak an impersonator uses to dodge the brand filter
// ("Mаgpie" with a Cyrillic а, "0fficial", "M4gpie", "Ðeveloper" with a Latin
// Eth). Folded to ASCII before matching. This map holds ONLY the NON-decomposable
// specials (Ð ð Đ đ Ø ł ß Þ) + cross-script VISUAL homoglyphs (Cyrillic / Greek);
// the huge decomposable space (accented Latin é/à, fullwidth Ｄ, mathematical
// 𝐃/𝑫/𝔡, superscripts) is folded GENERICALLY by NFKD in foldConfusables below.
// Only VISUAL look-alikes are mapped (Cyrillic У→y not phonetic u, Н→h not n);
// ambiguous 1/l/i is left out to avoid mangling real names.
const CONFUSABLE_MAP = {
  // leetspeak / symbols
  "@": "a", "4": "a", "3": "e", "0": "o", "$": "s", "5": "s",
  // Latin specials NFKD does NOT decompose — the "Ðeveloper" class
  "Ð": "d", "ð": "d", "Đ": "d", "đ": "d", "Ø": "o", "ø": "o",
  "Ł": "l", "ł": "l", "ß": "b", "Þ": "p", "þ": "p", "ẞ": "b",
  // Cyrillic visual homoglyphs (look identical to the Latin letter)
  "А": "a", "а": "a", "ӓ": "a", "В": "b", "в": "b", "Е": "e", "е": "e", "Ё": "e", "ё": "e",
  "К": "k", "к": "k", "М": "m", "м": "m", "Н": "h", "н": "h", "О": "o", "о": "o",
  "Р": "p", "р": "p", "С": "c", "с": "c", "Т": "t", "т": "t", "Х": "x", "х": "x",
  "У": "y", "у": "y", "І": "i", "і": "i", "ӏ": "i", "Ј": "j", "ј": "j", "Ѕ": "s", "ѕ": "s",
  "ԁ": "d", "Ԁ": "d", "ɡ": "g",
  // Greek visual homoglyphs
  "Α": "a", "Β": "b", "Ε": "e", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n",
  "Ο": "o", "ο": "o", "Ρ": "p", "ρ": "p", "Τ": "t", "τ": "t", "Χ": "x", "Υ": "y",
  "ν": "v", "ⅼ": "l", "ӏ": "l",
};
// Invisible / format / bidi-override / variant-selector chars — pure obfuscation
// with no legit use inside a display name (zero-width space/joiner, RLO/LRO,
// VS15/16, BOM, soft hyphen). Stripped before folding so "De​veloper" and
// RTL-scrambled names collapse to their real letters.
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;
function foldConfusables(s) {
  if (!s) return "";
  let t = s.replace(INVISIBLE_CHARS, "");
  // NFKD + strip combining marks folds accented Latin, fullwidth, mathematical
  // alphanumeric, and superscripts to plain ASCII generically.
  try { t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); } catch { /* keep t */ }
  let out = "";
  for (const ch of t) out += CONFUSABLE_MAP[ch] ?? CONFUSABLE_MAP[ch.toLowerCase()] ?? ch;
  return out;
}

/** Every textual variant of a user's name we test against the impersonation
 *  patterns: each field + the COMBINED name (defeats split-across-fields like
 *  first="Mag", last="pie Support"), each in raw / unicode-normalized /
 *  homoglyph-folded / despaced form (defeats styled unicode, Cyrillic
 *  homoglyphs, and spaced-out "M a g p i e  S u p p o r t"). */
function impersonationVariants(user) {
  const fields = [user.username || "", user.first_name || "", user.last_name || ""].filter(Boolean);
  const bases = [...fields, fields.join(" ")].filter(Boolean);
  const out = new Set();
  for (const s of bases) {
    const norm = normalizeUnicode(s);
    const folded = foldConfusables(norm);
    out.add(s);
    out.add(norm);
    out.add(folded);
    out.add(folded.replace(/[\s._-]+/g, "")); // despaced
  }
  return [...out];
}

/** A stable, normalized key for a user's display name, used to SCOPE a
 *  clearance to the name that was reviewed — so an appeal winner can't later
 *  rename into "Magpie Support" and keep their immunity. */
export function nameKey(user) {
  if (!user) return "";
  const raw = [user.username, user.first_name, user.last_name].filter(Boolean).join(" ");
  return foldConfusables(normalizeUnicode(raw)).toLowerCase().replace(/\s+/g, " ").trim();
}

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
  // Fake token-MIGRATION / 1:1-allocation phishing (the "Ðeveloper" 2026-07-04
  // post). These are SIGNALS into Pip's allow-biased judge (not auto-delete),
  // and each requires scam STRUCTURE (authority + allocation + redirect), so
  // real governance / distribution / holder-reward discussion isn't flagged.
  /\b1\s*[:：]\s*1\s+(?:token\s+)?(?:allocation|swap|claim|distribution)\b/i,
  /\btransition(?:ing)?\s+to\s+(?:an?\s+)?(?:new|upgraded|revised|different)\s+(?:token\s+)?(?:structure|contract|standard|system)\b/i,
  /\b(?:eligible|qualif(?:y|ied))\s+for\s+(?:an?\s+)?(?:1\s*[:：]\s*1\s+)?(?:token\s+)?(?:allocation|airdrop|distribution)\b/i,
  /\b(?:reach\s+out\s+to|contact|message|dm|pm)\s+(?:our\s+)?(?:dev(?:eloper)?s?|admin(?:istrator)?s?|support|team|moderators?|mods?)\b.*\b(?:for|to\s+(?:get|receive))\b.*\b(?:instructions?|next\s+steps?|details?|how\s+to\s+proceed|guidance|allocation)\b/i,
  /\bclaim\s+(?:your\s+)?(?:new\s+|token\s+)?allocation\b/i,
  /\bofficial\s+(?:update|announcement)\s+(?:regarding|about|on)\b.*\b(?:token|migration|upgrade|allocation|snapshot|phase)\b/i,
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
    // Well-known safe platforms (app stores, Solana, wallets, explorers) —
    // referenced in honest product questions, not phishing vectors.
    if (SAFE_REFERENCE_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return true;
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

// ── Fuzzy brand-lookalike layer (operator-mandated 2026-07-04) ───────────────
// The literal-"magpie" IMPERSONATION_PATTERNS above only match the EXACT string
// "magpie" (after homoglyph folding). They MISS deliberate misspellings and
// transpositions the operator called out — "Mapgie", "Magpei", "Mgpie" — plus
// doubled letters ("Maggpie") and separators the despace pass doesn't strip
// (zero-width, emoji). This layer collapses the name to bare a-z0-9 and
// fuzzy-matches the brand root, catching lookalikes too.
//
// HIGH-PRECISION so real members are safe: a fuzzy brand hit is a ban ONLY when
// (A) the whole name is an exact letter-scramble of the brand (an anagram — a
// real word almost never is), or (B/C) the lookalike sits next to a staff/
// persona role word. A lone near-miss like "Maggie" is NOT banned. Residual
// false positives self-heal via the instant /appeal flow.
const BRAND_ROOT = "magpie";
const _BRAND_SORTED = BRAND_ROOT.split("").sort().join("");
const IMPERSONATION_ROLE_WORDS = new Set([
  ...PROTECTED_PERSONA_NAMES,
  "support", "admin", "team", "mod", "moderator", "official", "help", "helpdesk",
  "staff", "service", "founder", "owner", "ceo", "cto", "dev", "developer",
  "customer", "talk", "news", "announce", "announcement", "announcements", "bot",
  "capital", "loans", "loan", "lending", "finance", "labs", "lab",
]);

function collapseToAlnum(s) {
  return foldConfusables(normalizeUnicode(s || "")).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function alnumTokens(s) {
  return foldConfusables(normalizeUnicode(s || "")).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
// Bounded Damerau-Levenshtein (adjacent transposition counts as 1 edit).
function damerau(a, b) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > 2) return 3;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}
// An exact letter-scramble of the brand — very high signal it's deliberate.
function isBrandAnagram(tok) {
  return tok.length === BRAND_ROOT.length && tok !== BRAND_ROOT &&
    tok.split("").sort().join("") === _BRAND_SORTED;
}
// A near-miss of the brand (<=1 edit or an anagram). Used ONLY alongside a role
// word (except the anagram case) so real names like "Maggie" are never banned.
function isBrandLookalike(tok) {
  if (tok.length < 5 || tok.length > 8) return false;
  if (tok === BRAND_ROOT) return true;
  if (isBrandAnagram(tok)) return true;
  return damerau(tok, BRAND_ROOT) <= 1;
}

/** Fuzzy impersonation catch — deliberate brand misspellings / lookalikes that
 *  the exact IMPERSONATION_PATTERNS miss (e.g. "Mapgie", "Magpei Admin"). */
export function isBrandLookalikeImpersonation(user) {
  if (!user) return false;
  const combined = [user.username || "", user.first_name || "", user.last_name || ""]
    .filter(Boolean).join(" ");
  const full = collapseToAlnum(combined);
  if (!full) return false;
  // (A) whole collapsed name is a brand scramble → deliberate ("Mapgie","Magpei").
  if (isBrandAnagram(full)) return true;
  // (B) collapsed name is <lookalike-brand><role> or <role><lookalike-brand>
  //     ("mapgiematt", "magpesupport", "adminmagpe") — defeats zero-width spacing.
  for (const role of IMPERSONATION_ROLE_WORDS) {
    if (role.length < 2 || full.length <= role.length) continue;
    if (full.endsWith(role) && isBrandLookalike(full.slice(0, full.length - role.length))) return true;
    if (full.startsWith(role) && isBrandLookalike(full.slice(role.length))) return true;
  }
  // (C) token level: a lookalike-brand token AND a separate role token.
  const toks = alnumTokens(combined);
  if (toks.some(isBrandLookalike) && toks.some((t) => IMPERSONATION_ROLE_WORDS.has(t))) return true;
  return false;
}

// Role / brand words that must never be spelled with HOMOGLYPHS. A PLAIN-ASCII
// role word ("Developer", "CryptoDev", "Team Solana") is deliberately allowed
// (operator 2026-06-30, "don't ban standalone role words") — the malice signal
// is the DISGUISE: a name that uses non-ASCII look-alikes to spell one of these
// is impersonation, full stop (a real member types "Developer", never
// "Ðeveloper"). Env-extensible via HOMOGLYPH_PROTECTED_WORDS.
const HOMOGLYPH_PROTECTED_WORDS = new Set([
  "magpie", "pip", ...PROTECTED_PERSONA_NAMES,
  "developer", "developers", "dev", "devs", "admin", "administrator", "support",
  "supporter", "staff", "official", "moderator", "mod", "team", "help", "helpdesk",
  "service", "customer", "founder", "owner", "ceo", "cto", "bot", "announcement",
  "announcements", "announce", "partner", "verified", "trust",
  ...(process.env.HOMOGLYPH_PROTECTED_WORDS || "")
    .split(",").map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean),
]);

/** Catch a name that uses HOMOGLYPHS / confusables to spell a protected role or
 *  brand word — "Ðeveloper" (Latin Eth), "Аdmin" (Cyrillic А), "Ｍagpie"
 *  (fullwidth). Precise by construction: fires ONLY when a token folds to a
 *  protected word AND the fold actually CHANGED it (i.e. a look-alike was used),
 *  so a plain-ASCII role word and normal names ("José Developer") are untouched. */
export function isHomoglyphDisguisedImpersonation(user) {
  if (!user) return false;
  const fields = [user.username || "", user.first_name || "", user.last_name || ""].filter(Boolean);
  for (const raw of [...fields, fields.join(" ")]) {
    if (!raw) continue;
    // Per-token so a homoglyph in ONE word (the disguised role word) is caught
    // without a real accented word elsewhere ("José") tripping it. Also test the
    // whole despaced string (defeats "Ð e v e l o p e r" letter-spacing).
    const rawToks = raw.split(/[\s._@\-]+/).filter(Boolean);
    for (const rawTok of [...rawToks, raw.replace(/[\s._@\-]+/g, "")]) {
      const cleanRaw = rawTok.toLowerCase().replace(/[^a-z0-9]/g, "");        // ASCII-only part of the raw
      const folded = foldConfusables(normalizeUnicode(rawTok)).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!folded || folded === cleanRaw) continue;                           // no look-alike used → allowed
      if (HOMOGLYPH_PROTECTED_WORDS.has(folded)) return true;                 // disguised protected word → ban
    }
  }
  return false;
}

export function isImpersonationName(user) {
  if (!user) return false;
  // Test raw + unicode-normalized + homoglyph-folded + despaced + combined-field
  // variants so "Mаgpie Support" (Cyrillic), "𝗠𝗮𝗴𝗽𝗶𝗲 𝗦𝘂𝗽𝗽𝗼𝗿𝘁", "M a g p i e
  // Support", and first="Mag"/last="pie Support" are all caught.
  for (const c of impersonationVariants(user)) {
    for (const re of IMPERSONATION_PATTERNS) {
      if (re.test(c)) return true;
    }
  }
  // Fuzzy layer — deliberate misspellings / lookalikes ("Mapgie", "Magpei Admin").
  if (isBrandLookalikeImpersonation(user)) return true;
  // Homoglyph-disguised role/brand word ("Ðeveloper", "Аdmin", "Ｍagpie").
  if (isHomoglyphDisguisedImpersonation(user)) return true;
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

/**
 * Narrow DM-solicitation matcher for the screenshot-scam ban (operator
 * 2026-06-30): a PHOTO whose caption/text solicits a DM ("DM me", "message
 * us", "hit me up", "contact admin") is the canonical "DM me to claim/recover"
 * phishing setup — that gets BANNED, not merely warned. Tests raw +
 * unicode-normalized so math-bold/Cyrillic obfuscation can't dodge it.
 */
export function matchesDmSolicitation(text) {
  if (!text) return null;
  const pats = [
    /\b(?:dm|direct\s*message|pm|private\s*message|message|msg|text|contact|reach)\s*(?:me|us|out|admin|support|the\s*team)\b/i,
    /\bhit\s+me\s+up\b/i,
    /\bsend\s+me\s+a\s+(?:dm|message|pm)\b/i,
  ];
  for (const t of [text, normalizeUnicode(text)]) {
    if (!t) continue;
    for (const re of pats) if (re.test(t)) return re.source;
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
  const res = await query(
    `INSERT INTO community_mod_actions (chat_id, user_id, action, reason, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [String(chatId), String(userId), action, reason || null, payload?.slice?.(0, 2000) || null],
  );
  // Returned so a caller (e.g. a mute) can offer a one-tap appeal that
  // references this exact action. Existing callers ignore it harmlessly.
  return res.rows?.[0]?.id ?? null;
}

/* ───────────────────────── CLEARED USERS (Pip's memory) ─────────────────────
 * A user the moderator should NOT auto-remove again — appeal winners and
 * operator /unban-s. The name-ban, captcha-kick, and impersonator watchdog all
 * consult isUserCleared() and skip cleared accounts, so a re-admitted member
 * can't be instantly re-banned for the same name. Behavioral moderation (scam
 * links/phrases, FUD) still runs — clearance is NOT a pass to misbehave.
 * ──────────────────────────────────────────────────────────────────────────*/

/** Remember that this user has been cleared (idempotent UPSERT). `clearedName`
 *  is the nameKey() that was reviewed — pass it for appeal clearances so the
 *  clearance is SCOPED to that name; null = name-agnostic (operator /unban). */
export async function markUserCleared(chatId, userId, by = "pip_appeal", reason = null, clearedName = null) {
  await query(
    `INSERT INTO community_cleared_users (chat_id, user_id, cleared_by, reason, cleared_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chat_id, user_id) DO UPDATE
       SET cleared_by = EXCLUDED.cleared_by, reason = EXCLUDED.reason,
           cleared_name = EXCLUDED.cleared_name, cleared_at = NOW()`,
    [String(chatId), String(userId), by, reason ? String(reason).slice(0, 300) : null,
     clearedName ? String(clearedName).slice(0, 200) : null],
  );
}

/** True if this user is cleared for the chat. Fail-open to false (a DB blip
 *  must never cause a MISSED removal of a real scammer).
 *  `currentNameKey`: when provided, a NAME-SCOPED clearance (cleared_name set)
 *  is honored ONLY if the user's current name still matches the reviewed name —
 *  so an appeal winner can't rename into "Magpie Support" and keep immunity.
 *  Operator /unban clearances are name-agnostic (cleared_name NULL) and always
 *  honored. Omit currentNameKey for paths where the name is irrelevant. */
export async function isUserCleared(chatId, userId, currentNameKey = null) {
  try {
    if (currentNameKey == null) {
      const r = await query(
        `SELECT 1 FROM community_cleared_users WHERE chat_id = $1 AND user_id = $2 LIMIT 1`,
        [String(chatId), String(userId)],
      );
      return r.rows.length > 0;
    }
    const r = await query(
      `SELECT 1 FROM community_cleared_users
        WHERE chat_id = $1 AND user_id = $2
          AND (cleared_name IS NULL OR cleared_name = $3) LIMIT 1`,
      [String(chatId), String(userId), currentNameKey],
    );
    return r.rows.length > 0;
  } catch (err) {
    console.warn("[community] isUserCleared check failed (treating as not-cleared):", err.message);
    return false;
  }
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
