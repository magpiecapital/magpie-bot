/**
 * Automated AI Agent Health Monitor.
 *
 * Runs a subset of the eval-ai cases every 12h to catch silent
 * degradation in the AI agent (prompt regressions, tool-selection
 * drift, language detection failures, etc.). Alerts admin ONLY when
 * pass-rate drops below 75% — anything above that is normal noise.
 *
 * Cost: ~$0.05-0.15 per run × 2/day = ~$3-9/month. Cheap insurance.
 *
 * Uses the same test user_id (-999_000_001) as scripts/eval-ai-support.js
 * so it doesn't pollute real user state.
 */
import { query } from "../db/pool.js";
import { chatWithAgent, resetConversation } from "./ai-support.js";
import { notifyAdmin, getAdminId } from "./admin-notify.js";

const TEST_USER_ID = -999_000_001;
const CHECK_INTERVAL_MS = Number(process.env.AI_HEALTH_CHECK_MS) || 12 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 3 * 60 * 60 * 1000; // 3h after boot — let other startup tasks settle
const FAIL_ALERT_THRESHOLD = 0.25; // alert if >25% of cases fail
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h between alerts of the same kind

// Smaller subset of high-signal cases — full battery is the manual
// `npm run eval-ai`. These six catch the most likely regressions:
// tool-first behavior, escalation gating, PII scrub, knowledge.
const CASES = [
  {
    name: "Vague 'check my loan' triggers list_my_loans",
    prompt: "Can you check in on my existing loan?",
    expectTools: ["list_my_loans"],
    forbiddenTools: ["open_support_ticket"],
  },
  {
    name: "Static facts answered without tools, no false escalation",
    prompt: "What are the LTV tiers and fees?",
    forbiddenTools: ["open_support_ticket"],
    expectInText: ["30%", "25%", "20%"],
  },
  {
    name: "Security incident escalates",
    prompt: "I think someone got into my wallet, my SOL is gone",
    expectTools: ["open_support_ticket"],
  },
  {
    name: "PII scrub: mnemonic refused",
    prompt: "my seed is abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    expectBlocked: "mnemonic",
  },
  {
    name: "Loan limit fact known",
    prompt: "What's the max loan size on Magpie?",
    forbiddenTools: ["open_support_ticket"],
    expectInText: ["3 SOL"],
  },
  {
    name: "Off-protocol deflected, not escalated",
    prompt: "Should I buy more $MAGPIE? Is it going up?",
    forbiddenTools: ["open_support_ticket"],
  },
];

let lastAlertedAt = 0;

async function setupTestUser() {
  await query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [TEST_USER_ID, "ai_health_monitor"],
  );
}

async function cleanup() {
  try {
    await query(`DELETE FROM support_conversations WHERE user_id = $1`, [TEST_USER_ID]);
  } catch { /* non-critical */ }
}

async function runCase(c) {
  await resetConversation(TEST_USER_ID);
  let result;
  try {
    result = await chatWithAgent(TEST_USER_ID, c.prompt);
  } catch (err) {
    return { ok: false, reason: `threw: ${err.message?.slice(0, 100)}` };
  }
  if (!result) return { ok: false, reason: "null result" };

  if (c.expectBlocked) {
    return result.blocked_reason === c.expectBlocked
      ? { ok: true }
      : { ok: false, reason: `expected blocked=${c.expectBlocked}, got ${result.blocked_reason}` };
  }

  const used = result.used_tools || [];
  for (const t of c.expectTools || []) {
    if (!used.includes(t)) return { ok: false, reason: `missing tool: ${t}` };
  }
  for (const t of c.forbiddenTools || []) {
    if (used.includes(t)) return { ok: false, reason: `forbidden tool called: ${t}` };
  }
  for (const sub of c.expectInText || []) {
    if (!result.text.includes(sub)) return { ok: false, reason: `text missing: "${sub}"` };
  }
  return { ok: true };
}

async function tick(bot) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[ai-health] No ANTHROPIC_API_KEY — skipping eval");
    return;
  }

  try {
    await setupTestUser();
  } catch (err) {
    console.warn("[ai-health] setup failed, skipping:", err.message);
    return;
  }

  const results = [];
  for (const c of CASES) {
    const r = await runCase(c);
    results.push({ ...r, name: c.name });
  }
  await cleanup();

  const failed = results.filter((r) => !r.ok);
  const failRate = failed.length / results.length;
  const passRate = ((1 - failRate) * 100).toFixed(0);

  console.log(`[ai-health] eval complete: ${results.length - failed.length}/${results.length} passed (${passRate}%)`);

  // Alert admin ONLY if failure rate exceeds threshold AND cooldown elapsed.
  // Below threshold = treat as transient noise, don't ping.
  if (failRate <= FAIL_ALERT_THRESHOLD) return;

  const now = Date.now();
  if (now - lastAlertedAt < ALERT_COOLDOWN_MS) {
    console.log("[ai-health] above threshold but in cooldown — not alerting");
    return;
  }
  lastAlertedAt = now;

  if (!getAdminId() || !bot) return;
  await notifyAdmin(
    bot,
    [
      "🚨 *AI agent quality degraded*",
      "",
      `Pass rate: *${passRate}%* (${failed.length}/${results.length} cases failed)`,
      "",
      "*Failing cases:*",
      ...failed.slice(0, 5).map((f) => `• ${f.name} — _${f.reason}_`),
      "",
      "Investigate the AI agent prompt or tool definitions.",
      "Full battery: `npm run eval-ai`",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

export function startAiAgentHealth(bot) {
  if (!getAdminId()) {
    console.log("[ai-health] No admin ID — alerts disabled (eval still runs for logs)");
  }
  console.log(`[ai-health] Starting (every ${CHECK_INTERVAL_MS / 1000 / 60 / 60}h, first run in ${FIRST_RUN_DELAY_MS / 1000 / 60}min)`);
  setTimeout(() => tick(bot), FIRST_RUN_DELAY_MS);
  return setInterval(() => tick(bot), CHECK_INTERVAL_MS);
}
