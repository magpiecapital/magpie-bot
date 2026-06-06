/**
 * FUD / bad-intent classifier for community moderation.
 *
 * Design philosophy: be SLOW to act, FAST to flag. False positives
 * here are more damaging than letting some FUD slide — auto-deleting
 * legitimate criticism turns the community into an echo chamber that
 * users (correctly) won't trust.
 *
 * Tiered actions:
 *   - "criticism"        → NO action. Honest concerns are healthy.
 *   - "spam"             → delete only. No warn.
 *   - "misinformation"   → delete + soft warn. Factually wrong claims.
 *   - "harassment"       → delete + 24h mute. Slurs / personal attacks.
 *   - "coordinated_fud"  → delete + DM operator. Looks like a campaign.
 *   - "ban_worthy"       → delete + flag operator for manual ban
 *                          (we NEVER auto-permaban).
 *
 * Cost control:
 *   - LLM classification ONLY runs when a cheap regex pre-filter hits
 *     a negative-sentiment marker. ~5-10% of group messages.
 *   - Haiku model (~$0.0001 per classify, well under a penny per
 *     borderline message)
 *
 * Auditability:
 *   - Every classification + action logged to community_mod_actions
 *     with the model's stated reason. Operator can review via
 *     /community_status.
 */

// Cheap pre-filter — only run the LLM on messages that contain
// at least one of these markers. Reduces classifier cost by ~95%.
// Keep the list tight: false-positives at this stage cost real
// Anthropic dollars, false-negatives are fine (we'd rather under-
// classify than aggressively scan every message).
const SENTIMENT_MARKERS = [
  /\b(scam|scammer|rug|rugged|rugpull|fake|fraud|sham|ponzi|honeypot)\b/i,
  /\b(stolen|stole|theft|hacked|ripoff|rip[\s-]?off)\b/i,
  /\b(lie|liar|lying|liars|bullshit|bs)\b/i,
  /\b(garbage|trash|terrible|awful|worthless|useless|dead)\b/i,
  /\bdyor\s*=\s*don't\b/i,         // "DYOR = don't" — classic FUD opener
  /\bavoid\s+(?:magpie|this)\b/i,
  /\bstay\s+away\s+from\b/i,
  /\bnever\s+use\s+(?:magpie|this)\b/i,
  /\b(?:retard|moron|idiot|dumb)\b/i,
];

const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

const CLASSIFIER_PROMPT = `You moderate the Magpie Capital community Telegram group. Your job is to triage a single user message into ONE bucket. Magpie is a permissionless Solana lending protocol — users can have real concerns about volatility, fees, smart-contract risk, etc., and those are LEGITIMATE.

Output STRICTLY a single JSON object, no surrounding text:
{"verdict": "<bucket>", "confidence": 0.0-1.0, "reason": "<one short sentence>"}

BUCKETS (in order of severity):

"none"
  Default. Use whenever in doubt. Includes:
  - Honest criticism, concerns, questions ("isn't this risky?", "what if X dumps?", "fees seem high")
  - Bad experiences ("I lost money on a memecoin loan, not great")
  - Frustration without misinfo ("this is annoying", "fix the UI please")
  - Sarcasm + jokes
  - Mild venting

"spam"
  Off-topic shilling of OTHER projects, "join my group", repeated
  posting of the same content. NOT criticism of Magpie.

"misinformation"
  Demonstrably FALSE factual claim about Magpie. Examples:
  - "Magpie liquidates at 50% LTV" (false; tiers are 20/25/30%)
  - "Magpie steals your seed phrase" (false; non-custodial)
  - "Magpie just rugged" (false; protocol is live + on-chain verifiable)
  - "Repaying loans doesn't return collateral" (false)
  NOT: speculation, opinions, predictions. ONLY testable factual
  claims that contradict on-chain reality.

"harassment"
  Personal attacks, slurs, threats, doxxing, sexual harassment.
  Targets a specific person (operator, dev, other user) with
  intent to demean. Strong/vulgar criticism of THE PROTOCOL is
  NOT harassment — it's criticism.

"coordinated_fud"
  Signs of an organized push: identical phrasing from multiple
  fresh accounts, sudden cluster of "Magpie is dying" posts, links
  to "exposé" threads. Single-account anger is NOT this — that's
  just one frustrated user.

"ban_worthy"
  Egregious: slurs, NSFW, threats of violence, repeated harassment
  after a warning. Bar must be HIGH — we don't auto-permaban for
  vibes.

If you're unsure between two buckets, pick the LESS severe one.
False positives chill the community more than missed FUD.`;

