/**
 * AI Support Agent (Anthropic Claude-powered).
 *
 * Conversational support layer on top of the deterministic /support
 * primitives. Handles product questions, status-aware diagnostics,
 * and escalation to human admin when needed.
 *
 * Architecture:
 *   - Function-calling pattern: AI has read-only tools that look up
 *     the user's own state (loans, wallet, referrals, etc.) and
 *     protocol-wide stats. No state-modifying tools — defense in
 *     depth so the agent can't move funds even if it hallucinates.
 *   - Multi-turn memory via support_conversations table (30 min TTL).
 *   - Anthropic prompt caching on the system prompt + tool defs so
 *     repeat calls within 5 min are 90% cheaper on input tokens.
 *   - Hard rate limit (30 msgs/hr/user) + max tool-call iterations.
 *   - Graceful degrade: if no ANTHROPIC_API_KEY is set, returns null
 *     so the caller can fall through to the legacy ticket flow.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { getReadOnlyProgram } from "../solana/program.js";
import { getLiveOwedLamports } from "./loans.js";

// ──────────────────────────── CONFIG ────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.AI_SUPPORT_MODEL || "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 2000;
const MAX_TOOL_ITERATIONS = 8;
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 min idle = new session
const RATE_LIMIT_PER_HOUR = 30;
const MAX_HISTORY_TURNS = 12; // sliding window of last N user+assistant pairs
const DAILY_SPEND_CAP_USD = Number(process.env.AI_DAILY_SPEND_USD) || 20;

// Anthropic claude-sonnet-4-6 pricing (USD per million tokens).
// Input/output base rates; cache-read tokens are 90% off vs base input.
// Source: https://www.anthropic.com/pricing — update if pricing shifts.
const PRICE_PER_M_INPUT = 3.00;
const PRICE_PER_M_OUTPUT = 15.00;
const PRICE_PER_M_CACHE_READ = 0.30;
const PRICE_PER_M_CACHE_WRITE = 3.75;

export function isAiSupportEnabled() {
  return !!API_KEY;
}

// ──────────────────────────── ADMIN ALERT BUFFER ─────────────────
// Track recent failures so we can DM the admin when something's wrong.
// In-memory ring buffer (resets on restart, which is fine — restart
// is itself a noteworthy event).
const recentFailures = []; // { ts, type, message }
const FAIL_WINDOW_MS = 5 * 60 * 1000; // 5 min
const FAIL_THRESHOLD = 3;
const ADMIN_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
let lastAdminAlertAt = 0;

function recordFailure(type, message) {
  const now = Date.now();
  recentFailures.push({ ts: now, type, message });
  // Trim anything older than the window
  while (recentFailures.length > 0 && now - recentFailures[0].ts > FAIL_WINDOW_MS) {
    recentFailures.shift();
  }
  return recentFailures.length;
}

async function maybeAlertAdmin(bot) {
  if (!bot) return;
  const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? Number(process.env.ADMIN_TG_ID) : null;
  if (!ADMIN_TG_ID) return;
  if (recentFailures.length < FAIL_THRESHOLD) return;
  const now = Date.now();
  if (now - lastAdminAlertAt < ADMIN_ALERT_COOLDOWN_MS) return;
  lastAdminAlertAt = now;
  const byType = recentFailures.reduce((acc, f) => {
    acc[f.type] = (acc[f.type] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ");
  const lastErr = recentFailures[recentFailures.length - 1]?.message || "(none)";
  try {
    await bot.api.sendMessage(
      ADMIN_TG_ID,
      [
        "🚨 *AI support degraded*",
        "",
        `${recentFailures.length} failures in last 5 min.`,
        `By type: ${summary}`,
        "",
        `Last error: \`${lastErr.slice(0, 200)}\``,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch {}
}

// Bot reference is set by support.js so we can DM admin from here.
let botRef = null;
export function setBotRef(bot) { botRef = bot; }

// ──────────────────────────── PII SCRUB ──────────────────────────
// Defense-in-depth: prevent users who accidentally paste secrets from
// having them sent to Anthropic. We refuse the request and warn.

// Solana keypair JSON array: 64 numbers between brackets.
const KEYPAIR_JSON_REGEX = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/;
// Solana private key in base58 (88 chars in the 1-9A-HJ-NP-Za-km-z alphabet,
// long enough to be unlikely to occur naturally in user text).
const BASE58_SECRET_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/;
// Bip39 mnemonic: 12+ space-separated lowercase words. We don't validate
// against the wordlist (would balloon module size); 12+ short lowercase
// words is a high-confidence proxy for "user pasted a seed phrase".
const MNEMONIC_REGEX = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;

function containsSecret(text) {
  if (!text || typeof text !== "string") return null;
  if (KEYPAIR_JSON_REGEX.test(text)) return "keypair_json";
  if (BASE58_SECRET_REGEX.test(text)) {
    // Disambiguate: it could be a tx signature (also base58, similar length).
    // Tx signatures are 64-88 chars; private keys are 87-88 chars. To avoid
    // false positives on tx signatures, only flag if it's also >= 87 chars
    // AND not preceded by "tx" or "signature" context.
    const m = text.match(BASE58_SECRET_REGEX);
    if (m && m[0].length >= 87) {
      const ctx = text.toLowerCase();
      const looksLikeTx = /tx|signature|sig|solscan|hash/.test(ctx);
      if (!looksLikeTx) return "base58_secret";
    }
  }
  if (MNEMONIC_REGEX.test(text)) return "mnemonic";
  return null;
}

// ──────────────────────────── SYSTEM PROMPT ─────────────────────

const SYSTEM_PROMPT = `You are the Magpie Capital support agent. Magpie is a permissionless lending protocol on Solana — users borrow SOL against Solana tokens (memecoins, $MAGPIE, tokenized stocks) as collateral. The interface is this Telegram bot (@magpie_capital_bot) plus the website at magpie.capital.

CORE PROTOCOL FACTS:
- Loan tiers (all on-chain enforced, no per-user variation today):
    Express: 30% LTV · 2-day term · 3% fee
    Quick:   25% LTV · 3-day term · 2% fee
    Standard:20% LTV · 7-day term · 1.5% fee
- Fee split on every loan fee:
    80% → LPs (share-based pro-rata yield, automatic)
    10% → $MAGPIE holders (auto-distributed weekly snapshot)
    5%  → Referrers (claimable any time)
    2%  → LP Loyalty Bonus pool (time-weighted, auto-distributed)
    3%  → Protocol
- Borrowing: in this bot via /borrow
- Lending (LP): on the site at magpie.capital/earn — share-based pro-rata 80% yield, withdraw anytime if pool has liquidity
- Token submissions: /submit (bot) or magpie.capital/submit (site). Runs 6-layer scam audit. Three outcomes: Instant Approval / Submission Needs Review / Declined
- Default: if a loan goes past due, a keeper auto-liquidates it. Borrower loses collateral, keeps the SOL they borrowed, takes a credit score hit (-15 on repayment factor, -50 indirect from liquidation)
- Credit score: 300-850 on-chain oracle (program BBYtty9s...). Today same loan terms for all tiers — tier perks are reputation signals, not modified rates (program upgrade planned)
- $MAGPIE token: mint 9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump, Token-2022. Holders get pro-rata SOL from the 10% pool, distributed automatically every random 5-10d (snapshot timing is private — don't reveal it)
- Referrals: every user has a 6-char code. Share link format: https://t.me/magpie_capital_bot?start=CODE. 5% lifetime cut on referred-user fees
- LP Loyalty: 2% pool, time-weighted (shares × seconds held). Auto-paid in SOL on random 5-10d window
- Liquidations: 0 ever, by design (short terms + low LTV + token-health watcher)

KEY URLS:
- TG bot:        https://t.me/magpie_capital_bot
- Home:          https://magpie.capital
- Dashboard:     https://magpie.capital/dashboard
- Earn (LP):     https://magpie.capital/earn
- Submit token:  https://magpie.capital/submit
- Approved:      https://magpie.capital/tokens
- Refer:         https://magpie.capital/refer
- Holders:       https://magpie.capital/holders
- Credit:        https://magpie.capital/credit
- Docs:          https://magpie.capital/docs

═══════════════════════════════════════════════════════════════════
HOW YOU TALK — THIS IS YOUR PERSONALITY
═══════════════════════════════════════════════════════════════════
You are a real support agent, not a chatbot. Talk like a thoughtful
human on the team who knows the product inside out and genuinely
wants to help the user. Warmth + competence + brevity.

Be CONVERSATIONAL:
- Acknowledge the situation before diving in when it warrants it.
  e.g., user says "I'm panicking, my loan vanished" → "Hey, take a
  breath — let me pull up your loans and see what's actually there."
  NOT: "Calling list_my_loans now."
- Use natural connectors: "okay, so…", "looks like…", "good news —",
  "one thing to flag —", "ah, that's because…"
- Refer to yourself as "I" naturally. You're not a tool, you're a
  teammate working a ticket. "I checked the chain and your loan is
  fine." NOT: "The system shows your loan is fine."
- When you call a tool, you can briefly say what you're doing if it
  takes context: "Let me pull that up." Then deliver the answer.

Be EMPATHETIC when warranted:
- Confused user → "Totally fair question, this part trips people up."
- Stressed/panicking user → lead with reassurance, then facts.
- User is wrong about something → don't be condescending. "Ah, the
  way it actually works is…" NOT "You're incorrect."
- User got bad news (liquidated, missed payment) → acknowledge it
  before pivoting to options. "That's frustrating — here's where
  you stand and what you can do next."

Be DIRECT and BRIEF:
- Most answers fit in 2-5 sentences. Don't pad.
- If you need a list, use bullets (•). Cap at 4-5 bullets.
- Wrap loan numbers, tx sigs, wallet addresses, exact amounts in
  \`backticks\`.
- Use *bold* for the answer if it's a number/status; _italic_
  sparingly for asides.
- No headers (#, ##), no \`\`\`code blocks, no horizontal rules.

INTERPRET tool results — never dump them raw:
- BAD: "list_my_loans returned: total=1, loans=[{loan_id: 1780...,
  status: active, currently_owed_sol: 0.058, …}]"
- GOOD: "Found your loan — \`#1780497452120\`. You've paid it down to
  \`0.058 SOL\` (97% paid off), due in \`38 hours\`. You're in great
  shape — just \`/repay\` when you're ready to close it out."

Offer NEXT STEPS proactively:
- After answering, suggest the natural follow-up command or page.
  "Want me to walk you through repaying?" or "You can check
  collateral health any time with /positions."
- If the user might have a related question, hint at it: "Let me
  know if you also want to extend the term or do a partial repay."

Things to AVOID:
- Robot filler: "I'd be happy to help!", "Great question!",
  "I understand your concern." — feels canned.
- Apologizing for things you didn't cause: "I apologize for the
  inconvenience…" — instead, acknowledge once and pivot to fix.
- Overpromising: "Don't worry, everything will be fine." Stick to
  what the data actually shows.
- Walls of text. If your answer is over ~6 sentences, you're
  probably explaining more than the user asked for.

EXAMPLES of good answers (study these):
─────────────────────────────────────────
User: "is my loan ok?"
You (after list_my_loans): "Yep — loan \`#1780...\` is healthy.
You owe \`2.45 SOL\`, due in \`2.3 days\`, collateral well-covered.
Nothing to worry about."
─────────────────────────────────────────
User: "I borrowed yesterday but I don't see the SOL"
You: "Let me check your wallet quickly. [calls get_my_wallet]
Your wallet \`5hsZBr...\` is sitting at \`0.847 SOL\` — looks like
the loan landed. If you were expecting more, send me your loan
ID and I'll pull the exact amount it disbursed."
─────────────────────────────────────────
User: "what's the fee on a 7 day loan"
You: "1.5% one-time fee on a 7-day Standard loan — no daily
interest, just that flat fee. Of the fee: 80% goes to LPs,
10% to $MAGPIE holders, 5% to referrers, 2% to LP Loyalty,
3% to protocol. Want to /simulate one with your collateral?"
─────────────────────────────────────────
User: "Can you check on my existing loan"
You (after list_my_loans returns 0 loans): "I don't see any
active loans on your account. Did you maybe borrow from a
different Telegram account? Or are you thinking about taking
one out? I can walk you through /borrow if so."
─────────────────────────────────────────

CRITICAL TECHNICAL RULES:
- Use Markdown that Telegram parses: *bold*, _italic_, \`code\`, [text](url). No headers, no \`\`\`code blocks, no tables.
- Wrap loan numbers, tx signatures, wallet addresses, exact amounts in \`backticks\`.
- Be honest. Don't invent numbers. Always call a tool to look up live state before quoting any number.
- If something's nuanced, say it plainly. Don't overpromise or speculate.

═══════════════════════════════════════════════════════════════════
TOOL-FIRST POLICY — THIS IS THE MOST IMPORTANT RULE
═══════════════════════════════════════════════════════════════════
Before answering ANY question that touches the user's own state OR live
protocol numbers, you MUST call a tool. Tools are fast (under 2 seconds)
and free for you to use. Calling a tool is ALWAYS preferable to:
(a) saying "I don't know"
(b) escalating to a ticket
(c) guessing or paraphrasing facts

Mandatory tool triggers — pattern → tool:
- User mentions "my loan", "the loan", "existing loan", "my position", "check on my loan", "loan status", "where's my", or any phrasing about their loan WITHOUT specifying an ID → \`list_my_loans\`
- User mentions a specific loan ID number (any long digit string) → \`lookup_loan\`
- User says anything about their wallet, balance, SOL, address, deposit → \`get_my_wallet\`
- User asks about referrals, invites, referral code, earnings, friends joined → \`get_my_referrals\`
- User asks about $MAGPIE rewards, holder rewards, distributions, when paid → \`get_my_holder_stats\`
- User asks about LP, lending, earn position, yield, deposited SOL → \`get_my_lp_position\`
- User asks about TVL, total fees, protocol stats, "how's the protocol doing" → \`get_protocol_stats\`
- User pastes any long base58 string that could be a tx signature → \`check_tx\`
- User asks about their credit score, tier, points, max LTV they qualify for → \`get_my_credit_score\`
- User asks about a token they submitted, "is my token approved", "did my submission go through" → \`get_my_token_submissions\`
- User asks "can I borrow against X token", "is X supported", "do you accept X" → \`check_token_supported\`
- User asks "what did I do recently", "show my activity", "history" generally → \`get_my_recent_activity\`

If a user message is ambiguous between two tools (e.g., "what's my status?"),
call \`list_my_loans\` first — that's the most common intent in support.

After tool results come back, interpret them and answer in plain language.
Do NOT just dump raw JSON to the user.

═══════════════════════════════════════════════════════════════════
INQUIRY PLAYBOOK — HOW TO TRIAGE WHAT USERS ACTUALLY WANT
═══════════════════════════════════════════════════════════════════
Before reaching for a tool, briefly classify the inquiry. Most user
messages fall into one of these patterns. Match the pattern, then act.

1. DIAGNOSTIC — "is my X ok?", "where's my Y?", "what happened to Z?"
   → ALWAYS call the relevant tool. Don't speculate. After the tool
     returns: if state is fine, reassure; if there's an issue, name
     it and offer next steps.
   → e.g., "is my loan ok" → list_my_loans → "Yep, loan #X is healthy…"

2. EDUCATIONAL — "how does X work?", "what is Y?", "explain Z"
   → Answer from your protocol-fact knowledge. No tool call needed
     unless they mention "my".
   → Keep it concrete. Offer /simulate or a relevant URL.
   → e.g., "how does borrowing work" → explain in 3-4 sentences,
     suggest /simulate or /borrow.

3. INSTRUCTIONAL — "how do I X?", "I want to Y", "can you help me Z"
   → Point to the exact command or URL. List 2-4 steps if multi-part.
   → If you can do part of it via a tool (e.g., check balance before
     they borrow), do that proactively.
   → e.g., "how do I deposit" → "Run /deposit — that gives you your
     address. Send SOL or tokens there, takes ~30s to land."

4. TROUBLESHOOTING — "X isn't working", "I tried Y but it failed",
   "got an error"
   → Ask for specifics ONCE if needed: which command, exact error
     message, when it happened. Then diagnose.
   → If they pasted a tx sig → check_tx FIRST.
   → If they tried to borrow/withdraw → get_my_wallet, list_my_loans
     to see state.
   → Don't escalate unless tools fail AND a fix isn't obvious.

5. TIMING/EXPECTATIONS — "when will X happen?", "how long until Y?"
   → For protocol timing: use core facts (loan terms, fee timing,
     LP loyalty distribution windows).
   → For their specific timing: tool call (loan due date, last
     claim, position age).
   → NEVER reveal $MAGPIE holder snapshot timing — operator-private.
     If asked: "Snapshots happen on a randomized window. Just keep
     holding — when the next one fires, you'll be in it."

6. POST-MORTEM — "why did X happen?", "what went wrong with my Y?"
   → Call tools to get state. Cross-reference with what they expected.
   → Explain cause directly. Offer prevention/next step.
   → e.g., "why did my loan liquidate" → lookup_loan → "Your loan
     went past its due date. The keeper auto-liquidated it…"

7. VAGUE/AMBIGUOUS — "help", "I have a question", "something's wrong",
   one-word messages
   → Ask ONE clarifying question. Don't dump a menu at them.
   → e.g., "help" → "Sure — what's going on? Loan issue, deposit not
     showing, something else?"

8. OFF-PROTOCOL — taxes, legal, "is X a good buy", price predictions,
   how Solana wallets work generally, other DeFi protocols
   → Politely deflect. Stay in Magpie's lane.
   → e.g., "should I buy $MAGPIE" → "I can't give investment advice.
     What I can tell you is how the holder rewards work…"
   → For wallet/Solana basics: a one-sentence answer is fine, then
     pivot back to Magpie if relevant.

9. COMPLAINT/FRUSTRATION — "this is broken", "I'm pissed", "scam!"
   → Acknowledge first ("I hear you, let me look") — don't be defensive.
   → THEN diagnose with tools.
   → If you find an actual issue, own it ("you're right — looks like
     X happened. Here's what we'll do…").
   → If everything is actually fine, explain calmly what the data shows.
   → Escalate only after diagnosing AND if admin judgment is needed.

10. HIGH-STAKES ACCESS ISSUES — "I lost my seed", "wrong wallet
    imported", "sent SOL to wrong address", "got phished"
    → Lead with empathy + clarity about what's recoverable.
    → Magpie wallets generated by the bot CAN be re-exported via
      /export if they still have bot access.
    → External wallet mistakes are usually unrecoverable — be honest.
    → ALWAYS escalate (security_incident) so the team can help.
    → NEVER ask them to send a seed/key.

═══════════════════════════════════════════════════════════════════
ESCALATION POLICY — STRICT
═══════════════════════════════════════════════════════════════════
You may ONLY call \`open_support_ticket\` if ALL of the following are true:
1. You have already made at least one diagnostic tool call this turn (or one
   tool call already exists in the conversation history).
2. The tool results do not contain enough information to answer the user.
3. One of these applies:
   - User explicitly asks for a human / the team / staff
   - Compromised wallet, phishing report, suspected exploit, hacked account
   - Refund request or one-off financial decision that needs admin judgment
   - Bug report that requires developer investigation (not just a confused user)
   - Live data shows a real anomaly you cannot resolve (e.g., on-chain state inconsistent)

You may NOT open a ticket as the FIRST action of a turn. If you have not
called any tool yet, that is a bug in your reasoning — try the tool first.

When you do escalate, your message MUST tell the user:
  (a) what you tried (which tools, what they showed)
  (b) why you're escalating
  (c) ticket number opened

WHAT YOU NEVER DO:
- Never open a ticket without first attempting tool-based diagnosis
- Never claim a tx was successful without calling \`check_tx\` first
- Never recommend a specific token to buy or sell — you are not a financial advisor
- Never speculate on $MAGPIE price or other token prices
- Never make protocol promises beyond the core facts above (e.g., don't say "you'll get X tokens", "yield will be Y%", or invent timing windows)
- Never reveal the $MAGPIE holder snapshot timing — it's operator-private to prevent dump-after-snapshot gaming
- Never agree to do anything outside Magpie's scope. Politely redirect.

When in doubt: CALL A TOOL. Honesty over confidence. Tool-first over ticket.`;

// ──────────────────────────── TOOLS ─────────────────────────────

const TOOLS = [
  {
    name: "lookup_loan",
    description: "Get the live on-chain + DB state of a specific loan owned by the current user. Returns owed amount, status, collateral, health ratio, due date. Use when the user mentions a specific loan ID number.",
    input_schema: {
      type: "object",
      properties: {
        loan_id: { type: "string", description: "The numeric loan ID (the long number, e.g. '1780497452120')" },
      },
      required: ["loan_id"],
    },
  },
  {
    name: "list_my_loans",
    description: "Get a summary of the current user's loans (active + recent history). Use when they ask about loans generally without specifying an ID.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_tx",
    description: "Look up a Solana transaction by its signature. Returns status (finalized/confirmed/failed/not-found). Use when the user pastes a signature or asks if a tx went through.",
    input_schema: {
      type: "object",
      properties: {
        signature: { type: "string", description: "The transaction signature (long base58 string)" },
      },
      required: ["signature"],
    },
  },
  {
    name: "get_my_wallet",
    description: "Get the current user's Magpie custodial wallet address and SOL balance. Use when they ask about their wallet, balance, or deposit address.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_referrals",
    description: "Get the current user's referral code, share link, invited-count, lifetime earned, and claimable balance.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_holder_stats",
    description: "Get the current user's $MAGPIE holder reward stats — current $MAGPIE balance, lifetime SOL received, distributions count. Note: the snapshot timing is operator-private; do not reveal it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_lp_position",
    description: "Get the current user's LP (liquidity provider) position — deposited SOL, current value, yield earned, time in pool, loyalty bonus stats.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_protocol_stats",
    description: "Get current protocol-wide stats: TVL, total loans issued, liquidations, recent fees, current utilization. For general 'how is the protocol doing?' questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_credit_score",
    description: "Get the current user's credit score (300-850), tier (bronze/silver/gold/platinum), factor breakdown, and tier-derived perks (max LTV, fee rate, max duration). Use when the user asks about their credit, score, tier, reputation, or what loans they qualify for.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_token_submissions",
    description: "Get the status of tokens the current user submitted for review via /submit. Returns pending/approved/rejected status, safety score, fail reasons (if any). Use when the user asks about a token they submitted or whether their submission was approved.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_token_supported",
    description: "Check whether a given token mint or symbol is approved as collateral on Magpie. Returns enabled flag, current max LTV, and other details. Use when the user asks 'can I borrow against X', 'do you support X', 'is X enabled'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The token symbol (e.g. 'WIF', 'BONK', 'MAGPIE') or a full mint address" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_my_recent_activity",
    description: "Get a chronological summary of the user's recent protocol activity: borrows, repays, partial repays, extensions, liquidations. Use for general 'what did I do recently', 'show my history', 'what happened with my account' questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "open_support_ticket",
    description: "LAST RESORT escalation to a human admin. DO NOT use this as your first action. You MUST first try at least one diagnostic tool (list_my_loans, lookup_loan, get_my_wallet, check_tx, etc.) to investigate the user's question. Only call open_support_ticket if (a) those tools have already been called this turn and (b) the results don't answer the question AND admin judgment is required. Valid escalation reasons: explicit human-request, security/compromise/phishing reports, refund requests, bug reports needing developer investigation, or a genuine on-chain anomaly tools cannot resolve. If the user is simply asking about THEIR loan/wallet/referrals/holdings, DO NOT open a ticket — call the corresponding lookup tool instead.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A concise one-line summary of what the user needs help with (the admin will read this)" },
        what_i_tried: { type: "string", description: "Which diagnostic tools you called before deciding to escalate, and what they showed. Required so the admin has context." },
        escalation_reason: {
          type: "string",
          enum: ["explicit_human_request", "security_incident", "refund_request", "bug_report", "onchain_anomaly", "other"],
          description: "Why escalation is justified. Pick the closest category.",
        },
      },
      required: ["summary", "what_i_tried", "escalation_reason"],
    },
  },
];

// ──────────────────────────── TOOL HANDLERS ─────────────────────

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}

async function getUserWallet(userId) {
  const r = await query(`SELECT public_key FROM wallets WHERE user_id = $1`, [userId]);
  return r.rows[0]?.public_key ?? null;
}

// Standardised tool error shape. The `user_friendly_hint` is what the
// AI should relay to the user; the raw `error` is for our logs only.
function toolError(kind, technical, hint) {
  return { error: kind, technical: technical?.slice(0, 200), user_friendly_hint: hint };
}

const HINT_RPC_BLIP = "Solana RPC had a brief hiccup. Ask the user to try again in 10-15 seconds.";
const HINT_NOT_FOUND = "That record was not found. Confirm the user is signed in and has used /start at least once.";
const HINT_NO_WALLET = "The user has no Magpie wallet yet. Suggest they run /start first.";

const TOOL_HANDLERS = {
  lookup_loan: async ({ loan_id }, { userId }) => {
    const { rows } = await query(
      `SELECT l.*, sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.loan_id = $1 AND l.user_id = $2
        LIMIT 1`,
      [loan_id, userId],
    );
    if (!rows[0]) return toolError("loan_not_found", null, "That loan ID was not found for this user. Tell them to double-check the ID (it's the long number from /positions), or call list_my_loans to see what they have.");
    const loan = rows[0];
    const program = getReadOnlyProgram();
    let onChain;
    try {
      onChain = await program.account.loan.fetch(new PublicKey(loan.loan_pda));
    } catch (err) {
      return toolError("rpc_blip", err.message, HINT_RPC_BLIP);
    }
    const status =
      "repaid" in onChain.status ? "repaid"
      : "liquidated" in onChain.status ? "liquidated"
      : "active";
    const owed = BigInt(onChain.repayAmount.toString());
    const original = BigInt(loan.loan_amount_lamports ?? "0");
    const dueMs = Number(onChain.dueTimestamp) * 1000;
    const dueIsoUtc = new Date(dueMs).toISOString();
    return {
      loan_id: loan.loan_id,
      symbol: loan.symbol,
      status,
      original_loan_sol: fmtSol(original),
      currently_owed_sol: fmtSol(owed),
      percent_paid_off: original > 0n ? ((Number(original - owed) / Number(original)) * 100).toFixed(1) : "0",
      collateral_amount_raw: loan.collateral_amount,
      ltv_percentage: loan.ltv_percentage,
      duration_days: loan.duration_days,
      due_at_utc: dueIsoUtc,
      hours_to_due: ((dueMs - Date.now()) / 3_600_000).toFixed(1),
      past_due: dueMs < Date.now(),
    };
  },

  list_my_loans: async (_args, { userId }) => {
    const { rows } = await query(
      `SELECT l.id, l.loan_id, l.loan_pda, l.status, l.loan_amount_lamports,
              l.original_loan_amount_lamports, l.due_timestamp, sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.user_id = $1
        ORDER BY l.status = 'active' DESC, l.start_timestamp DESC
        LIMIT 10`,
      [userId],
    );
    if (rows.length === 0) {
      return { total: 0, loans: [], note: "User has no loans on record. They may need to /borrow to take one out." };
    }
    // For active loans, fetch live on-chain owed amount (heals DB drift).
    // For repaid/liquidated, use stored values.
    const loans = await Promise.all(rows.map(async (l) => {
      const isActive = l.status === "active";
      let liveOwed = null;
      if (isActive) {
        try {
          liveOwed = await getLiveOwedLamports(l);
        } catch { /* fall through to DB */ }
      }
      const owed = liveOwed ?? BigInt(l.original_loan_amount_lamports ?? "0");
      const original = BigInt(l.loan_amount_lamports ?? "0");
      return {
        loan_id: l.loan_id,
        symbol: l.symbol,
        status: l.status,
        currently_owed_sol: fmtSol(owed),
        original_loan_sol: fmtSol(original),
        percent_paid_off: original > 0n ? ((Number(original - owed) / Number(original)) * 100).toFixed(1) : "0",
        due_at_utc: l.due_timestamp ? new Date(l.due_timestamp).toISOString() : null,
        past_due: l.due_timestamp ? new Date(l.due_timestamp).getTime() < Date.now() : false,
      };
    }));
    const active = loans.filter((l) => l.status === "active").length;
    return {
      total: loans.length,
      active_count: active,
      loans,
    };
  },

  check_tx: async ({ signature }) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature || "")) {
      return toolError("invalid_signature", null, "That string doesn't look like a Solana transaction signature. Ask the user to paste the full signature — it's a long base58 string (~88 chars).");
    }
    try {
      const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const s = res?.value?.[0];
      if (!s) return { signature, status: "not_found", note: "Tx was never submitted, expired (>90s blockhash), or dropped from mempool.", user_friendly_hint: "Tell the user the tx was either never broadcast or expired before landing. They should try the action again." };
      if (s.err) return { signature, status: "failed", error: JSON.stringify(s.err).slice(0, 200), user_friendly_hint: "The tx failed on-chain. Share the solscan link so the user can see the error reason." };
      return {
        signature,
        status: s.confirmationStatus || "processing",
        slot: s.slot,
        solscan_url: `https://solscan.io/tx/${signature}`,
      };
    } catch (err) {
      return toolError("rpc_blip", err.message, HINT_RPC_BLIP);
    }
  },

  get_my_wallet: async (_args, { userId }) => {
    const pubkey = await getUserWallet(userId);
    if (!pubkey) return toolError("no_wallet", null, HINT_NO_WALLET);
    let balanceSol = 0;
    let balanceFresh = true;
    try {
      const lamports = await connection.getBalance(new PublicKey(pubkey));
      balanceSol = lamports / 1e9;
    } catch {
      balanceFresh = false;
    }
    return {
      address: pubkey,
      sol_balance: balanceSol.toFixed(6),
      balance_fresh: balanceFresh,
      user_friendly_hint: balanceFresh ? undefined : "Balance reads failed; tell the user the address but note that you couldn't verify the live balance right now.",
    };
  },

  get_my_referrals: async (_args, { userId }) => {
    const [code, totals] = await Promise.all([
      query(`SELECT code FROM referral_codes WHERE user_id = $1`, [userId]),
      query(
        `SELECT
           COALESCE(SUM(reward_lamports)::numeric, 0)::text AS lifetime,
           COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS paid,
           COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS claimable,
           COUNT(DISTINCT referee_user_id)::int AS referred_borrowers
         FROM referral_earnings WHERE referrer_user_id = $1`,
        [userId],
      ),
    ]);
    const c = code.rows[0]?.code;
    return {
      code: c ?? null,
      share_link: c ? `https://t.me/magpie_capital_bot?start=${c}` : null,
      referred_borrowers: totals.rows[0]?.referred_borrowers ?? 0,
      lifetime_sol: fmtSol(totals.rows[0]?.lifetime ?? "0"),
      claimable_sol: fmtSol(totals.rows[0]?.claimable ?? "0"),
      paid_sol: fmtSol(totals.rows[0]?.paid ?? "0"),
    };
  },

  get_my_holder_stats: async (_args, { userId }) => {
    const pubkey = await getUserWallet(userId);
    if (!pubkey) return toolError("no_wallet", null, HINT_NO_WALLET);
    try {
      const { getHolderInfoByWallet } = await import("./magpie-holder-rewards.js");
      const info = await getHolderInfoByWallet(pubkey);
      if (!info) return toolError("holder_lookup_empty", null, "Tell the user we couldn't find them in the holder ledger right now. If they hold $MAGPIE, the next snapshot will pick them up.");
      return {
        wallet: pubkey,
        magpie_balance: (Number(info.balance_raw) / 1e6).toFixed(2),
        has_balance: info.has_balance,
        lifetime_received_sol: fmtSol(info.lifetime_lamports),
        paid_sol: fmtSol(info.paid_lamports),
        distributions_received: info.distributions_count,
      };
    } catch (err) {
      return toolError("holder_lookup_failed", err.message, HINT_RPC_BLIP);
    }
  },

  get_my_lp_position: async (_args, { userId }) => {
    const pubkey = await getUserWallet(userId);
    if (!pubkey) return toolError("no_wallet", null, HINT_NO_WALLET);
    // Use site helper via a direct on-chain read here
    try {
      const program = getReadOnlyProgram();
      const { lendingPoolPda } = await import("../solana/pdas.js");
      const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
      const [pool] = lendingPoolPda(LENDER_PUBKEY);
      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), pool.toBuffer(), new PublicKey(pubkey).toBuffer()],
        program.programId,
      );
      const position = await program.account.depositorPosition.fetch(positionPda).catch(() => null);
      if (!position) return { has_position: false, user_friendly_hint: "The user has no LP position. Tell them they can deposit on magpie.capital/earn to start earning yield." };
      const poolAcc = await program.account.lendingPool.fetch(pool);
      const shares = Number(position.shares);
      const deposited = Number(position.depositedAmount);
      const totalShares = Number(poolAcc.totalShares);
      const totalDeposits = Number(poolAcc.totalDeposits);
      const currentValue = totalShares > 0 ? Math.floor((shares * totalDeposits) / totalShares) : 0;
      const [loyalty] = await Promise.all([
        query(
          `SELECT shares::text, EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at))::bigint AS seconds_held
             FROM lp_positions WHERE wallet_address = $1`,
          [pubkey],
        ),
      ]);
      const secondsHeld = Number(loyalty.rows[0]?.seconds_held ?? 0);
      return {
        has_position: true,
        deposited_sol: fmtSol(deposited),
        current_value_sol: fmtSol(currentValue),
        yield_earned_sol: fmtSol(currentValue - deposited),
        days_in_pool: (secondsHeld / 86400).toFixed(2),
        shares: shares.toString(),
      };
    } catch (err) {
      return toolError("lp_lookup_failed", err.message, HINT_RPC_BLIP);
    }
  },

  get_protocol_stats: async () => {
    try {
      const r = await fetch("https://www.magpie.capital/api/v1/pool/stats", { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return toolError("stats_api_unavailable", `HTTP ${r.status}`, "The stats API is briefly unavailable. Tell the user to try again in a minute, or check magpie.capital/dashboard directly.");
      const j = await r.json();
      const p = j.pool;
      const f = j.fees;
      return {
        tvl_sol: p.total_deposits_sol,
        outstanding_borrowed_sol: p.total_borrowed_sol,
        utilization_pct: (p.utilization * 100).toFixed(1),
        total_loans_issued: p.total_loans_issued,
        total_liquidations: p.total_liquidations,
        lifetime_fees_sol: p.total_fees_earned_sol,
        fees_24h_sol: Number(f.last_24h_lamports) / 1e9,
        paused: p.paused,
      };
    } catch (err) {
      return toolError("stats_fetch_failed", err.message, "Stats fetch failed. Tell the user to try /stats in the bot or check magpie.capital directly.");
    }
  },

  get_my_credit_score: async (_args, { userId }) => {
    try {
      const { rows } = await query(
        `SELECT score, tier, max_ltv, fee_rate, max_duration_days, loans_scored,
                f_repayment_history, f_loan_volume, f_account_age,
                f_collateral_diversity, f_liquidation_ratio, f_protocol_engagement,
                updated_at
         FROM credit_scores WHERE user_id = $1`,
        [userId],
      );
      if (rows.length === 0) {
        return {
          has_score: false,
          default_score: 300,
          tier: "bronze",
          user_friendly_hint: "User hasn't built credit yet — they're at the bronze starting tier. Tell them their score grows automatically as they borrow & repay. First successful loan is the biggest jump.",
        };
      }
      const r = rows[0];
      return {
        has_score: true,
        score: r.score,
        tier: r.tier,
        max_ltv_pct: Number(r.max_ltv),
        fee_rate_pct: (Number(r.fee_rate) * 100).toFixed(2),
        max_duration_days: r.max_duration_days,
        loans_scored: r.loans_scored,
        factors: {
          repayment_history: Number(r.f_repayment_history),
          loan_volume: Number(r.f_loan_volume),
          account_age: Number(r.f_account_age),
          collateral_diversity: Number(r.f_collateral_diversity),
          liquidation_ratio: Number(r.f_liquidation_ratio),
          protocol_engagement: Number(r.f_protocol_engagement),
        },
        last_updated_utc: r.updated_at,
        user_friendly_hint: "Today, all tiers get the same on-chain loan terms — tier perks are reputation signals. Don't tell the user they get better rates because of their tier yet.",
      };
    } catch (err) {
      return toolError("credit_lookup_failed", err.message, HINT_RPC_BLIP);
    }
  },

  get_my_token_submissions: async (_args, { userId }) => {
    try {
      // Submissions are tracked in token_screen_queue.submitted_by which is
      // the user's TELEGRAM_ID (not the internal users.id). Look up TG id first.
      const { rows: [u] } = await query(
        `SELECT telegram_id FROM users WHERE id = $1`,
        [userId],
      );
      if (!u) return toolError("user_not_found", null, "Tell the user they need to run /start first.");
      const { rows } = await query(
        `SELECT mint, symbol, name, status, safety_score, fail_reasons,
                reviewed_at, created_at
         FROM token_screen_queue
         WHERE submitted_by = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [u.telegram_id],
      );
      if (rows.length === 0) {
        return {
          total: 0,
          submissions: [],
          user_friendly_hint: "User hasn't submitted any tokens yet. They can submit one via /submit or magpie.capital/submit.",
        };
      }
      return {
        total: rows.length,
        submissions: rows.map((s) => ({
          mint: s.mint,
          symbol: s.symbol,
          name: s.name,
          status: s.status,
          safety_score: s.safety_score,
          fail_reasons: s.fail_reasons || [],
          submitted_at: s.created_at,
          reviewed_at: s.reviewed_at,
        })),
      };
    } catch (err) {
      return toolError("submissions_lookup_failed", err.message, HINT_RPC_BLIP);
    }
  },

  check_token_supported: async ({ query: q }) => {
    if (!q || typeof q !== "string") return toolError("invalid_query", null, "Ask the user for a token symbol or mint address.");
    const trimmed = q.trim().replace(/^\$/, ""); // strip leading $ from "$WIF"
    try {
      // Try mint first, fall back to symbol (case-insensitive)
      const { rows } = await query(
        `SELECT mint, symbol, name, decimals, enabled, max_ltv_pct, category
         FROM supported_mints
         WHERE mint = $1 OR LOWER(symbol) = LOWER($1)
         LIMIT 1`,
        [trimmed],
      );
      if (rows.length === 0) {
        return {
          found: false,
          query: trimmed,
          user_friendly_hint: `Tell the user we don't currently list ${trimmed} as approved collateral. Anyone can submit it via /submit — the bot will run a 6-layer safety check and approve it instantly if it passes.`,
        };
      }
      const t = rows[0];
      return {
        found: true,
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        enabled: t.enabled,
        max_ltv_pct: Number(t.max_ltv_pct),
        category: t.category,
        user_friendly_hint: t.enabled
          ? `Confirm to the user that ${t.symbol} is enabled. They can borrow against it up to ${t.max_ltv_pct}% LTV.`
          : `Tell the user ${t.symbol} is listed but currently disabled (likely due to a health issue). Borrows against it are paused until it's re-enabled.`,
      };
    } catch (err) {
      return toolError("supported_lookup_failed", err.message, HINT_RPC_BLIP);
    }
  },

  get_my_recent_activity: async (_args, { userId }) => {
    try {
      const { rows } = await query(
        `SELECT loan_id, status, start_timestamp, due_timestamp,
                loan_amount_lamports, original_loan_amount_lamports,
                (SELECT symbol FROM supported_mints sm WHERE sm.mint = loans.collateral_mint) AS symbol
         FROM loans
         WHERE user_id = $1
         ORDER BY start_timestamp DESC
         LIMIT 5`,
        [userId],
      );
      if (rows.length === 0) {
        return {
          activity: [],
          user_friendly_hint: "Tell the user we don't see any loan activity on their account yet. If they want to borrow, /borrow walks them through it.",
        };
      }
      return {
        activity: rows.map((r) => ({
          type: "loan",
          loan_id: r.loan_id,
          symbol: r.symbol,
          status: r.status,
          original_loan_sol: fmtSol(r.loan_amount_lamports ?? "0"),
          currently_owed_sol: fmtSol(r.original_loan_amount_lamports ?? "0"),
          started_at: r.start_timestamp,
          due_at: r.due_timestamp,
        })),
      };
    } catch (err) {
      return toolError("activity_lookup_failed", err.message, HINT_RPC_BLIP);
    }
  },

  open_support_ticket: async ({ summary, what_i_tried, escalation_reason }, { userId, toolsCalledThisTurn }) => {
    // Runtime guard: refuse escalation if no diagnostic tools have been called this turn,
    // UNLESS the reason is one that legitimately can't be diagnosed by a tool.
    const cantDiagnoseReasons = ["explicit_human_request", "security_incident", "refund_request"];
    const diagnosticToolsCalled = (toolsCalledThisTurn || []).filter(
      (t) => t !== "open_support_ticket",
    );
    if (diagnosticToolsCalled.length === 0 && !cantDiagnoseReasons.includes(escalation_reason)) {
      return {
        error: "REJECTED: You must call at least one diagnostic tool (list_my_loans, lookup_loan, get_my_wallet, check_tx, etc.) BEFORE escalating to a ticket. Try a tool first. Only after the tool results fail to answer the question, and the user needs admin judgment, may you open a ticket.",
        retry: true,
      };
    }
    const detail = [
      summary,
      what_i_tried ? `What AI tried: ${what_i_tried}` : null,
      escalation_reason ? `Reason: ${escalation_reason}` : null,
    ].filter(Boolean).join("\n");
    const { rows: [t] } = await query(
      `INSERT INTO support_tickets (user_id, message, status)
       VALUES ($1, $2, 'open')
       RETURNING id`,
      [userId, `[AI-escalated] ${detail}`],
    );
    return { ticket_id: t.id, status: "open", reason: escalation_reason };
  },
};

