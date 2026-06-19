/**
 * Sentry stub — env-gated, no-op when SENTRY_DSN is unset.
 *
 * To enable in production:
 *   1. Sign up at sentry.io ($26/mo Team plan)
 *   2. Create a Node.js project
 *   3. Set SENTRY_DSN env on Railway
 *   4. Optionally set SENTRY_ENVIRONMENT=production, SENTRY_RELEASE=$COMMIT_SHA
 *
 * No restart needed beyond the env var change; next deploy picks it up.
 *
 * Operator-mandated 2026-06-19 PM (Tier B observability decision):
 * Sentry kept ($26/mo), Better Stack skipped (canary covers), Triton
 * deferred 7 days pending canary data on actual RPC fail rate.
 */
import * as SentryReal from "@sentry/node";

let _initialized = false;
let _dsn = null;

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[sentry] disabled — SENTRY_DSN unset (stub mode)");
    return;
  }
  if (_initialized) return;
  try {
    SentryReal.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production",
      release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
      // Performance tracing is on but at low sample rate — we don't
      // need transaction-level data for every fire.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.05,
      // Honor user privacy — strip wallet pubkeys from breadcrumb URLs
      // and exception messages. We have them in our own conversion_events
      // table; Sentry doesn't need a copy.
      beforeSend(event) {
        if (event.request?.url) {
          event.request.url = event.request.url.replace(/wallet=[A-Za-z0-9]+/g, "wallet=REDACTED");
        }
        return event;
      },
    });
    _initialized = true;
    _dsn = dsn;
    console.log(`[sentry] initialized — environment=${process.env.SENTRY_ENVIRONMENT || "production"}`);
  } catch (e) {
    console.warn(`[sentry] init failed: ${e.message?.slice(0, 120)}`);
  }
}

/**
 * Capture an exception. No-op if Sentry isn't initialized. Safe to call
 * from anywhere — never throws.
 */
export function captureException(err, ctx = {}) {
  if (!_initialized) return;
  try {
    SentryReal.captureException(err, { extra: ctx });
  } catch { /* swallow */ }
}

/**
 * Capture a structured message (vs an exception). Useful for noteworthy
 * non-error events.
 */
export function captureMessage(msg, ctx = {}) {
  if (!_initialized) return;
  try {
    SentryReal.captureMessage(msg, { extra: ctx, level: ctx.level || "info" });
  } catch { /* swallow */ }
}

/**
 * Tag the current scope with key/value pairs for filtering in the
 * Sentry UI. No-op when not initialized.
 */
export function setTag(key, value) {
  if (!_initialized) return;
  try { SentryReal.setTag(key, value); } catch { /* swallow */ }
}

export function isInitialized() {
  return _initialized;
}
