#!/usr/bin/env node
/**
 * Guard: loan-expiry warning delivery.
 *
 * Protects the property that a borrower cannot silently forfeit collateral.
 * Two things are asserted here and they pull in OPPOSITE directions, which is
 * the whole point:
 *
 *   1. Known-permanent rejections ARE recognised, so the watcher stops
 *      hammering Telegram every 60s and records the state.
 *   2. Everything else is treated as TRANSIENT, so a warning that could still
 *      be delivered never gets suppressed by an over-eager matcher.
 *
 * (2) is the safety-critical direction. A regression there is silent: nothing
 * errors, the retry just stops and the borrower is never told.
 *
 * Run: npm run check:warning-delivery
 */
import {
  isPermanentDeliveryFailure,
  deliveryFailureReason,
} from "../src/services/telegram-delivery.js";

let failures = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const bad = (name, detail) => {
  failures++;
  console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
};

function expect(name, actual, wanted) {
  if (actual === wanted) ok(name);
  else bad(name, `got ${actual}, wanted ${wanted}`);
}

/** grammY's GrammyError shape. */
const grammy = (error_code, description) => ({
  error_code,
  description,
  message: `Call to 'sendMessage' failed! (${error_code}: ${description})`,
});

console.log("\n== permanent: retrying can never work ==");
// The exact error observed in production logs against four live loans.
expect(
  "400 chat not found (the real production error)",
  isPermanentDeliveryFailure(grammy(400, "Bad Request: chat not found")),
  true,
);
expect(
  "403 bot was blocked by the user",
  isPermanentDeliveryFailure(grammy(403, "Forbidden: bot was blocked by the user")),
  true,
);
expect(
  "403 user is deactivated",
  isPermanentDeliveryFailure(grammy(403, "Forbidden: user is deactivated")),
  true,
);
expect(
  "400 PEER_ID_INVALID",
  isPermanentDeliveryFailure(grammy(400, "Bad Request: PEER_ID_INVALID")),
  true,
);
expect(
  "case-insensitive matching",
  isPermanentDeliveryFailure(grammy(400, "Bad Request: CHAT NOT FOUND")),
  true,
);

console.log("\n== transient: MUST keep retrying (the dangerous direction) ==");
expect("429 rate limited", isPermanentDeliveryFailure(grammy(429, "Too Many Requests: retry after 30")), false);
expect("500 Telegram fault", isPermanentDeliveryFailure(grammy(500, "Internal Server Error")), false);
expect("502 gateway", isPermanentDeliveryFailure(grammy(502, "Bad Gateway")), false);
expect("network ETIMEDOUT", isPermanentDeliveryFailure(new Error("connect ETIMEDOUT 149.154.167.220:443")), false);
expect("socket hang up", isPermanentDeliveryFailure(new Error("socket hang up")), false);
expect("fetch failed", isPermanentDeliveryFailure(new TypeError("fetch failed")), false);
expect(
  "429 whose text happens to contain a permanent phrase",
  isPermanentDeliveryFailure(grammy(429, "Too Many Requests: chat not found")),
  false,
);
expect(
  "unrecognised 400 (Telegram may add new ones)",
  isPermanentDeliveryFailure(grammy(400, "Bad Request: message text is empty")),
  false,
);
expect("undefined", isPermanentDeliveryFailure(undefined), false);
expect("null", isPermanentDeliveryFailure(null), false);
expect("empty object", isPermanentDeliveryFailure({}), false);
expect("string thrown", isPermanentDeliveryFailure("boom"), false);

console.log("\n== reason string is safe to store and show ==");
{
  const r = deliveryFailureReason(grammy(400, "Bad Request: chat not found"));
  expect("includes the code", r.includes("400"), true);
  expect("includes the description", r.includes("chat not found"), true);
  const long = deliveryFailureReason(grammy(400, "x".repeat(5000)));
  expect("bounded to 200 chars", long.length <= 200, true);
  expect("never throws on junk", typeof deliveryFailureReason(null), "string");
}

console.log("\n== watcher wiring ==");
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/services/loan-watcher.js", import.meta.url), "utf8"),
  );
  // A permanent failure must NOT be laundered into "we warned them".
  const marksWarnedOnFailure = /warn_undeliverable_at = NOW\(\)[\s\S]{0,120}warned_(24h|6h)_at = NOW\(\)/.test(src);
  expect("failure never sets warned_*", marksWarnedOnFailure, false);
  expect("backstop runs each tick", /await checkUnwarnedNearDue\(bot\)/.test(src), true);
  expect("backstop ignores the classifier", /warn_escalated_at IS NULL/.test(src), true);
  expect("undeliverable rows still retried hourly", /warn_undeliverable_at < NOW\(\)/.test(src), true);
}

console.log(
  failures === 0
    ? "\n✅ warning-delivery guard passed\n"
    : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