// ──────────────────────────── CONVERSATION MGMT ─────────────────

async function loadConversation(userId) {
  const r = await query(`SELECT * FROM support_conversations WHERE user_id = $1`, [userId]);
  if (r.rows.length === 0) return { messages: [], turns: 0, isNew: true };
  const row = r.rows[0];
  const lastActive = new Date(row.last_active_at).getTime();
  if (Date.now() - lastActive > CONVERSATION_TTL_MS) {
    // Reset: TTL expired, treat as new conversation
    return { messages: [], turns: 0, isNew: true };
  }
  return { messages: row.messages || [], turns: row.turns || 0, isNew: false };
}

async function saveConversation(userId, messages, turns, tokensIn, tokensOut) {
  const trimmed = messages.length > MAX_HISTORY_TURNS * 2
    ? messages.slice(-MAX_HISTORY_TURNS * 2)
    : messages;
  await query(
    `INSERT INTO support_conversations
       (user_id, messages, turns, total_input_tokens, total_output_tokens, started_at, last_active_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       messages = EXCLUDED.messages,
       turns = support_conversations.turns + 1,
       total_input_tokens = support_conversations.total_input_tokens + EXCLUDED.total_input_tokens,
       total_output_tokens = support_conversations.total_output_tokens + EXCLUDED.total_output_tokens,
       last_active_at = NOW()`,
    [userId, JSON.stringify(trimmed), turns + 1, tokensIn, tokensOut],
  );
}

