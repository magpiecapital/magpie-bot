/**
 * community-appeals.js — Pip-reviewed moderation appeals.
 * ──────────────────────────────────────────────────────────────────────────
 * A muted member taps "⚖️ Appeal"; this re-reviews the ORIGINAL auto-moderation
 * decision with full context and a deliberately skeptical, false-positive-aware
 * prompt, then returns overturn / uphold + a confidence. The handler lifts the
 * mute on a confident overturn, posts the reason to the user on a confident
 * uphold, and escalates to the operator ONLY when Pip is genuinely unsure — so
 * the operator stops being the first responder for every auto-mute.
 *
 * Fail-safe: if the model is unavailable or errors, we return null and the
 * caller escalates to a human. We never auto-uphold blindly on an error.
 */
import { query } from "../db/pool.js";

const REVIEW_MODEL =
  process.env.APPEAL_REVIEW_MODEL ||
  process.env.COMMUNITY_CLASSIFIER_MODEL ||
  "claude-sonnet-4-6";

// Below this confidence, the decision is treated as "unsure" → escalate to a
// human instead of auto-acting. Tunable without a redeploy.
export const APPEAL_ESCALATE_BELOW = Number(process.env.APPEAL_ESCALATE_BELOW || 0.6);

const SYSTEM_PROMPT = `You are Pip, the appeals reviewer for the Magpie ($MAGPIE) Solana lending community on Telegram.

A member's message or image was auto-actioned (deleted and/or muted) by automated moderation, and they are appealing. Automated moderation OVER-FLAGS — your job is to catch its false positives while still upholding genuine violations. Default posture: protect real members. When the flagged content is plausibly legitimate, OVERTURN.

OVERTURN (lift the mute) when the content is plausibly legitimate, e.g.:
- Sharing a screenshot of a scammer / impersonator to WARN others (the member is alerting the group, NOT impersonating anyone themselves).
- An honest question, a factual correction, or normal criticism misread as "misinformation" or "FUD".
- Benignly naming an official account, a competitor, or a third-party handle.
- Venting, sarcasm, or heated-but-civil disagreement that isn't actual harassment.
- The member already has a Magpie wallet / is an established trusted member and the content is borderline.

UPHOLD (the action stands) when it is a clear violation, e.g.:
- Actual phishing / scam promotion: "DM me", "send X SOL", "claim airdrop", wallet-drainer or fake-support links, seed-phrase requests.
- Real impersonation: the member is claiming to BE Magpie / Magpie support.
- Genuine harassment, slurs, threats, NSFW or violent imagery.
- Clear bad-faith coordinated FUD designed to manipulate, not honest concern.

You will receive: the moderation verdict, the auto-confidence, the flagged text/OCR, the member's prior-warning count and trusted status, and (optionally) the member's own explanation. Weigh the member's explanation but do not let a clever explanation excuse content that is plainly a scam.

Reply with STRICT JSON only, no prose:
{"decision":"overturn"|"uphold","explanation":"<one short plain-English sentence addressed to the member, <=240 chars>","confidence":<0..1, how sure you are of THIS decision>}
If you are genuinely unsure, return your best decision but a LOW confidence — a human will then make the final call.`;

/** Pull the human-readable flagged content out of a mod-action payload.
 *  image-mod stores plain OCR text; the FUD path stores JSON {verdict,text}. */
export function extractFlaggedText(payload) {
  if (!payload) return "";
  try {
    const j = JSON.parse(payload);
    if (j && typeof j === "object" && typeof j.text === "string") return j.text;
  } catch { /* not JSON — fall through to plain text */ }
  return String(payload);
}

/** Run Pip's appeal review. Returns {decision, explanation, confidence} or
 *  null on any failure (caller escalates to a human). */
export async function reviewAppealWithPip({ verdict, reason, flaggedText, warnedCount, trusted, userReason }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const lines = [
    `Moderation verdict: ${verdict || "(unknown)"}`,
    reason ? `Auto-moderator reason: ${String(reason).slice(0, 300)}` : null,
    `Member prior warnings: ${warnedCount ?? 0}`,
    `Member has a Magpie wallet (trusted): ${trusted ? "yes" : "no"}`,
    "",
    "Flagged content (text / OCR):",
    (flaggedText ? String(flaggedText).slice(0, 1500) : "(none / image with no extractable text)"),
  ];
  if (userReason) {
    lines.push("", "Member's appeal explanation:", String(userReason).slice(0, 700));
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        max_tokens: 300,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: lines.filter((l) => l !== null).join("\n") }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn("[appeals] review HTTP", res.status, "→ escalate");
      return null;
    }
    const body = await res.json();
    const txt = Array.isArray(body?.content) ? body.content[0]?.text : null;
    if (!txt) return null;
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const decision = String(parsed.decision || "").toLowerCase();
    if (decision !== "overturn" && decision !== "uphold") return null;
    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    const explanation = String(parsed.explanation || "").slice(0, 280);
    return { decision, explanation, confidence };
  } catch (err) {
    console.warn("[appeals] review error → escalate:", err.message);
    return null;
  }
}

// ── persistence (idempotent per mod action) ──────────────────────────────────

/** The mod action being appealed (verdict in `action`, flagged text in `payload`). */
export async function loadModAction(modActionId) {
  const r = await query(
    `SELECT id, chat_id, user_id, action, reason, payload, created_at
       FROM community_mod_actions WHERE id = $1`,
    [modActionId],
  );
  return r.rows[0] || null;
}

/** Open (or fetch) the appeal for a mod action. One appeal per action — the
 *  UNIQUE(mod_action_id) makes a double-tap return the existing record rather
 *  than re-running a review. Returns {row, isNew}. */
export async function openAppeal(modActionId, chatId, userId) {
  const ins = await query(
    `INSERT INTO community_appeals (mod_action_id, chat_id, user_id, status)
     VALUES ($1, $2, $3, 'reviewing')
     ON CONFLICT (mod_action_id) DO NOTHING
     RETURNING *`,
    [modActionId, String(chatId), String(userId)],
  );
  if (ins.rows[0]) return { row: ins.rows[0], isNew: true };
  const cur = await query(`SELECT * FROM community_appeals WHERE mod_action_id = $1`, [modActionId]);
  return { row: cur.rows[0] || null, isNew: false };
}

export async function resolveAppeal(modActionId, { status, decision, reason, confidence }) {
  await query(
    `UPDATE community_appeals
        SET status = $2, decision = $3, reason = $4, confidence = $5, resolved_at = NOW()
      WHERE mod_action_id = $1`,
    [modActionId, status, decision || null, reason ? String(reason).slice(0, 500) : null, confidence ?? null],
  );
}
