/**
 * Governance vote-reminder scheduler.
 *
 * Wakes every 5 min, posts smart-cadence reminders for active proposals.
 * No-op when no proposals are in an active voting window. Idempotent via
 * the governance_reminders table primary key.
 */

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 90_000;  // wait 90s after bot start (after autopilot's first tick)

let _timer = null;

export function startGovernanceReminderScheduler() {
  if (_timer) return;

  // Heartbeat reminders broadcast to GOVERNANCE_BROADCAST_CHAT_ID without a
  // per-broadcast operator green light. The autopilot's one-shot post-vote
  // announcement is explicitly authorized; these midstream reminders are NOT,
  // and the operator's voter-fatigue rule says don't autonomously broadcast.
  // Require explicit opt-in to enable. When disabled, the autopilot announcement
  // path is unaffected.
  if (process.env.ENABLE_GOV_HEARTBEAT_REMINDERS !== "true") {
    console.log(
      "[gov-reminders] scheduler DISABLED — set ENABLE_GOV_HEARTBEAT_REMINDERS=true to enable autonomous milestone reminders to the broadcast chat.",
    );
    return;
  }

  setTimeout(async () => {
    await tick();
    _timer = setInterval(tick, TICK_INTERVAL_MS);
  }, FIRST_TICK_DELAY_MS);

  console.log(
    `[gov-reminders] scheduler armed — first tick in ${FIRST_TICK_DELAY_MS / 1000}s, ` +
      `then every ${TICK_INTERVAL_MS / 60_000} min`,
  );
}

async function tick() {
  try {
    const { reminderTick } = await import("../governance/reminders.js");
    const r = await reminderTick();
    if (r.posted > 0) {
      console.log("[gov-reminders] posted", r.posted, "milestone reminder(s)");
    }
  } catch (err) {
    console.error("[gov-reminders] tick threw:", err.message);
  }
}

export function stopGovernanceReminderScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