export async function resetConversation(userId) {
  await query(`DELETE FROM support_conversations WHERE user_id = $1`, [userId]);
}

async function checkRateLimit(userId) {
  const r = await query(
    `SELECT turns, last_active_at FROM support_conversations WHERE user_id = $1`,
    [userId],
  );
  if (r.rows.length === 0) return true;
  const row = r.rows[0];
  const minutesSinceStart = (Date.now() - new Date(row.last_active_at).getTime()) / 60_000;
  // If they've used > rate limit in the last hour, block
  if (minutesSinceStart < 60 && row.turns >= RATE_LIMIT_PER_HOUR) return false;
  return true;
}

// ──────────────────────────── COST + SPEND ──────────────────────

// Cost estimate (USD) given a usage object from the Anthropic response.
export function estimateCostUsd(usage) {
  if (!usage) return 0;
  const inputTok = usage.input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  const cacheReadTok = usage.cache_read_input_tokens || 0;
  const cacheWriteTok = usage.cache_creation_input_tokens || 0;
  return (
    (inputTok * PRICE_PER_M_INPUT
      + outputTok * PRICE_PER_M_OUTPUT
      + cacheReadTok * PRICE_PER_M_CACHE_READ
      + cacheWriteTok * PRICE_PER_M_CACHE_WRITE) / 1_000_000
  );
}

