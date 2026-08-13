#!/usr/bin/env node
/**
 * Guard: the community captcha deep-link.
 *
 * WHY THIS MATTERS. The captcha is the gate that keeps scammers out of the
 * group, and it failed in BOTH directions before this:
 *
 *   - Too strict, catastrophically: the bot tried to DM the challenge, but
 *     Telegram forbids a bot from opening a DM with someone who hasn't started
 *     it. 893 of 1,065 captcha kicks were `no_dm_response (DM blocked)` — real
 *     people removed for a message that could never arrive. Only 351 ever
 *     passed, so the gate ejected ~3x more than it admitted.
 *   - Confusing in-group: the shared inline button was visible to everyone
 *     (Telegram cannot hide a group button per-user).
 *
 * The deep-link fixes both: tapping it OPENS the member's own DM, which both
 * starts the bot (so the DM channel exists from then on) and scopes
 * verification to them.
 *
 * The payload is USER-SUPPLIED (`?start=cap_<chatId>_<userId>`), so the
 * properties asserted here are the ones an attacker would attack:
 *   1. You cannot verify SOMEONE ELSE — identity comes from ctx.from.id.
 *   2. You cannot pre-verify yourself into a group you never joined.
 *   3. A forged chatId cannot make the bot delete arbitrary messages.
 *
 * Run: npm run check:captcha-deeplink
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const start = readFileSync(path.join(dir, "../src/commands/start.js"), "utf8");
const comm = readFileSync(path.join(dir, "../src/handlers/community-handlers.js"), "utf8");
const mod = readFileSync(path.join(dir, "../src/services/community-moderation.js"), "utf8");

let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { failures++; console.error(`  ❌ ${n}${d ? ` — ${d}` : ""}`); };
const expect = (n, a, w) => (a === w ? ok(n) : bad(n, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(w)}`));

// The payload grammar actually shipped in start.js.
const RE = /^cap_(-?\d+)_(\d+)$/;

console.log("\n== payload parsing (chat ids are NEGATIVE — a common off-by-one) ==");
expect("real supergroup payload parses", RE.test("cap_-1003947451426_1795783624"), true);
expect("  chatId keeps its sign", "cap_-1003947451426_1795783624".match(RE)[1], "-1003947451426");
expect("  userId extracted", "cap_-1003947451426_1795783624".match(RE)[2], "1795783624");
expect("positive chat id also parses", RE.test("cap_123_456"), true);
for (const junk of [
  "cap_", "cap_abc_123", "cap_123", "cap_123_", "cap_1_2_3",
  "cap_-_1", "capX123_456", " cap_1_2", "cap_1_2 ",
  "cap_1_-2",                      // negative USER id must not parse
  "cap_1_2\nloan",                 // newline injection into another deep-link
]) {
  if (RE.test(junk)) bad(`junk payload ACCEPTED: ${JSON.stringify(junk)}`);
}
ok("all malformed payloads rejected");

console.log("\n== property 1: you cannot verify SOMEONE ELSE ==");
{
  // The shipped guard is `ctx.from?.id === capUserId`.
  const guard = (fromId, payload) => {
    const m = payload.match(RE);
    if (!m) return false;
    return fromId === Number(m[2]);
  };
  expect("target tapping their own link verifies", guard(1795783624, "cap_-100394_1795783624"), true);
  expect("ATTACKER tapping victim's link does NOT", guard(999, "cap_-100394_1795783624"), false);
  expect("attacker forging victim id in payload does NOT", guard(999, "cap_-100394_999999"), false);
  expect("identity is the CALLER's, never the payload's", guard(999, "cap_-100394_999"), true);
  expect("source of truth is ctx.from.id", /ctx\.from\?\.id === capUserId/.test(start), true);
}

console.log("\n== property 2: no pre-verification into a group you never joined ==");
{
  // markCaptchaPassed must be an UPDATE (no-op when no membership row exists),
  // never an INSERT/UPSERT — otherwise a forged chatId would mint a verified
  // membership before the attacker ever joins.
  const fn = mod.slice(mod.indexOf("export async function markCaptchaPassed"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  expect("markCaptchaPassed is an UPDATE", /UPDATE\s+community_members/i.test(body), true);
  expect("  ...and NOT an INSERT/UPSERT", /INSERT\s+INTO|ON CONFLICT/i.test(body), false);
  expect("  ...scoped by BOTH chat_id and user_id", /WHERE chat_id = \$1 AND user_id = \$2/.test(body), true);
  expect("  ...parameterised (no interpolation)", /\$\{/.test(body), false);
}

console.log("\n== property 3: a forged chatId cannot delete arbitrary messages ==");
{
  const fn = comm.slice(comm.indexOf("async function clearGroupCaptcha"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  expect("looks the message up in the in-memory map", /captchaGroupMsgs\.get\(key\)/.test(body), true);
  expect("returns early when absent", /if \(msgId == null\) return;/.test(body), true);
  // The delete must come AFTER the null-guard, so an unknown chat deletes nothing.
  expect("guard precedes deleteMessage", body.indexOf("msgId == null") < body.indexOf("deleteMessage"), true);
}

console.log("\n== the in-group button is a deep-link, and the fallback is identity-checked ==");
expect("welcome carries a t.me deep-link", /https:\/\/t\.me\/\$\{botUsername\}\?start=cap_/.test(comm), true);
expect("callback fallback rejects a non-target tapper", /userId !== targetUserId/.test(comm), true);

console.log("\n== fail-open preserved: never kick someone who was never shown a check ==");
expect("kick only scheduled when the group post succeeded", /if \(groupPosted\) \{[\s\S]{0,120}scheduleCaptchaKick/.test(comm), true);
expect("explicitly fails open otherwise", /failing open \(no kick\)/.test(comm), true);
expect("no blind DM attempt remains that could gate the kick", /dmOk/.test(comm), false);

console.log(
  failures === 0 ? "\n✅ captcha deep-link guard passed\n" : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