/** Whether the message contains a pre-filter signal worth LLM-classifying. */
export function hasSentimentSignal(text) {
  if (!text || text.length < 4) return false;
  for (const re of SENTIMENT_MARKERS) {
    if (re.test(text)) return true;
  }
  return false;
}

/** Run the Haiku classifier on a message. Returns the verdict + a
 *  recommended action, or null on any failure (fail-open). */
export async function classifyMessage(text, context = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const snippet = String(text || "").slice(0, 1500);
  if (!snippet) return null;

  const contextLines = [];
  if (context.member_age_hours != null) {
    contextLines.push(`Sender joined the group: ${context.member_age_hours.toFixed(1)}h ago`);
  }
  if (context.warned_count) {
    contextLines.push(`Prior auto-warnings on this user: ${context.warned_count}`);
  }
  if (context.in_quarantine) {
    contextLines.push(`Still in new-member quarantine`);
  }
  const userMessage = contextLines.length
    ? `Context:\n${contextLines.join("\n")}\n\nMessage:\n${snippet}`
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
        model: CLASSIFIER_MODEL,
        max_tokens: 200,
        temperature: 0,
        system: CLASSIFIER_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[fud-classifier] HTTP", res.status, "→ fail-open");
      return null;
    }
    const body = await res.json();
    const txt = Array.isArray(body?.content) ? body.content[0]?.text : null;
    if (!txt) return null;
    // Extract JSON. Haiku usually returns clean JSON.
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const verdict = String(parsed.verdict || "none").toLowerCase();
    const confidence = Number(parsed.confidence) || 0;
    const reason = String(parsed.reason || "").slice(0, 300);
    const valid = ["none", "spam", "misinformation", "harassment", "coordinated_fud", "ban_worthy"];
    if (!valid.includes(verdict)) return null;
    return { verdict, confidence, reason };
  } catch (err) {
    console.warn("[fud-classifier] error → fail-open:", err.message);
    return null;
  }
}

/** Map a classifier verdict to a concrete moderation action. The
 *  conservative half of the design lives here — auto-ban is never
 *  returned; the highest tier flags the operator for a human call. */
export function actionForVerdict({ verdict, confidence }) {
  // Confidence threshold — require at least 0.75 to act on anything
  // beyond "none". Lower confidence = no action, classification is
  // still logged for audit.
  const HIGH_CONFIDENCE = 0.75;

  if (confidence < HIGH_CONFIDENCE) return { action: "skip", warn: false, mute_sec: 0, flag_operator: false };

  switch (verdict) {
    case "spam":
      return { action: "delete", warn: false, mute_sec: 0, flag_operator: false };
    case "misinformation":
      return { action: "delete", warn: true, mute_sec: 0, flag_operator: false };
    case "harassment":
      return { action: "delete", warn: true, mute_sec: 24 * 3600, flag_operator: true };
    case "coordinated_fud":
      return { action: "delete", warn: false, mute_sec: 0, flag_operator: true };
    case "ban_worthy":
      // We don't auto-ban. Flag for operator review, delete the msg.
      return { action: "delete", warn: false, mute_sec: 60 * 60, flag_operator: true };
    case "none":
    default:
      return { action: "skip", warn: false, mute_sec: 0, flag_operator: false };
  }
}