// Today's total cost (USD) from support_conversations.last_active_at >= midnight UTC.
// Note: support_conversations stores cumulative tokens across the whole convo,
// not per-day, but conversations are short-lived (30 min TTL) so daily mapping
// via last_active_at is a close-enough proxy.
async function getTodaySpendUsd() {
  try {
    const { rows: [r] } = await query(
      `SELECT
         COALESCE(SUM(total_input_tokens), 0)::bigint  AS input_tok,
         COALESCE(SUM(total_output_tokens), 0)::bigint AS output_tok
       FROM support_conversations
       WHERE last_active_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    );
    // We don't track cache hits separately yet — assume worst-case base rates.
    // This over-estimates by ~70%, which is fine for a safety cap.
    return (
      (Number(r.input_tok) * PRICE_PER_M_INPUT
        + Number(r.output_tok) * PRICE_PER_M_OUTPUT) / 1_000_000
    );
  } catch {
    return 0; // If DB blip, don't block the agent on metering
  }
}

// ──────────────────────────── ANTHROPIC API ─────────────────────

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [250, 1000, 4000];

async function callAnthropic(messages) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
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
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: TOOLS,
          messages,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) return res.json();
      const errBody = await res.text();
      const err = new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
      err.status = res.status;
      err.transient = TRANSIENT_STATUSES.has(res.status);
      // Non-transient (auth, malformed request) → fail fast
      if (!err.transient) throw err;
      lastErr = err;
    } catch (err) {
      // Network/timeout/abort errors are transient by default
      if (err.status && !err.transient) throw err;
      lastErr = err;
    }
    // Sleep before next attempt (if any retries remain)
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

// ──────────────────────────── MAIN ENTRY ────────────────────────

/**
 * Process one user message through the AI agent.
 *
 * Returns:
 *   { text: string, escalated_ticket_id?: number, used_tools: string[] }
 *   or null if AI support is disabled (no API key)
 */
export async function chatWithAgent(userId, userMessage) {
  if (!isAiSupportEnabled()) return null;

  // PII scrub: never let an accidentally-pasted seed phrase or private
  // key leave our infra. Refuse with a clear warning instead.
  const secretType = containsSecret(userMessage);
  if (secretType) {
    return {
      text: [
        "⚠️ *I detected what looks like a private key or seed phrase in your message.*",
        "",
        "*I refused to send it to the AI and discarded it.* For your safety:",
        "• Never paste private keys or seed phrases into ANY chat",
        "• Move any funds in that wallet to a fresh wallet IMMEDIATELY — assume the original is compromised",
        "• Magpie staff will NEVER ask for your seed phrase",
        "",
        "Want help with something else? Just ask without the secret.",
      ].join("\n"),
      blocked_reason: secretType,
      used_tools: [],
    };
  }

  // Daily spend cap — degrade to ticket-only if today's spend exceeds limit
  const todaySpend = await getTodaySpendUsd();
  if (todaySpend >= DAILY_SPEND_CAP_USD) {
    return {
      text: [
        "The AI agent has hit today's spending cap and is paused until midnight UTC.",
        "",
        "Tap *Open a ticket* and the team will reply via this bot.",
      ].join("\n"),
      spend_capped: true,
      today_spend_usd: todaySpend,
      used_tools: [],
    };
  }

  // Rate limit check
  const allowed = await checkRateLimit(userId);
  if (!allowed) {
    return {
      text: "I've hit my hourly limit for our chat. Try again in a bit, or tap *Open a ticket* to leave a message for the team.",
      rate_limited: true,
      used_tools: [],
    };
  }

  const { messages } = await loadConversation(userId);
  messages.push({ role: "user", content: userMessage });

  let totalIn = 0;
  let totalOut = 0;
  const usedTools = [];
  let escalatedTicketId = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let response;
    try {
      response = await callAnthropic(messages);
    } catch (err) {
      console.error("[ai-support] API error:", err.message);
      const failType = err.status === 429 ? "rate_limit"
        : err.status >= 500 ? "anthropic_5xx"
        : err.status === 401 ? "auth"
        : err.name === "TimeoutError" || err.name === "AbortError" ? "timeout"
        : "other";
      recordFailure(failType, err.message);
      maybeAlertAdmin(botRef).catch(() => {});
      const userMsg = failType === "rate_limit"
        ? "Anthropic is rate limiting us right now. Try again in 30 seconds, or tap *Open a ticket*."
        : failType === "auth"
        ? "The AI agent is misconfigured (auth). The team has been notified. Tap *Open a ticket* in the meantime."
        : failType === "timeout"
        ? "The AI agent timed out. Try a shorter question, or tap *Open a ticket*."
        : "The support agent hit an issue talking to its brain. Tap *Open a ticket* and the team will follow up.";
      return {
        text: userMsg,
        error: err.message,
        error_type: failType,
        used_tools: usedTools,
      };
    }

    totalIn += response.usage?.input_tokens ?? 0;
    totalOut += response.usage?.output_tokens ?? 0;

    // Collect any tool calls; if none, we're done
    const toolUses = (response.content || []).filter((b) => b.type === "tool_use");
    const textBlocks = (response.content || []).filter((b) => b.type === "text");

    if (toolUses.length === 0) {
      // Final answer — save + return
      messages.push({ role: "assistant", content: response.content });
      await saveConversation(userId, messages, 1, totalIn, totalOut);
      return {
        text: textBlocks.map((b) => b.text).join("\n").trim() || "I don't have a good answer — try /support and open a ticket.",
        escalated_ticket_id: escalatedTicketId,
        used_tools: usedTools,
      };
    }

    // Execute tools, append results
    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];
    for (const tu of toolUses) {
      const handler = TOOL_HANDLERS[tu.name];
      let result;
      if (!handler) {
        result = { error: `Unknown tool: ${tu.name}` };
      } else {
        try {
          // Pass the list of tools already called this turn so the
          // open_support_ticket guard can see prior diagnostic calls.
          result = await handler(tu.input || {}, { userId, toolsCalledThisTurn: [...usedTools] });
          if (tu.name === "open_support_ticket" && result?.ticket_id) {
            escalatedTicketId = result.ticket_id;
          }
        } catch (err) {
          result = { error: err.message?.slice(0, 200) || "Tool failed." };
        }
      }
      // Only count this tool as "called" if it didn't get rejected by the guard.
      // (If a guard rejected an escalation, the AI should retry with a real tool.)
      if (!result?.retry) usedTools.push(tu.name);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Hit max iterations without a final response
  return {
    text: "I went in a loop trying to answer that. Tap *Open a ticket* and I'll route it to the team.",
    used_tools: usedTools,
  };
}
