/**
 * Community INTENT judge — "Pip's best judgement on every post."
 *
 * Operator mandate 2026-06-30 (verbatim intent):
 *   "We dont want people soliciting services and scamming. However, if
 *    they are asking clear questions or giving ideas or showing interest
 *    in the Magpie platform, we cant just delete their posts or boot
 *    them. Pip really needs to use their best judgement with every
 *    single post."
 *
 * Design: the coarse filters (link allowlist, scam-phrase regex,
 * unofficial-handle mentions, service-solicitation markers) only ever
 * FLAG a post. This judge then makes the real call:
 *   - KEEP   → genuine question / idea / feature request / interest /
 *              criticism / normal chat. The overwhelming default.
 *   - REMOVE → an actual scam (phishing/drainer link, seed-phrase or
 *              private-key bait, "DM me to claim", fake airdrop,
 *              impersonating Magpie support) OR unsolicited service
 *              solicitation / shilling another project for gain.
 *
 * Heavy ALLOW bias: removing a genuine user is FAR more damaging than
 * letting one borderline post slide (other nets + human review catch the
 * rare miss). The judge only removes when clearly confident.
 *
 * Cost: Haiku, ~$0.0002 per call. Runs on posts a coarse filter flagged, PLUS
 * (2026-07-04) a proactive pass on substantive messages from brand-new accounts
 * even when nothing flagged them — so a NOVEL scam method with no known pattern
 * still gets judged. Only fresh accounts qualify (see NEW_MEMBER_JUDGE_* in
 * community-handlers), so steady-state cost stays a few cents a day.
 */

const JUDGE_MODEL = "claude-haiku-4-5-20251001";

// Unambiguous scam phrasing — used as the fail-CLOSED fallback when the
// LLM is unreachable (a real person almost never types these). Everything
// softer fails OPEN (kept) so an LLM blip never deletes a genuine user.
export const HARD_SCAM_RE =
  /\b(?:seed\s*phrase|secret\s*recovery\s*phrase|private\s*key|wallet\s*passphrase)\b|\bsend\s+(?:me\s+)?\d+(?:\.\d+)?\s*sol\b|\bconnect\s+(?:your\s+)?wallet\s+to\s+claim\b|\b(?:claim|verify|validate|sync)\s+(?:your\s+)?wallet\b|\bwallet\s+(?:validation|drainer|sync)\b/i;

// Cheap pre-filter for service SOLICITATION / promo that the scam regex
// does NOT cover (offering paid services, shilling, recruitment). Firing
// this only QUEUES the post for Pip's judgement — it never deletes alone.
const SOLICITATION_MARKERS = [
  /\b(?:offer|offering|provide|providing|selling|sell)\s+(?:cheap\s+)?(?:services?|promo(?:tion)?|marketing|smm|shilling|signals?|followers?|members?|likes?|views?|bots?)\b/i,
  /\b(?:dm|pm|message|contact|hit)\s+me\b[^.!?\n]{0,40}\b(?:promo|price|rate|service|marketing|shill|pump|listing|collab|deal|cheap)\b/i,
  /\b(?:promo(?:tion)?|marketing|shilling|listing|pump)\s+(?:service|package|deal|available|for\s+your)\b/i,
  /\b(?:cheap|affordable|bulk)\s+(?:followers?|members?|likes?|views?|subscribers?|telegram\s+members?)\b/i,
  /\b(?:we|i)\s+(?:can|will)\s+(?:promote|market|shill|pump|list)\s+your\b/i,
  /\b(?:trading|crypto|forex|investment)\s+signals?\b/i,
  /\b(?:guaranteed?|guarantee)\s+(?:profit|returns?|roi|gains?)\b/i,
];

/** Whether a (non-scam-flagged) message looks like service solicitation
 *  worth Pip's judgement. Keep tight — false positives just cost a cheap
 *  LLM call (the judge still has the final, allow-biased say). */
export function hasSolicitationSignal(text) {
  if (!text || text.length < 6) return false;
  for (const re of SOLICITATION_MARKERS) {
    if (re.test(text)) return true;
  }
  return false;
}

