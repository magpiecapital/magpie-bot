/**
 * Boot-time V4 PriceFeed sync — walks every enabled supported_mints
 * row at bot startup and ensures the V4 PriceFeed PDA is initialized.
 * Closes the structural gap where a never-borrowed-against mint had
 * no PriceFeed PDA → user trying it during a brief attestor lag hit
 * AccountNotInitialized.
 *
 * Per V4 loan lifecycle zero-errors mandate NN1 (operator-mandated
 * 2026-06-19 PM after user 948 incident). Eliminates the
 * `v4_price_feed_uninitialized_or_empty` class entirely.
 *
 * Strategy:
 *   1. Wait 90s after boot so attestor's first tick finishes (any
 *      mints already in the queue self-heal via the existing attest-
 *      fail → auto-init path).
 *   2. Query enabled supported_mints (categories memecoin + stock).
 *   3. For each, read its V4 PriceFeed PDA via withFailover. If the
 *      PDA doesn't exist OR has data.length < 120 (placeholder
 *      bytes), call initializePriceFeed.
 *   4. Throttle: max 6 inits in this sync, 2s spacing — keeps RPC
 *      friendly and avoids racing the attestor's MAX_INITS_PER_TICK.
 *   5. Log every init + CRIT-DM operator if init itself fails (real
 *      blocker — needs operator attention).
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { withFailover } from "../solana/connection.js";
import { getAdminId } from "./admin-notify.js";

const BOOT_DELAY_MS = Number(process.env.BOOT_V4_FEED_SYNC_DELAY_MS) || 90_000;
const MAX_INITS = Number(process.env.BOOT_V4_FEED_SYNC_MAX_INITS) || 6;
const SPACING_MS = Number(process.env.BOOT_V4_FEED_SYNC_SPACING_MS) || 2_000;

async function listSyncTargets() {
  const { rows } = await query(
    `SELECT mint, decimals, category, symbol
       FROM supported_mints
      WHERE enabled = true
        AND category IN ('memecoin', 'stock')
      ORDER BY mint`,
  );
  return rows;
}

async function checkAndInit(target, lenderPk, programId, bot) {
  const { initializePriceFeed } = await import("./price-attestor.js");
  const { lendingPoolPda, priceFeedPda } = await import("../solana/pdas.js");

  const mintPk = new PublicKey(target.mint);
  const [pool] = lendingPoolPda(lenderPk, programId);
  const [pf] = priceFeedPda(mintPk, pool, programId);

  let info;
  try {
    info = await withFailover((conn) => conn.getAccountInfo(pf, "confirmed"));
  } catch (e) {
    console.warn(`[boot-v4-sync] getAccountInfo failed for ${target.symbol || target.mint.slice(0, 8)}: ${e.message?.slice(0, 80)}`);
    return { mint: target.mint, action: "skip_rpc_fail" };
  }

  if (info && info.data.length >= 120) {
    return { mint: target.mint, action: "already_init" };
  }

  // Needs init.
  console.log(`[boot-v4-sync] initializing V4 feed for ${target.symbol || target.mint.slice(0, 8)} (${target.category})`);
  try {
    const result = await initializePriceFeed(target.mint, programId);
    if (result?.alreadyExists) {
      return { mint: target.mint, action: "already_init_race" };
    }
    return { mint: target.mint, action: "initialized" };
  } catch (e) {
    const msg = e.message?.slice(0, 200) || String(e);
    console.error(`[boot-v4-sync] init FAILED for ${target.symbol || target.mint.slice(0, 8)}: ${msg}`);
    const adminId = getAdminId();
    if (bot && adminId) {
      try {
        await bot.api.sendMessage(adminId, [
          `⚠️ Boot-time V4 feed init failed`,
          ``,
          `Mint: \`${target.mint}\``,
          `Symbol: ${target.symbol || "?"}`,
          `Error: \`${msg.slice(0, 120)}\``,
          ``,
          `_Users borrowing this mint will hit AccountNotInitialized until manually init'd._`,
        ].join("\n"), { parse_mode: "Markdown" });
      } catch { /* swallow DM err */ }
    }
    return { mint: target.mint, action: "init_failed", error: msg };
  }
}

async function runSync(bot) {
  const { PROGRAM_ID_V4 } = await import("../solana/program.js");
  if (!PROGRAM_ID_V4) {
    console.log("[boot-v4-sync] PROGRAM_ID_V4 unset — skipping");
    return;
  }
  if (!process.env.LENDER_PUBKEY) {
    console.log("[boot-v4-sync] LENDER_PUBKEY unset — skipping");
    return;
  }
  const lenderPk = new PublicKey(process.env.LENDER_PUBKEY);

  const targets = await listSyncTargets();
  console.log(`[boot-v4-sync] starting — ${targets.length} enabled mints to check`);

  const results = { already_init: 0, initialized: 0, init_failed: 0, skip_rpc_fail: 0, already_init_race: 0 };
  let inits = 0;
  for (const target of targets) {
    const r = await checkAndInit(target, lenderPk, PROGRAM_ID_V4, bot);
    results[r.action] = (results[r.action] || 0) + 1;
    if (r.action === "initialized") {
      inits++;
      if (inits >= MAX_INITS) {
        console.log(`[boot-v4-sync] reached MAX_INITS=${MAX_INITS}; remaining mints will be inited by attestor on demand`);
        break;
      }
      // Space inits so we don't hammer RPC.
      await new Promise((res) => setTimeout(res, SPACING_MS));
    }
  }

  console.log(`[boot-v4-sync] done — ${JSON.stringify(results)}`);

  // If any init failed, DM was already sent per-mint. Summary CRIT
  // if multiple failed.
  if (results.init_failed >= 2) {
    const adminId = getAdminId();
    if (bot && adminId) {
      try {
        await bot.api.sendMessage(adminId, `🚨 Boot V4 feed sync: ${results.init_failed} init failures. Investigate ASAP — affected mints will surface AccountNotInitialized to borrowers.`);
      } catch { /* swallow */ }
    }
  }
}

export function startBootV4FeedSync(bot) {
  if (process.env.BOOT_V4_FEED_SYNC_DISABLED === "true") {
    console.log("[boot-v4-sync] disabled via env");
    return;
  }
  console.log(`[boot-v4-sync] armed — will run in ${Math.round(BOOT_DELAY_MS / 1000)}s`);
  setTimeout(() => {
    runSync(bot).catch((e) => console.error("[boot-v4-sync] runSync threw:", e.message));
  }, BOOT_DELAY_MS);
}
