/**
 * Evaluation harness for the AI support agent.
 *
 * Runs a battery of fixed test cases against the LIVE agent (real
 * Anthropic API). Asserts that the AI calls the right tools, does
 * NOT call forbidden tools, and that key facts appear in the answer.
 *
 * Costs ~$0.05-0.15 per full run depending on cache hits. Run before
 * shipping AI changes:
 *
 *   node scripts/eval-ai-support.js
 *
 * Exit code 0 = all pass, 1 = at least one fail.
 *
 * Uses a synthetic user_id (-999_000_001) so it doesn't pollute real
 * user state. Cleans up its own conversation rows on exit.
 */
import "dotenv/config";
import { chatWithAgent, resetConversation } from "../src/services/ai-support.js";
import { query } from "../src/db/pool.js";

const TEST_USER_ID = -999_000_001;

const CASES = [
  {
    name: "Vague 'check on my loan' triggers list_my_loans, NOT a ticket",
    prompt: "Can you check in on my existing loan?",
    expectTools: ["list_my_loans"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Specific loan ID triggers lookup_loan",
    prompt: "How's loan #9999999999 doing?",
    expectTools: ["lookup_loan"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Static protocol fact: LTV tiers — no tools needed, no false escalation",
    prompt: "What are the LTV tiers and fees?",
    expectTools: [],
    forbiddenTools: ["open_support_ticket"],
    expectInText: ["30%", "25%", "20%"],
  },
  {
    name: "Wallet question triggers get_my_wallet",
    prompt: "What's my wallet address and balance?",
    expectTools: ["get_my_wallet"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Referrals question triggers get_my_referrals",
    prompt: "How much have I earned from referrals?",
    expectTools: ["get_my_referrals"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Protocol-wide stats question triggers get_protocol_stats",
    prompt: "How much TVL does Magpie have right now?",
    expectTools: ["get_protocol_stats"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Security incident escalates (security_incident reason allowed without prior tool)",
    prompt: "I think someone got into my wallet, my SOL is gone",
    expectTools: ["open_support_ticket"],
    forbiddenTools: [],
  },
  {
    name: "Explicit human request escalates",
    prompt: "I need to talk to a real human on the team, not an AI",
    expectTools: ["open_support_ticket"],
    forbiddenTools: [],
  },
  {
    name: "PII scrub: 12-word mnemonic is rejected, never hits Anthropic",
    prompt: "my seed is abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    expectBlocked: "mnemonic",
  },
  {
    name: "Credit score inquiry triggers get_my_credit_score",
    prompt: "What's my credit score and tier?",
    expectTools: ["get_my_credit_score"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Token support check triggers check_token_supported (by symbol)",
    prompt: "Can I borrow against $WIF?",
    expectTools: ["check_token_supported"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Submission inquiry triggers get_my_token_submissions",
    prompt: "Did the token I submitted get approved?",
    expectTools: ["get_my_token_submissions"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Recent activity inquiry calls a loan-history tool (either is fine)",
    prompt: "What loans have I taken recently?",
    // Either tool is acceptable here — the AI may pick either depending on framing
    expectAnyTool: ["get_my_recent_activity", "list_my_loans"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Lending limit question triggers get_my_loan_limits",
    prompt: "What are the lending limits per wallet?",
    // AI might call get_my_loan_limits (personalized) or answer from facts. Both fine.
    expectAnyTool: ["get_my_loan_limits"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "How much can I borrow → triggers get_my_loan_limits",
    prompt: "How much SOL can I borrow right now?",
    expectAnyTool: ["get_my_loan_limits"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Loan limit fact-question — AI knows the tier numbers",
    prompt: "What's the max loan size on Magpie? Walk me through the tiers.",
    forbiddenTools: ["open_support_ticket"],
    // Should mention both tier caps when explicitly asked about all tiers
    expectInText: ["3 SOL", "5 SOL"],
  },
  {
    name: "AI knows what /partialrepay does",
    prompt: "What does /partialrepay do?",
    forbiddenTools: ["open_support_ticket"],
    expectInText: ["part"], // mentions "part" of a loan
  },
  {
    name: "AI knows the /lend vs LP-pool distinction",
    prompt: "What's the difference between /lend and earning on magpie.capital/earn?",
    forbiddenTools: ["open_support_ticket"],
    // Should mention that /lend is P2P pools and earn is the main LP
    expectInText: ["P2P"],
  },
  {
    name: "AI handles 'I deposited but don't see it'",
    prompt: "I sent SOL to my wallet but I don't see it yet, what's wrong?",
    // The right move is to ask for tx sig OR check wallet — both fine
    expectAnyTool: ["get_my_wallet", "check_tx"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "AI handles 'why need 0.01 SOL extra' question",
    prompt: "Why do I need extra SOL beyond what I want to borrow against?",
    forbiddenTools: ["open_support_ticket"],
    // Should explain gas/ATA rent
    expectInText: ["fee"], // either "tx fees" or "transaction fees" or "rent fee"
  },
  {
    name: "Vague help asks for clarification, no premature escalation",
    prompt: "help",
    expectTools: [],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Off-protocol question (investment advice) is deflected, not escalated",
    prompt: "Should I buy more $MAGPIE? Is it going up?",
    expectTools: [],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Educational 'how does it work' answered without unnecessary tools",
    prompt: "How does the LP yield actually work?",
    expectTools: [],
    forbiddenTools: ["open_support_ticket", "list_my_loans"],
    expectInText: ["80%"],
  },
];


const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function pass(s) { return `${COLORS.green}✓${COLORS.reset} ${s}`; }
function fail(s) { return `${COLORS.red}✗${COLORS.reset} ${s}`; }
function info(s) { return `${COLORS.dim}${s}${COLORS.reset}`; }

async function setupTestUser() {
  // Insert minimal rows so tools don't blow up on "user not found"
  await query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [TEST_USER_ID, "ai_eval_harness"],
  );
}

async function cleanup() {
  try {
    await query(`DELETE FROM support_conversations WHERE user_id = $1`, [TEST_USER_ID]);
  } catch {}
}

async function runCase(c, idx) {
  await resetConversation(TEST_USER_ID); // fresh state per case
  console.log(`\n${COLORS.cyan}[${idx + 1}/${CASES.length}]${COLORS.reset} ${c.name}`);
  console.log(info(`  prompt: "${c.prompt.slice(0, 100)}"`));

  let result;
  try {
    result = await chatWithAgent(TEST_USER_ID, c.prompt);
  } catch (err) {
    console.log(fail(`  threw: ${err.message}`));
    return false;
  }

  if (!result) {
    console.log(fail(`  null result (is ANTHROPIC_API_KEY set?)`));
    return false;
  }

  let okay = true;

  // PII scrub case
  if (c.expectBlocked) {
    if (result.blocked_reason !== c.expectBlocked) {
      console.log(fail(`  expected blocked_reason="${c.expectBlocked}", got "${result.blocked_reason}"`));
      okay = false;
    } else {
      console.log(pass(`  PII scrub blocked (${result.blocked_reason})`));
    }
    return okay;
  }

  const used = result.used_tools || [];
  console.log(info(`  tools used: [${used.join(", ") || "(none)"}]`));

  // Expected tools must all be present
  for (const t of c.expectTools || []) {
    if (!used.includes(t)) {
      console.log(fail(`  missing expected tool: ${t}`));
      okay = false;
    }
  }

  // At least one of these tools must be present (OR-match)
  if (c.expectAnyTool && c.expectAnyTool.length > 0) {
    const hit = c.expectAnyTool.some((t) => used.includes(t));
    if (!hit) {
      console.log(fail(`  none of these expected-any tools were called: ${c.expectAnyTool.join(", ")}`));
      okay = false;
    }
  }

  // Forbidden tools must NOT appear
  for (const t of c.forbiddenTools || []) {
    if (used.includes(t)) {
      console.log(fail(`  unexpected forbidden tool called: ${t}`));
      okay = false;
    }
  }

  // Expected substrings in response
  for (const sub of c.expectInText || []) {
    if (!result.text.includes(sub)) {
      console.log(fail(`  expected text to include: "${sub}"`));
      okay = false;
    }
  }

  if (okay) console.log(pass(`  case passed`));
  console.log(info(`  response: ${result.text.slice(0, 140).replace(/\n/g, " ")}…`));
  return okay;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — cannot run eval");
    process.exit(2);
  }

  await setupTestUser();

  let passed = 0;
  let failed = 0;
  for (let i = 0; i < CASES.length; i++) {
    const ok = await runCase(CASES[i], i);
    if (ok) passed++; else failed++;
  }

  await cleanup();

  console.log(`\n${"━".repeat(60)}`);
  console.log(`Results: ${COLORS.green}${passed} passed${COLORS.reset}, ${failed > 0 ? COLORS.red : COLORS.dim}${failed} failed${COLORS.reset}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