const JUDGE_PROMPT = `You are Pip, the community steward for Magpie Capital's Telegram group. Magpie is a permissionless Solana lending protocol — borrow SOL against your tokens, and (on V4 loans) set on-chain auto-sell orders on that same collateral. You are looking at ONE message that a coarse filter flagged, and you decide whether it should be KEPT or REMOVED.

Community values, in priority order:
1. Real people must feel WELCOME to ask questions, float ideas, request features, show interest, or voice criticism — even bluntly or with a link. NEVER remove these.
2. Remove ONLY:
   (a) SCAMS — phishing / wallet-drainer links, seed-phrase or private-key requests, "send me X SOL", "DM me to claim/recover/verify", fake airdrops/giveaways, or anyone impersonating Magpie support/admin/team to redirect users.
   (b) UNSOLICITED SOLICITATION — offering paid services (marketing, dev-for-hire, SMM, "cheap followers", trading/pump signals), shilling or promoting ANOTHER token/project/group for gain, recruitment spam.

Output STRICTLY one JSON object and nothing else:
{"action":"keep"|"remove","category":"genuine_question"|"idea_or_feedback"|"interest"|"criticism"|"chitchat"|"scam"|"solicitation"|"spam"|"unclear","confidence":0.0-1.0,"reason":"<one short sentence>"}

DECISION RULES:
- A message that asks a question about Magpie, proposes an idea / feature, or shows interest → KEEP, even if it includes a link or names another product as context. Example: "are you guys building an App Store / Seeker (Solana mobile) app? <link>" → KEEP (genuine_question). "what wallets do you support?" → KEEP.
- A link only justifies "remove" when the message's PURPOSE is to make people click a scam/phishing/promo link. A reference link to a well-known platform (app store, solana.com, a wallet, an exchange, a block explorer) inside a real question → KEEP.
- Criticism of Magpie (fees, risk, "this is broken", "support is slow") → KEEP. Honest concerns are healthy.
- Normal chat, memes, gm, price talk → KEEP.
- When unsure, KEEP. Removing a genuine user is far worse than letting one borderline post through. Only choose "remove" when you are clearly confident (confidence >= 0.8) it is a scam or solicitation.`;

/**
 * Run Pip's judgement on a flagged message.
 * Returns { action, category, confidence, reason } or null on failure.
 * Null means "could not judge" — the CALLER decides the fail-open/closed
 * direction per signal (see community-handlers).
 */
export async function judgeCommunityPost(text, context = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const snippet = String(text || "").slice(0, 1500);
  if (!snippet) return null;

  const lines = [];
  if (context.signal) lines.push(`Why it was flagged: ${context.signal}`);
  if (context.member_age_hours != null) {
    lines.push(`Sender joined the group: ${context.member_age_hours.toFixed(1)}h ago`);
  }
  if (context.has_link) lines.push(`The message contains a link.`);
  const userMessage = lines.length
    ? `${lines.join("\n")}\n\nMessage:\n${snippet}`
    : `Message:\n${snippet}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 200,
        temperature: 0,
        system: JUDGE_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[intent-judge] HTTP", res.status, "→ fail-open");
      return null;
    }
    const body = await res.json();
    const txt = Array.isArray(body?.content) ? body.content[0]?.text : null;
    if (!txt) return null;
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const action = String(parsed.action || "keep").toLowerCase();
    const category = String(parsed.category || "unclear").toLowerCase().slice(0, 40);
    const confidence = Number(parsed.confidence) || 0;
    const reason = String(parsed.reason || "").slice(0, 300);
    if (action !== "keep" && action !== "remove") return null;
    return { action, category, confidence, reason };
  } catch (err) {
    console.warn("[intent-judge] error → fail-open:", err.message);
    return null;
  }
}

/** Threshold gate: only treat a verdict as REMOVE when Pip is confident.
 *  Anything below the bar (or a "keep") stays. */
export function isConfidentRemoval(verdict) {
  return !!verdict && verdict.action === "remove" && verdict.confidence >= 0.75;
}
