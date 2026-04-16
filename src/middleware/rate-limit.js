/**
 * Per-user token-bucket rate limiter.
 *
 * Protects on-chain / DB operations from spam. Non-command messages pass
 * through unchanged (so multi-step flows still work).
 */
const buckets = new Map();

const DEFAULT = { capacity: 10, refillPerSec: 0.5 }; // 10 burst, 1 every 2s sustained

function take(userId) {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b) {
    b = { tokens: DEFAULT.capacity, last: now };
    buckets.set(userId, b);
  } else {
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(DEFAULT.capacity, b.tokens + elapsed * DEFAULT.refillPerSec);
    b.last = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function rateLimit() {
  return async (ctx, next) => {
    const uid = ctx.from?.id;
    // Only gate command-style updates; text/callback replies in flows are cheap.
    const isCommand = ctx.message?.text?.startsWith("/");
    if (!uid || !isCommand) return next();

    if (!take(uid)) {
      await ctx.reply("⏳ Slow down — too many commands. Wait a few seconds.");
      return;
    }
    return next();
  };
}
