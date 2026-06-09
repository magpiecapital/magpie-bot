#!/usr/bin/env node
/**
 * One-shot scheduler: sleeps until $GOVERNANCE_SNAPSHOT_AT (ISO UTC),
 * then invokes governance-snapshot.js for $GOVERNANCE_SNAPSHOT_PROPOSAL.
 *
 * Designed to run unattended via `nohup` + `caffeinate` so an idle
 * laptop doesn't oversleep the timer. Single-shot — exits after firing.
 *
 * Privacy contract:
 *   - The target time and proposal ID are read from env vars, never
 *     committed to repo or logged to any persistent file beyond the
 *     scheduler's own stdout (which the operator captures privately).
 *   - On wake, exec's governance-snapshot.js which inherits the same
 *     privacy contract.
 *
 * Usage:
 *   GOVERNANCE_SNAPSHOT_AT="<ISO-UTC-timestamp>" \
 *   GOVERNANCE_SNAPSHOT_PROPOSAL=MGP-XXX \
 *   GOVERNANCE_SNAPSHOT_OUT_DIR=$HOME/.magpie-private/snapshots \
 *     nohup caffeinate -i node scripts/governance-snapshot-scheduler.js \
 *       > $HOME/.magpie-private/scheduler.log 2>&1 &
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const targetIso = process.env.GOVERNANCE_SNAPSHOT_AT;
const proposalId = process.env.GOVERNANCE_SNAPSHOT_PROPOSAL;
const outDir = process.env.GOVERNANCE_SNAPSHOT_OUT_DIR;

if (!targetIso || !proposalId || !outDir) {
  console.error(
    "Refusing to start. Required env: " +
      "GOVERNANCE_SNAPSHOT_AT, GOVERNANCE_SNAPSHOT_PROPOSAL, GOVERNANCE_SNAPSHOT_OUT_DIR",
  );
  process.exit(1);
}

const target = new Date(targetIso);
if (Number.isNaN(target.getTime())) {
  console.error(`Invalid GOVERNANCE_SNAPSHOT_AT: ${targetIso}`);
  process.exit(1);
}

const now = Date.now();
const delay = target.getTime() - now;
if (delay < 0) {
  console.error(`Target time is in the past (now=${new Date().toISOString()}).`);
  process.exit(1);
}

// Node's setTimeout caps at ~24.8 days (2^31-1 ms). Chain if larger.
const MAX_TIMEOUT = 2 ** 31 - 1;
function sleepThen(ms, cb) {
  if (ms <= MAX_TIMEOUT) return setTimeout(cb, ms);
  setTimeout(() => sleepThen(ms - MAX_TIMEOUT, cb), MAX_TIMEOUT);
}

console.log(
  JSON.stringify({
    scheduler_ready: true,
    now_utc: new Date().toISOString(),
    target_utc: target.toISOString(),
    delay_ms: delay,
    delay_hours: (delay / 3_600_000).toFixed(2),
  }),
);

sleepThen(delay, () => {
  const child = spawn(
    process.execPath,
    [join(SCRIPT_DIR, "governance-snapshot.js"), proposalId],
    {
      stdio: "inherit",
      env: { ...process.env },
    },
  );
  child.on("exit", (code) => {
    console.log(
      JSON.stringify({
        scheduler_done: true,
        fired_at_utc: new Date().toISOString(),
        snapshot_exit_code: code,
      }),
    );
    process.exit(code ?? 1);
  });
});

// Tick every minute so the log shows liveness during the wait.
// Useful if the process gets backgrounded for many hours.
const TICK_MS = 60 * 60 * 1000; // hourly
setInterval(() => {
  const remaining = target.getTime() - Date.now();
  console.log(
    JSON.stringify({
      tick: true,
      now_utc: new Date().toISOString(),
      remaining_hours: (remaining / 3_600_000).toFixed(2),
    }),
  );
}, TICK_MS).unref();
