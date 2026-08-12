/**
 * Web-push delivery — the warning channel for borrowers with no Telegram.
 *
 * WHY THIS EXISTS. Expiry warnings went out by Telegram DM and nothing else.
 * Site-native borrowers have a synthetic negative telegram_id with no real
 * account behind it, so every DM fails `chat not found`. Over 90 days, 68 of 71
 * Telegram borrowers who reached the 24h window were warned; 1 of 72 site-only
 * borrowers were. All nine borrowers liquidated with no warning were site-only.
 *
 * DESIGN RULES, in priority order:
 *
 *  1. NEVER break the existing path. Push is strictly additive. Every function
 *     here fails soft — if VAPID is unconfigured, if the library throws, if the
 *     push service is down, the Telegram warning and the operator backstop
 *     behave exactly as before. A borrower must never lose the warning they
 *     would have got because the new channel misbehaved.
 *
 *  2. DISTINGUISH DEAD FROM UNLUCKY. 404/410 from a push service means the
 *     subscription is permanently gone (browser uninstalled, permission
 *     revoked). Those are revoked at once so we stop trying. Anything else —
 *     429, 5xx, a timeout — is transient and must NOT revoke, or one bad
 *     afternoon at Google silently unsubscribes every Chrome user we have.
 *     This is the same asymmetry as telegram-delivery.js and it matters for
 *     the same reason: wrongly giving up is invisible and costs someone their
 *     collateral.
 *
 *  3. NO PII. A subscription is an endpoint URL plus public key material. There
 *     is no name, email or phone anywhere in this path, which is precisely why
 *     this channel was chosen.
 */
import webpush from "web-push";
import { query } from "../db/pool.js";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "https://magpie.capital";

let configured = false;
try {
  if (PUBLIC_KEY && PRIVATE_KEY) {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  } else {
    console.warn("[push] VAPID keys not set — web push disabled (Telegram path unaffected)");
  }
} catch (e) {
  // A malformed key must not take the bot down at import time.
  console.error("[push] VAPID setup failed, web push disabled:", e.message);
}

/** Is web push usable at all right now? */
export function isPushConfigured() {
  return configured;
}

/**
 * Does a push-service failure mean this subscription is permanently gone?
 *
 * Conservative on purpose — see rule 2. Only the two status codes the Web Push
 * spec defines as "subscription no longer valid" count. Everything else keeps
 * the subscription alive so a transient outage cannot mass-unsubscribe users.
 *
 * Exported for the guard script.
 */
export function isSubscriptionGone(err) {
  try {
    const code = err?.statusCode ?? err?.status;
    return code === 404 || code === 410;
  } catch {
    return false;
  }
}

/**
 * Send one notification to every live subscription a user has.
 *
 * @returns {Promise<{sent: number, gone: number, failed: number, attempted: number}>}
 *   `sent > 0` means at least one browser accepted it. Never throws.
 */
export async function sendPushToUser(userId, { title, body, url }) {
  const result = { sent: 0, gone: 0, failed: 0, attempted: 0 };
  if (!configured || !userId) return result;

  let subs;
  try {
    const { rows } = await query(
      `SELECT id, endpoint, p256dh, auth
         FROM push_subscriptions
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    subs = rows;
  } catch (e) {
    console.error("[push] subscription lookup failed:", e.message);
    return result;
  }

  result.attempted = subs.length;
  if (!subs.length) return result;

  const payload = JSON.stringify({
    title,
    body,
    url: url || "https://www.magpie.capital/dashboard",
  });

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 6 * 3600 }, // a stale expiry warning helps nobody
      );
      result.sent++;
      await query(
        `UPDATE push_subscriptions
            SET last_success_at = NOW(), failure_count = 0
          WHERE id = $1`,
        [s.id],
      ).catch(() => {});
    } catch (err) {
      if (isSubscriptionGone(err)) {
        result.gone++;
        await query(
          `UPDATE push_subscriptions
              SET revoked_at = NOW(), revoked_reason = $2
            WHERE id = $1`,
          [s.id, `push service returned ${err?.statusCode ?? "404/410"}`],
        ).catch(() => {});
      } else {
        result.failed++;
        // Count it, but never revoke on a transient fault (rule 2).
        await query(
          `UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1`,
          [s.id],
        ).catch(() => {});
        console.warn(
          `[push] transient send failure for sub ${s.id}: ${err?.statusCode ?? "?"} ${String(err?.message || "").slice(0, 80)}`,
        );
      }
    }
  }

  return result;
}

/** Does this user have any live subscription? Cheap check for the watcher. */
export async function hasLivePushSubscription(userId) {
  if (!configured || !userId) return false;
  try {
    const { rows } = await query(
      `SELECT 1 FROM push_subscriptions
        WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
