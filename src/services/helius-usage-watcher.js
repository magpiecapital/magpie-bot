/**
 * Helius credit-usage watcher — DMs the admin when monthly RPC credit
 * usage crosses 50%, 75%, or 90% so you can react before the cap is hit
 * and the bot starts failing requests.
 *
 * Helius exposes usage via:
 *   GET https://api.helius.xyz/v0/usage?api-key=<key>
 *
 * Polled hourly. State lives in memory — restarts re-alert if you re-cross
 * a threshold, which is fine and arguably desirable.
 */
import "dotenv/config";
import { getAdminId, notifyAdmin } from "./admin-notify.js";

const ADMIN_TG_ID = getAdminId();
const POLL_MS = Number(process.env.HELIUS_USAGE_POLL_MS) || 60 * 60 * 1000; // 1h
const THRESHOLDS = [0.5, 0.75, 0.9, 0.95];

const alertedAt = new Set(); // thresholds we've already alerted at this run

function extractKey(url) {
  if (!url) return null;
  const m = url.match(/[?&]api-key=([a-f0-9-]+)/i);
  return m?.[1] || null;
}

async function fetchUsage(apiKey) {
  const res = await fetch(`https://api.helius.xyz/v0/usage?api-key=${apiKey}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Helius usage ${res.status}`);
  return res.json();
}

export function startHeliusUsageWatcher(bot) {
  const apiKey = process.env.HELIUS_API_KEY || extractKey(process.env.SOLANA_RPC_URL);
  if (!apiKey) {
    console.warn("[helius-usage] No Helius API key found — usage alerts disabled");
    return null;
  }
  if (!ADMIN_TG_ID) {
    console.warn("[helius-usage] No admin ID resolvable — usage alerts disabled");
    return null;
  }

  console.log(`📊 Helius usage watcher running (every ${POLL_MS / 60000} min)`);

  const tick = async () => {
    try {
      const usage = await fetchUsage(apiKey);
      // Helius response shape varies; handle both legacy and newer keys.
      const used = usage?.credits_used ?? usage?.creditsUsed ?? usage?.usage?.credits ?? 0;
      const limit = usage?.credit_limit ?? usage?.creditLimit ?? usage?.plan?.credit_limit ?? 1_000_000;
      if (!limit) return;
      const pct = used / limit;

      for (const t of THRESHOLDS) {
        if (pct >= t && !alertedAt.has(t)) {
          alertedAt.add(t);
          const msg = [
            `⚠️ *Helius credits at ${Math.round(pct * 100)}%*`,
            "",
            `Used: ${used.toLocaleString()} / ${limit.toLocaleString()} credits`,
            `Threshold crossed: ${Math.round(t * 100)}%`,
            "",
            t >= 0.9
              ? "🚨 Approaching cap. RPC failover to public mainnet will kick in if exhausted, but degraded performance is likely."
              : "Monitor usage. Optimize or upgrade plan before hitting the cap.",
          ].join("\n");
          await notifyAdmin(bot, msg, { parse_mode: "Markdown" });
        }
      }
    } catch (err) {
      console.error(`[helius-usage] tick error: ${err.message}`);
    }
  };

  tick();
  return setInterval(tick, POLL_MS);
}
