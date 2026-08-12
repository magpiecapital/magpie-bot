/**
 * Collectible submission retention — applies the clock from the design repo's
 * data-retention policy (doc 05).
 *
 * Holding submission data forever is not "keeping the asset", it is
 * accumulating liability with a decreasing half-life of usefulness. The value
 * lives in the demand signal, which survives aggregation; the identifying
 * detail is what creates the risk, and it decays fast.
 *
 * ORDER MATTERS. The rollup is written BEFORE anything is reduced. The demand
 * history is a real table (migration 098) precisely because it must outlive the
 * rows it was computed from — reducing first would destroy the signal retention
 * exists to protect, and the declines are the more valuable half of it.
 *
 * Every step is idempotent, so a crashed or double-run tick is harmless.
 */
import { query } from "../db/pool.js";

/** Doc 05. Changing a number here means changing it there in the same PR. */
export const RETENTION = {
  contactMonths: 12, // user-supplied handle/email — to reply, not to market to
  provenanceDays: 90, // ip/ua hashes — abuse correlation is short-horizon
  declineMonths: 24, // declined rows reduce to their aggregate row
};

/**
 * Roll every day present in the base table into the persisted aggregate.
 * Recomputes rather than incrementing, so it is safe to run any number of
 * times and self-heals if a tick was missed.
 */
async function rollUpDemand() {
  const { rowCount } = await query(
    `INSERT INTO collectible_submission_daily
       (day, verdict, tier, platform, submissions, wallets)
     SELECT date_trunc('day', created_at)::date,
            verdict,
            COALESCE(NULLIF(tier, ''), '-'),
            COALESCE(NULLIF(platform, ''), 'not vaulted'),
            COUNT(*),
            COUNT(DISTINCT wallet) FILTER (WHERE wallet IS NOT NULL AND wallet <> '')
       FROM collectible_submissions
      GROUP BY 1, 2, 3, 4
     ON CONFLICT (day, verdict, tier, platform) DO UPDATE
       SET submissions = EXCLUDED.submissions,
           wallets     = EXCLUDED.wallets,
           updated_at  = NOW()`,
  );
  return rowCount ?? 0;
}

/** The only free-text PII we hold. It exists to answer a submission. */
async function redactStaleContacts() {
  const { rowCount } = await query(
    `UPDATE collectible_submissions
        SET contact = NULL, updated_at = NOW()
      WHERE contact IS NOT NULL
        AND GREATEST(created_at, COALESCE(reviewed_at, created_at))
            < NOW() - INTERVAL '${RETENTION.contactMonths} months'`,
  );
  return rowCount ?? 0;
}

async function dropStaleProvenance() {
  const { rowCount } = await query(
    `UPDATE collectible_submissions
        SET ip_hash = NULL, ua_hash = NULL, updated_at = NOW()
      WHERE (ip_hash IS NOT NULL OR ua_hash IS NOT NULL)
        AND created_at < NOW() - INTERVAL '${RETENTION.provenanceDays} days'`,
  );
  return rowCount ?? 0;
}

/**
 * Reduce old declines to the aggregate row that already represents them.
 *
 * Guarded on the rollup actually containing that day — if the aggregate write
 * failed, we must not delete the rows it was supposed to preserve. Deletion is
 * destructive by design: a row that survives in an export is not deleted, so
 * any export pipeline has to apply this same clock.
 */
async function reduceOldDeclines() {
  const { rowCount } = await query(
    `DELETE FROM collectible_submissions s
      WHERE s.verdict = 'DECLINED'
        AND s.created_at < NOW() - INTERVAL '${RETENTION.declineMonths} months'
        AND EXISTS (
          SELECT 1 FROM collectible_submission_daily d
           WHERE d.day = date_trunc('day', s.created_at)::date
             AND d.verdict = s.verdict
        )`,
  );
  return rowCount ?? 0;
}

export async function runCollectibleRetention() {
  // Rollup first, always. See the note at the top of this file.
  const rolled = await rollUpDemand();
  const contacts = await redactStaleContacts();
  const provenance = await dropStaleProvenance();
  const declines = await reduceOldDeclines();

  if (contacts || provenance || declines) {
    console.log(
      `[collectible-retention] rollup=${rolled} contacts_redacted=${contacts} ` +
        `provenance_cleared=${provenance} declines_reduced=${declines}`,
    );
  }
  return { rolled, contacts, provenance, declines };
}

/**
 * Daily tick. Deliberately not more often: this is a slow clock, and a tighter
 * loop would add write pressure for no benefit.
 */
export function startCollectibleRetention(intervalMs = 24 * 60 * 60 * 1000) {
  const tick = () =>
    runCollectibleRetention().catch((e) =>
      console.warn("[collectible-retention] tick failed:", e.message?.slice(0, 160)),
    );
  tick();
  return setInterval(tick, intervalMs);
}
