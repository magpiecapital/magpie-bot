/**
 * Farm guard — approval-time defenses against serial-launch farms and
 * coordinated scam listings (UOTF/SAOF/USWR/TNOS incident 2026-08-15:
 * up to five near-identical tokens per ticker auto-approved within days,
 * each with six-figure "liquidity").
 *
 * Split like auto-extend-core: classifyFarmSignals() is a pure function
 * over a gathered context (unit-testable, no I/O); assessFarmRisk()
 * gathers the context from the DB + rugcheck and classifies.
 *
 * Signal policy:
 *   HARD  → never auto-approve (reject with the reason). These are
 *           adversarial signatures with near-zero legit base rate:
 *           name clones, image reuse, creator launch-clusters.
 *   SOFT  → demote to manual review instead of auto-approving. These are
 *           anomalies with a real legit base rate: approval waves,
 *           wash-trade-shaped volume.
 *
 * Every gather step fails SKIP (signal not evaluated, logged) — an
 * outage of rugcheck or one query can never block legitimate listings
 * outright, matching the screener's existing degradation posture.
 */
import { query } from "../db/pool.js";

const AUTO_APPROVALS_24H_CAP = Number(process.env.FARM_GUARD_AUTO_APPROVALS_24H_CAP) || 10;
const WASH_VOL_LIQ_RATIO = Number(process.env.FARM_GUARD_WASH_VOL_LIQ_RATIO) || 25;
const CREATOR_CLUSTER_MIN = Number(process.env.FARM_GUARD_CREATOR_CLUSTER_MIN) || 2;

