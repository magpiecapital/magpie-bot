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
const MAX_OUTPUT_TOKENS = 1500;
const MAX_TOOL_ITERATIONS = 6;
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 min idle = new session
const RATE_LIMIT_PER_HOUR = 30;
const MAX_HISTORY_TURNS = 12; // sliding window of last N user+assistant pairs

export function isAiSupportEnabled() {
  return !!API_KEY;
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

CRITICAL TONE + STYLE RULES:
- Answer in 1-3 SHORT paragraphs. Telegram users hate walls of text.
- Use Markdown that Telegram parses: *bold*, _italic_, \`code\`, [text](url). No headers, no \`\`\`code blocks.
- Wrap loan numbers, tx signatures, wallet addresses in \`backticks\`.
- Be honest. Don't invent numbers. Always call a tool to look up live state before quoting any number.
- Friendly but direct. No filler ("Great question!"). Get to the answer.
- If something's nuanced, say it plainly. Don't overpromise.

WHEN TO CALL TOOLS:
- User mentions a specific loan (#1234567 etc.) → \`lookup_loan\` with that ID
- User asks "what's my loan status?" generally → \`list_my_loans\`
- User pastes a tx signature → \`check_tx\`
- User asks about THEIR wallet/balance → \`get_my_wallet\`
- User asks about their referral earnings → \`get_my_referrals\`
- User asks about $MAGPIE holder rewards/balance → \`get_my_holder_stats\`
- User asks about their LP position/yield → \`get_my_lp_position\`
- User asks about protocol-wide stats (TVL, fees, etc.) → \`get_protocol_stats\`
- ALWAYS look up live state before quoting numbers. Don't guess.

WHEN TO ESCALATE (call \`open_support_ticket\`):
- The user has an issue you genuinely cannot diagnose with the available tools
- The user explicitly asks to talk to a human / the team
- Security-sensitive issue (compromised wallet, phishing report, suspected exploit)
- Refund / one-off decision that needs admin judgment
- Bug report that needs investigation
- After escalating, tell the user a ticket is opened and the team will reply via this bot.

WHAT YOU NEVER DO:
- Never claim a tx was successful without calling \`check_tx\` first
- Never recommend a specific token to buy or sell — you are not a financial advisor
- Never speculate on $MAGPIE price or other token prices
- Never make protocol promises beyond the core facts above (e.g., don't say "you'll get X tokens", "yield will be Y%", or invent timing windows)
- Never reveal the $MAGPIE holder snapshot timing — it's operator-private to prevent dump-after-snapshot gaming
- Never agree to do anything outside Magpie's scope. Politely redirect.

When in doubt: look it up with a tool, or escalate to a ticket. Honesty over confidence.`;

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
    name: "open_support_ticket",
    description: "Escalate this conversation to a human admin. Use ONLY when you cannot answer confidently with the available tools, when the user asks for a human, for security issues, or for decisions that need admin judgment.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A concise one-line summary of what the user needs help with (the admin will read this)" },
      },
      required: ["summary"],
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
    if (!rows[0]) return { error: "Loan not found, or it does not belong to this user." };
    const loan = rows[0];
    const program = getReadOnlyProgram();
    let onChain;
    try {
      onChain = await program.account.loan.fetch(new PublicKey(loan.loan_pda));
    } catch {
      return { error: "Could not read this loan from the chain right now." };
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
      `SELECT l.loan_id, l.status, l.loan_amount_lamports, l.original_loan_amount_lamports,
              l.due_timestamp, sm.symbol
         FROM loans l
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
        WHERE l.user_id = $1
        ORDER BY l.status = 'active' DESC, l.start_timestamp DESC
        LIMIT 10`,
      [userId],
    );
    return {
      total: rows.length,
      loans: rows.map((l) => ({
        loan_id: l.loan_id,
        symbol: l.symbol,
        status: l.status,
        currently_owed_sol: fmtSol(l.original_loan_amount_lamports),
        original_loan_sol: fmtSol(l.loan_amount_lamports),
        due_at_utc: l.due_timestamp ? new Date(l.due_timestamp).toISOString() : null,
      })),
    };
  },

  check_tx: async ({ signature }) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature || "")) {
      return { error: "That doesn't look like a valid Solana transaction signature." };
    }
    try {
      const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const s = res?.value?.[0];
      if (!s) return { signature, status: "not_found", note: "Tx was never submitted, expired (>90s blockhash), or dropped from mempool." };
      if (s.err) return { signature, status: "failed", error: JSON.stringify(s.err).slice(0, 200) };
      return {
        signature,
        status: s.confirmationStatus || "processing",
        slot: s.slot,
        solscan_url: `https://solscan.io/tx/${signature}`,
      };
    } catch (err) {
      return { error: `Could not reach Solana RPC: ${err.message?.slice(0, 100)}` };
    }
  },

  get_my_wallet: async (_args, { userId }) => {
    const pubkey = await getUserWallet(userId);
    if (!pubkey) return { error: "User has no Magpie wallet yet (they need to run /start)." };
    let balanceSol = 0;
    try {
      const lamports = await connection.getBalance(new PublicKey(pubkey));
      balanceSol = lamports / 1e9;
    } catch {}
    return { address: pubkey, sol_balance: balanceSol.toFixed(6) };
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
    if (!pubkey) return { error: "User has no Magpie wallet yet." };
    try {
      const { getHolderInfoByWallet } = await import("./magpie-holder-rewards.js");
      const info = await getHolderInfoByWallet(pubkey);
      if (!info) return { error: "Could not look up holder stats." };
      return {
        wallet: pubkey,
        magpie_balance: (Number(info.balance_raw) / 1e6).toFixed(2),
        has_balance: info.has_balance,
        lifetime_received_sol: fmtSol(info.lifetime_lamports),
        paid_sol: fmtSol(info.paid_lamports),
        distributions_received: info.distributions_count,
      };
    } catch (err) {
      return { error: `Holder stats lookup failed: ${err.message?.slice(0, 100)}` };
    }
  },

  get_my_lp_position: async (_args, { userId }) => {
    const pubkey = await getUserWallet(userId);
    if (!pubkey) return { error: "User has no Magpie wallet yet." };
    try {
      const { fetchDepositorPosition } = await import("../../node_modules/@solana/web3.js/lib/index.js").catch(() => ({}));
    } catch {}
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
      if (!position) return { has_position: false };
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
      return { error: `LP position lookup failed: ${err.message?.slice(0, 100)}` };
    }
  },

  get_protocol_stats: async () => {
    try {
      const r = await fetch("https://www.magpie.capital/api/v1/pool/stats", { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { error: "Pool stats API unavailable." };
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
      return { error: `Stats fetch failed: ${err.message?.slice(0, 100)}` };
    }
  },

  open_support_ticket: async ({ summary }, { userId }) => {
    const { rows: [t] } = await query(
      `INSERT INTO support_tickets (user_id, message, status)
       VALUES ($1, $2, 'open')
       RETURNING id`,
      [userId, `[AI-escalated] ${summary}`],
    );
    return { ticket_id: t.id, status: "open" };
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

// ──────────────────────────── ANTHROPIC API ─────────────────────

async function callAnthropic(messages) {
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
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
  }
  return res.json();
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
      return {
        text: "The support agent hit an issue talking to its brain. Tap *Open a ticket* and the team will follow up.",
        error: err.message,
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
      usedTools.push(tu.name);
      const handler = TOOL_HANDLERS[tu.name];
      let result;
      if (!handler) {
        result = { error: `Unknown tool: ${tu.name}` };
      } else {
        try {
          result = await handler(tu.input || {}, { userId });
          if (tu.name === "open_support_ticket" && result?.ticket_id) {
            escalatedTicketId = result.ticket_id;
          }
        } catch (err) {
          result = { error: err.message?.slice(0, 200) || "Tool failed." };
        }
      }
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
