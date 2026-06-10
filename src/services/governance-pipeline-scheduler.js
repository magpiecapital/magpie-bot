/**
 * Governance autopilot scheduler.
 *
 * Wakes every 5 minutes and runs the pipeline tick. The pipeline itself
 * holds a Postgres advisory lock so overlapping ticks are safe — but the
 * 5 min cadence is the default heartbeat.
 *
 * No-op until the autopilot is enabled (via /gov-resume). Pipeline reads
 * the enabled flag from DB; even if the scheduler is firing, halted-by-flag
 * proposals exit clean without mutating anything.
 *
 * Started from src/index.js onStart, following the same pattern as the
 * other periodic services (community-broadcast, risk-engine, etc.).
 */

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 60_000;  // wait 1 min after bot start so other services init

let _timer = null;

export function startGovernancePipelineScheduler() {
  if (_timer) return;  // idempotent — second call is a no-op

  // First tick after delay
  setTimeout(async () => {
    await tick();
    _timer = setInterval(tick, TICK_INTERVAL_MS);
  }, FIRST_TICK_DELAY_MS);

  console.log(
    `[governance-autopilot] scheduler armed — first tick in ${FIRST_TICK_DELAY_MS / 1000}s, ` +
      `then every ${TICK_INTERVAL_MS / 60_000} min`,
  );
}

async function tick() {
  try {
    const { runPipelineTick } = await import("../governance/pipeline.js");
    const result = await runPipelineTick();
    // Quiet logging — only log when there's work or an issue
    if (result.ran === false) {
      console.log("[governance-autopilot] tick skipped:", result.reason);
    } else if (result.processed > 0) {
      console.log("[governance-autopilot] tick processed", result.processed, "proposal(s):", JSON.stringify(result.outcomes));
    }
    // ran=true, processed=0 → no work this tick; silent (5min × 288 ticks/day; don't spam logs)
  } catch (err) {
    console.error("[governance-autopilot] tick threw:", err.message);
    // Tick will retry in 5 min — no need to alert on transient failures.
    // If failures persist, the operator will see it via /gov-status showing
    // last_run_status='error' with the message in last_run_detail.
  }
}

export function stopGovernancePipelineScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
