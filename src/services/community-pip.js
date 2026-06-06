/**
 * Pip — group-mode Q&A.
 *
 * A deliberately isolated answer path for community-group questions.
 * Cannot access any user-specific data, by design:
 *   - No DB writes
 *   - No `userId` / wallet lookups
 *   - No tool calling — single Anthropic round-trip
 *   - System prompt explicitly tells the model "you can't see who's
 *     asking. Personal questions get redirected to DM."
 *
 * Why a separate path (not chatWithAgent with a flag)?
 *   - chatWithAgent is the agentic loop with tools that touch the DB
 *     (loans, wallets, holder pool, etc.). Reusing it in a group with
 *     a "skip tools" flag is one bug away from leaking private state
 *     into a public channel. Separate function = no shared surface.
 *
 * Cost shape:
 *   - 1 Anthropic call per /ask, capped at 350 output tokens
 *   - Protocol-stats snapshot refreshes once a minute (1 DB read/min,
 *     not 1 per question)
 *   - Sonnet for tone quality; switch to Haiku if cost becomes an issue
 */
import { query } from "../db/pool.js";

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.AI_SUPPORT_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 350;

const GROUP_SYSTEM_PROMPT = `You are Pip — Magpie Capital's AI agent — answering a question in the public Magpie community group on Telegram.

CRITICAL — you are in a PUBLIC GROUP chat:
- You CANNOT see who is asking. You have no wallet, no loans, no balances, no credit score for them.
- If someone asks anything personal ("show my loans", "what's my credit", "did my tx land"), DO NOT pretend to know. Redirect them: "Hop into a DM with @magpie_capital_bot for anything tied to your account — I can't see personal info from the group."
- You CAN answer general protocol questions, token info, fees, how things work, etc.
- Keep answers SHORT — 1-3 sentences. Group chat is not the place for essays.
- One emoji per message MAX, only if it adds something.

PROTOCOL FACTS (use these for any "how does X work" question):
- Magpie is a permissionless Solana lending protocol. Users lock approved tokens as collateral, get SOL in seconds.
- 3 loan tiers:
    • Express: 30% LTV · 2-day term · 3% fee
    • Quick:   25% LTV · 3-day term · 2% fee
    • Standard: 20% LTV · 7-day term · 1.5% fee
- Fee split per loan: 80% LPs · 10% $MAGPIE holders · 5% referrers · 2% LP loyalty pool · 3% protocol
- $MAGPIE mint: 9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump (Token-2022, 6 decimals)
- Credit score: 300-850, on-chain oracle. Repayments boost; liquidation tanks.
- Zero liquidations to date — by design (short terms + low LTV + token-health watcher).
- LP / earn yield: deposit SOL at magpie.capital/earn or via /earn in the bot. Earn 80% of all loan fees pro-rata.
- Site: https://magpie.capital  ·  Bot: https://t.me/magpie_capital_bot

SCAM AWARENESS — if a question is suspicious (asks about giving someone seed phrase, sending SOL to a stranger, etc.), refuse + warn: "That sounds like a scam pattern — never share seed phrases or send SOL to anyone offering 'free' anything."

You don't do betting picks, political views, or off-topic chat. ONE quick exchange of casual banter is fine if a user warms up, then steer back.`;

let _statsCache = null;
let _statsCacheAt = 0;
const STATS_CACHE_MS = 60_000;

async function getProtocolSnapshot() {
  if (_statsCache && Date.now() - _statsCacheAt < STATS_CACHE_MS) return _statsCache;
  try {
    const { rows: [r] } = await query(
      `SELECT
         (SELECT COUNT(*) FROM loans WHERE status = 'active')::int                              AS active_loans,
         (SELECT COUNT(*) FROM loans WHERE status = 'repaid')::int                              AS repaid_loans,
         (SELECT COUNT(*) FROM loans WHERE status = 'liquidated')::int                          AS liquidated_loans,
         (SELECT COUNT(*) FROM supported_mints WHERE enabled = TRUE)::int                        AS tokens_supported,
         (SELECT COUNT(*) FROM users)::int                                                       AS total_users,
         COALESCE((SELECT SUM(shares::numeric) FROM lp_positions WHERE shares > 0), 0)::text     AS lp_shares,
         COALESCE((SELECT SUM(loan_amount_lamports::numeric) FROM loans WHERE status = 'active'), 0)::text AS active_borrowed_lamports`,
    );
    _statsCache = r;
    _statsCacheAt = Date.now();
    return r;
  } catch (err) {
    console.warn("[community-pip] snapshot failed:", err.message);
    return null;
  }
}

function formatSnapshotForPrompt(s) {
  if (!s) return "(live stats unavailable right now)";
  const activeSol = (Number(s.active_borrowed_lamports) / 1e9).toFixed(2);
  const lpSol = (Number(s.lp_shares) / 1e9).toFixed(2);
  return [
    `CURRENT PROTOCOL STATE (refreshed every 60s):`,
    `  • Active loans: ${s.active_loans} (${activeSol} SOL borrowed)`,
    `  • Lifetime repaid: ${s.repaid_loans}`,
    `  • Lifetime liquidated: ${s.liquidated_loans}`,
    `  • LP pool: ${lpSol} SOL deposited`,
    `  • Approved collateral tokens: ${s.tokens_supported}`,
    `  • Total users: ${s.total_users}`,
  ].join("\n");
}

/** Answer a single group question. Returns the response text or null on error. */
export async function answerGroupQuestion(question) {
  if (!API_KEY) return null;
  if (!question || typeof question !== "string") return null;
  const trimmed = question.trim().slice(0, 1500);
  if (!trimmed) return null;

  const snap = await getProtocolSnapshot();
  const extraSystem = formatSnapshotForPrompt(snap);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: "text", text: GROUP_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: extraSystem },
        ],
        messages: [{ role: "user", content: trimmed }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn("[community-pip] anthropic returned", res.status);
      return null;
    }
    const body = await res.json();
    const block = Array.isArray(body?.content) ? body.content[0] : null;
    return block?.type === "text" ? block.text.trim() : null;
  } catch (err) {
    console.warn("[community-pip] anthropic call failed:", err.message);
    return null;
  }
}

/* ────────────────────── RATE LIMIT ──────────────────────────── */
// Per-user, per-chat rate cap. In-memory is fine — group spam is
// short-lived and a bot restart resets to "everyone gets fresh budget".
const QUESTIONS_PER_HOUR = 5;
const HOUR_MS = 3600_000;
const userQuestionLog = new Map(); // key: `${chatId}:${userId}` → [timestamps]

export function checkRateLimit(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const log = (userQuestionLog.get(key) || []).filter((t) => now - t < HOUR_MS);
  if (log.length >= QUESTIONS_PER_HOUR) {
    const oldestMs = HOUR_MS - (now - log[0]);
    return { allowed: false, retry_in_min: Math.ceil(oldestMs / 60_000) };
  }
  log.push(now);
  userQuestionLog.set(key, log);
  return { allowed: true };
}