/** Lowercased alphanumeric skeleton — "United  Oil Trust-Fund!" → "unitedoiltrustfund". */
export function normalizeName(name) {
  if (typeof name !== "string") return "";
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pure classifier. ctx fields default to "not evaluated" (null) so a
 * failed gather step contributes nothing rather than a false signal.
 */
export function classifyFarmSignals(ctx) {
  const hard = [];
  const soft = [];

  if (Number.isFinite(ctx?.nameCloneCount) && ctx.nameCloneCount > 0) {
    hard.push(`name clone — ${ctx.nameCloneCount} other listing(s) share the normalized name "${ctx.normalizedName}"`);
  }
  if (Number.isFinite(ctx?.imageReuseCount) && ctx.imageReuseCount > 0) {
    hard.push(`image reuse — logo URL already used by ${ctx.imageReuseCount} other listing(s)`);
  }
  if (Number.isFinite(ctx?.creatorScreens7d) && ctx.creatorScreens7d >= CREATOR_CLUSTER_MIN) {
    hard.push(`creator cluster — deployer launched ${ctx.creatorScreens7d} other screened token(s) in 7d`);
  }

  if (Number.isFinite(ctx?.autoApprovals24h) && ctx.autoApprovals24h >= AUTO_APPROVALS_24H_CAP) {
    soft.push(`approval wave — ${ctx.autoApprovals24h} auto-approvals in 24h (cap ${AUTO_APPROVALS_24H_CAP}); manual review while the wave clears`);
  }
  if (
    Number.isFinite(ctx?.volume24h) && Number.isFinite(ctx?.liquidity) &&
    ctx.liquidity > 0 && ctx.volume24h > WASH_VOL_LIQ_RATIO * ctx.liquidity
  ) {
    soft.push(`wash-trade shape — 24h volume $${Math.floor(ctx.volume24h)} is >${WASH_VOL_LIQ_RATIO}x liquidity $${Math.floor(ctx.liquidity)}`);
  }

  return { hard, soft };
}

// ── Context gathering ───────────────────────────────────────────────────────

let _creatorTableReady = false;
async function ensureCreatorLog() {
  if (_creatorTableReady) return;
  // Inline DDL follows the submitter_rejections precedent (ops-side
  // tracking table, not protocol state — kept out of the migration ledger).
  await query(
    `CREATE TABLE IF NOT EXISTS screener_creator_log (
       mint TEXT PRIMARY KEY,
       creator TEXT NOT NULL,
       seen_at TIMESTAMPTZ DEFAULT NOW()
     )`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_creator_log_creator ON screener_creator_log (creator, seen_at)`,
  );
  _creatorTableReady = true;
}

const _creatorCache = new Map(); // mint → { creator|null, at }
const CREATOR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Deployer wallet from rugcheck's full report; null = unknown (skip signal). */
async function fetchCreator(mint) {
  const hit = _creatorCache.get(mint);
  if (hit && Date.now() - hit.at < CREATOR_CACHE_TTL_MS) return hit.creator;
  let creator = null;
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.creator === "string" && data.creator.length >= 32) creator = data.creator;
    }
  } catch { /* unreachable → signal skipped */ }
  _creatorCache.set(mint, { creator, at: Date.now() });
  return creator;
}

/**
 * Gather + classify for one candidate. Never throws; every failed step
 * leaves its signal unevaluated.
 */
export async function assessFarmRisk({ mint, name, imageUrl, liquidity, volume24h }) {
  const ctx = {
    normalizedName: normalizeName(name),
    liquidity: Number(liquidity),
    volume24h: Number(volume24h),
  };

  // Name clones: any enabled row, any row we disabled for colliding, or
  // any screening-queue row from the last 14 days sharing the skeleton.
  if (ctx.normalizedName.length >= 4) {
    try {
      const { rows } = await query(
        `SELECT (
           SELECT COUNT(*) FROM supported_mints
            WHERE mint <> $1
              AND (enabled = TRUE OR source = 'disabled_symbol_collision')
              AND LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g')) = $2
         ) + (
           SELECT COUNT(*) FROM token_screen_queue
            WHERE mint <> $1 AND created_at > NOW() - INTERVAL '14 days'
              AND LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g')) = $2
         ) AS n`,
        [mint, ctx.normalizedName],
      );
      ctx.nameCloneCount = Number(rows[0]?.n);
    } catch (e) {
      console.warn(`[farm-guard] name-clone check failed for ${mint}: ${e.message?.slice(0, 80)}`);
    }
  } else {
    ctx.nameCloneCount = 0; // too-short skeletons ("pepe" ≠ evidence) never signal
  }

  if (typeof imageUrl === "string" && imageUrl.length > 12) {
    try {
      const { rows } = await query(
        `SELECT COUNT(*) AS n FROM supported_mints
          WHERE mint <> $1 AND image_url = $2
            AND (enabled = TRUE OR source = 'disabled_symbol_collision')`,
        [mint, imageUrl],
      );
      ctx.imageReuseCount = Number(rows[0]?.n);
    } catch (e) {
      console.warn(`[farm-guard] image-reuse check failed for ${mint}: ${e.message?.slice(0, 80)}`);
    }
  }

  try {
    await ensureCreatorLog();
    const creator = await fetchCreator(mint);
    if (creator) {
      await query(
        `INSERT INTO screener_creator_log (mint, creator) VALUES ($1, $2)
         ON CONFLICT (mint) DO NOTHING`,
        [mint, creator],
      );
      const { rows } = await query(
        `SELECT COUNT(*) AS n FROM screener_creator_log
          WHERE creator = $1 AND mint <> $2 AND seen_at > NOW() - INTERVAL '7 days'`,
        [creator, mint],
      );
      ctx.creatorScreens7d = Number(rows[0]?.n);
    }
  } catch (e) {
    console.warn(`[farm-guard] creator check failed for ${mint}: ${e.message?.slice(0, 80)}`);
  }

  try {
    const { rows } = await query(
      `SELECT COUNT(*) AS n FROM supported_mints
        WHERE auto_approved = TRUE AND source IN ('screener', 'review_auto')
          AND screened_at > NOW() - INTERVAL '24 hours'`,
    );
    ctx.autoApprovals24h = Number(rows[0]?.n);
  } catch (e) {
    console.warn(`[farm-guard] wave check failed: ${e.message?.slice(0, 80)}`);
  }

  return { ...classifyFarmSignals(ctx), ctx };
}
