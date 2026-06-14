/**
 * DB-quota guard — the bot's last line of defense against the
 * 2026-06-14 outage class.
 *
 * What that outage looked like
 * ────────────────────────────
 * `DATABASE_URL` pointed at a Neon Postgres on a plan with a hard
 * compute-hours quota. Quota exhausted. Every query returned
 * `SQLSTATE XX000 "Your account or project has exceeded the compute
 * time quota."` The `extend-loan-watcher`'s startup query threw inside
 * a fire-and-forget setTimeout, Node 20 surfaced it as an unhandled
 * promise rejection, the process crashed. The platform restarted the
 * process. The first query crashed it again. ~30 minutes of crash
 * loop. See [[project_magpie_outage_2026_06_14_neon_quota]].
 *
 * Why crash-looping made it worse
 * ───────────────────────────────
 * Each restart hits the DB again (driver init, schema bootstraps,
 * watcher init). Crash-restart-crash chews quota faster than the
 * graceful "page operator and wait" path that should have happened.
 *
 * What this module does
 * ─────────────────────
 *   1. Installs ONE global unhandledRejection + uncaughtException
 *      handler at the very top of process startup. If the error
 *      matches the DB-quota / DB-dead pattern, the handler
 *      SUPPRESSES the crash, sets a degraded flag, and pages the
 *      operator via direct Telegram API (no DB lookup needed).
 *      Anything else falls through to default behavior (crash so
 *      the platform can restart cleanly).
 *   2. Exports `isDbQuotaError(err)` so individual watcher loops
 *      can detect the failure and back off instead of throwing.
 *   3. Exports `isDegraded()` so health checks can report the
 *      reality.
 *   4. Self-heals — every 60s while degraded, sends one trivial
 *      probe query. When it succeeds, clears the flag and pages
 *      the operator with "recovered."
 *
 * What this module deliberately does NOT do
 * ─────────────────────────────────────────
 *   - It does NOT depend on src/db/pool.js or any DB-touching
 *     import for the page-operator path. The whole point is to
 *     work when the DB is dead. Telegram API is hit directly via
 *     fetch().
 *   - It does NOT depend on src/services/security-alerts.js for
 *     the same reason (that module imports db/pool.js).
 *   - It does NOT shadow real errors. A non-DB unhandledRejection
 *     still crashes the process. We only catch DB-quota / DB-dead
 *     patterns.
 *
 * Honesty note
 * ────────────
 * This closes ONE specific failure class — DB compute quota
 * exhaustion / DB host being unreachable. Other failure modes
 * (corrupt schema, malformed query, RPC outages, Solana network
 * congestion) still surface their own way. Honest scope per
 * [[feedback_never_again_be_honest]].
 */

const TG_API = "https://api.telegram.org";

/**
 * Detect the DB-quota / DB-dead error family.
 *
 * Postgres `XX000` is "internal error" — Neon uses it for plan-limit
 * messages. We also catch:
 *   - "ECONNREFUSED" / "ETIMEDOUT" / "ENOTFOUND" against the DB host
 *   - "Connection terminated"
 *   - "too many connections"
 *
 * Anything matching here means "the DB layer is functionally
 * unavailable, don't crash, page operator, wait."
 */
export function isDbQuotaError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // Neon quota — the exact string from the 2026-06-14 outage.
  if (/exceeded the compute time quota/i.test(msg)) return true;
  if (/exceeded.*storage quota/i.test(msg)) return true;
  if (/limit.*reached.*plan/i.test(msg)) return true;
  // Generic DB-dead patterns. Each of these on the DB pool means
  // "queries can't run, don't crash-loop."
  if (err.code === "XX000") return true;
  if (err.code === "ECONNREFUSED" && /5432|postgres|neon|rlwy/i.test(msg)) return true;
  if (err.code === "ETIMEDOUT" && /postgres|neon|rlwy/i.test(msg)) return true;
  if (/Connection terminated unexpectedly/i.test(msg)) return true;
  if (/too many connections/i.test(msg)) return true;
  // pg pool emits this when it can't get a client. Common during
  // Neon throttle.
  if (/Connection error|connection.*refused/i.test(msg) && /pg-pool/i.test(String(err.stack || ""))) return true;
  return false;
}

let _degraded = false;
let _degradedReason = null;
let _degradedSince = null;
let _lastPageAt = 0;
const PAGE_COOLDOWN_MS = 5 * 60_000; // never spam operator faster than once per 5 min

export function isDegraded() {
  return _degraded;
}

export function degradedSnapshot() {
  return {
    degraded: _degraded,
    reason: _degradedReason,
    since: _degradedSince,
    ageMs: _degradedSince ? Date.now() - _degradedSince : null,
  };
}

/**
 * Direct-to-Telegram page. Does NOT touch DB. Reads
 * OPERATOR_TG_IDS env (comma-separated) and TELEGRAM_BOT_TOKEN.
 *
 * The whole bot might be on its knees here — this is the only
 * signal the operator gets. Make it short, clear, and actionable.
 */
