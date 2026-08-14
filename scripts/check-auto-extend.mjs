#!/usr/bin/env node
/**
 * check:auto-extend — every safety boundary of the auto-extend decision core.
 *
 * The core is PURE (src/services/auto-extend-core.js) so this runs without
 * booting the bot. The boundaries under test ARE the safety envelope:
 * Q-02 window floor, explicit opt-in, cap, cooldown, underwater guard
 * (incl. fail-open on missing price), balance buffer, and error fallback.
 */
import { strict as assert } from "node:assert";
import {
  decideAutoExtend,
  extendFeeLamports,
  WINDOW_CEILING_MS,
  WINDOW_FLOOR_MS,
  MAX_AUTO_EXTENDS,
  ATTEMPT_COOLDOWN_MS,
  BALANCE_BUFFER_LAMPORTS,
} from "../src/services/auto-extend-core.js";

const NOW = 1_755_000_000_000;
const base = {
  status: "active",
  dueMs: NOW + 60 * 60 * 1000, // 1h out — inside the window
  optIn: true,
  autoExtendCount: 0,
  feeLamports: 10_000_000n, // 0.01 SOL
  walletBalanceLamports: 1_000_000_000n, // 1 SOL
  healthRatio: 2.0,
  lastAttemptMs: null,
};

let failures = 0;
function expect(name, loan, want) {
  const got = decideAutoExtend(loan, NOW);
  const ok = got.action === want.action && (want.reason === undefined || got.reason === want.reason);
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} — want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  }
}

// Happy path
expect("healthy opted-in loan inside window → extend", base, { action: "extend" });

// Window (the Q-02 envelope)
expect("due beyond ceiling → skip before_window", { ...base, dueMs: NOW + WINDOW_CEILING_MS + 1 }, { action: "skip", reason: "before_window" });
expect("due exactly at ceiling → extend", { ...base, dueMs: NOW + WINDOW_CEILING_MS }, { action: "extend" });
expect("due exactly at floor → skip past_window_floor", { ...base, dueMs: NOW + WINDOW_FLOOR_MS }, { action: "skip", reason: "past_window_floor" });
expect("due 1ms past floor → extend", { ...base, dueMs: NOW + WINDOW_FLOOR_MS + 1 }, { action: "extend" });
expect("OVERDUE loan → skip past_window_floor (never brush Q-02)", { ...base, dueMs: NOW - 1000 }, { action: "skip", reason: "past_window_floor" });

// Status + opt-in
expect("repaid loan → skip not_active", { ...base, status: "repaid" }, { action: "skip", reason: "not_active" });
expect("not opted in → skip", { ...base, optIn: false }, { action: "skip", reason: "not_opted_in" });

// Cap
expect(`count=${MAX_AUTO_EXTENDS} → skip cap_reached`, { ...base, autoExtendCount: MAX_AUTO_EXTENDS }, { action: "skip", reason: "cap_reached" });
expect(`count=${MAX_AUTO_EXTENDS - 1} → extend`, { ...base, autoExtendCount: MAX_AUTO_EXTENDS - 1 }, { action: "extend" });

// Cooldown
expect("recent attempt → skip cooldown", { ...base, lastAttemptMs: NOW - ATTEMPT_COOLDOWN_MS + 1000 }, { action: "skip", reason: "cooldown" });
expect("stale attempt → extend", { ...base, lastAttemptMs: NOW - ATTEMPT_COOLDOWN_MS - 1000 }, { action: "extend" });

// Health guard — and its deliberate fail-open on missing price
expect("underwater (1.05) → skip underwater", { ...base, healthRatio: 1.05 }, { action: "skip", reason: "underwater" });
expect("exactly 1.10 → extend", { ...base, healthRatio: 1.1 }, { action: "extend" });
expect("price unavailable (null) → extend (fail open — protects borrower)", { ...base, healthRatio: null }, { action: "extend" });

// Balance
expect("balance exactly fee+buffer-1 → skip insufficient_balance",
  { ...base, walletBalanceLamports: base.feeLamports + BALANCE_BUFFER_LAMPORTS - 1n },
  { action: "skip", reason: "insufficient_balance" });
expect("balance exactly fee+buffer → extend",
  { ...base, walletBalanceLamports: base.feeLamports + BALANCE_BUFFER_LAMPORTS },
  { action: "extend" });

// Malformed row must skip, never throw / never extend
expect("malformed row → skip decision_error", { ...base, dueMs: { bad: true }, walletBalanceLamports: "x" }, { action: "skip" });

// Fee math mirrors executeExtendLoan's tiers exactly
assert.equal(extendFeeLamports(30, 1_000_000_000n), 30_000_000n, "express 3%");
assert.equal(extendFeeLamports(25, 1_000_000_000n), 20_000_000n, "quick 2%");
assert.equal(extendFeeLamports(20, 1_000_000_000n), 15_000_000n, "standard 1.5%");
console.log("  ✓ fee tiers mirror executeExtendLoan (3% / 2% / 1.5%)");

// Wiring tripwires
const { readFileSync } = await import("node:fs");
const watcher = readFileSync(new URL("../src/services/auto-extend-watcher.js", import.meta.url), "utf8");
const idx = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
for (const [name, ok] of [
  ["watcher re-checks Q-02 window at execution time", watcher.includes("WINDOW_FLOOR_MS")],
  ["watcher never DMs negative telegram ids", watcher.includes("< 0) return")],
  ["watcher has AUTOEXTEND_DISABLED kill switch", watcher.includes("AUTOEXTEND_DISABLED")],
  ["index.js starts the watcher", idx.includes("startAutoExtendWatcher")],
  ["index.js registers /autoextend", idx.includes('bot.command("autoextend"')],
]) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

if (failures > 0) {
  console.error(`\ncheck:auto-extend FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log("\n[auto-extend] OK — window, opt-in, cap, cooldown, health, balance, wiring all verified.");