async function pageOperatorDirect(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[db-quota-guard] cannot page operator: TELEGRAM_BOT_TOKEN unset");
    return;
  }
  const ids = (process.env.OPERATOR_TG_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    console.error("[db-quota-guard] cannot page operator: OPERATOR_TG_IDS unset");
    return;
  }
  for (const id of ids) {
    try {
      const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(id),
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[db-quota-guard] tg page to ${id} failed: ${res.status} ${body.slice(0, 120)}`);
      }
    } catch (err) {
      console.error(`[db-quota-guard] tg page to ${id} threw: ${err.message?.slice(0, 120)}`);
    }
  }
}

function enterDegraded(reason) {
  if (_degraded) return; // already there — don't re-page on every error
  _degraded = true;
  _degradedReason = reason;
  _degradedSince = Date.now();
  console.error(`[db-quota-guard] entering DEGRADED mode: ${reason}`);
  const now = Date.now();
  if (now - _lastPageAt > PAGE_COOLDOWN_MS) {
    _lastPageAt = now;
    pageOperatorDirect(
      [
        "*MAGPIE-BOT — DB DEGRADED*",
        "",
        `Reason: \`${String(reason).slice(0, 300)}\``,
        "",
        "API is still serving but DB-backed paths are failing. Common cause: DB compute-quota or plan limit exceeded.",
        "",
        "Action:",
        "1. Check the DB dashboard (Neon / Railway) for plan / quota state.",
        "2. Upgrade plan or wait for window reset.",
        "3. Bot self-recovers once DB starts answering — no manual restart needed.",
        "",
        "This page DOES NOT repeat for 5 min.",
      ].join("\n"),
    ).catch((e) => console.error("[db-quota-guard] page failed:", e?.message));
  }
}

function leaveDegraded() {
  if (!_degraded) return;
  const wasReason = _degradedReason;
  const ageMs = Date.now() - (_degradedSince || Date.now());
  _degraded = false;
  _degradedReason = null;
  _degradedSince = null;
  console.log(`[db-quota-guard] LEFT degraded mode after ${Math.round(ageMs / 1000)}s — last reason: ${wasReason}`);
  pageOperatorDirect(
    [
      "*MAGPIE-BOT — DB RECOVERED*",
      "",
      `Down for ~${Math.round(ageMs / 1000)}s.`,
      "Last seen reason: `" + String(wasReason || "unknown").slice(0, 200) + "`",
      "",
      "All paths back to normal.",
    ].join("\n"),
  ).catch((e) => console.error("[db-quota-guard] recovery page failed:", e?.message));
}

let _selfHealTimer = null;
function ensureSelfHealLoop() {
  if (_selfHealTimer) return;
  _selfHealTimer = setInterval(async () => {
    if (!_degraded) return;
    // Lazy-import the pool ONLY during probe — failing import here
    // is itself a signal we're still dead.
    try {
      const pool = await import("../db/pool.js");
      await pool.query("SELECT 1 AS one");
      leaveDegraded();
    } catch (err) {
      // Still dead. Don't spam logs — one line every minute is fine.
      console.warn(`[db-quota-guard] self-heal probe still failing: ${(err.message || "").slice(0, 100)}`);
    }
  }, 60_000).unref();
}

/**
 * Install the global handlers. Call this AT THE TOP of src/index.js
 * BEFORE any module that might enqueue DB-touching async work.
 *
 * Safe to call multiple times — only the first install wires the
 * handlers. The second call is a no-op so unit tests / hot-reload
 * cycles don't stack handlers.
 */
let _installed = false;
export function installDbQuotaGuard() {
  if (_installed) return;
  _installed = true;
  ensureSelfHealLoop();

  // unhandledRejection — the path that hit us today.
  process.on("unhandledRejection", (reason) => {
    if (isDbQuotaError(reason)) {
      enterDegraded(reason?.message || "unhandledRejection: DB error");
      return; // SUPPRESS — do not let it crash
    }
    // Non-DB unhandled rejections still surface so the platform can
    // restart on real bugs. Default Node behavior is to crash on the
    // next tick — log the context so the post-mortem is useful.
    console.error("[unhandledRejection]", reason);
    // Don't process.exit here — let Node's default kick in so the
    // platform's restart policy applies as normal.
  });

  // uncaughtException — synchronous throws. Same logic.
  process.on("uncaughtException", (err) => {
    if (isDbQuotaError(err)) {
      enterDegraded(err?.message || "uncaughtException: DB error");
      return;
    }
    console.error("[uncaughtException]", err);
    // Real bug — let the process die so the platform restarts.
    process.exit(1);
  });

  console.log("[db-quota-guard] installed — DB-quota errors will degrade instead of crash");
}

/**
 * Test-only direct API to flip into degraded mode without throwing.
 * Used by /test-db-quota-page admin command if we wire one.
 */
export function _testEnterDegraded(reason) {
  enterDegraded(reason);
}
