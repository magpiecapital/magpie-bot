/**
 * Governance nominations — user-driven proposal pipeline.
 *
 *   anyone           →  /nominate <text>       (submits)
 *   anyone           →  /nominations           (browse pending, sorted by upvotes)
 *   anyone           →  /upvote_nomination N   (one-per-user, idempotent)
 *   nominator        →  /withdraw_nomination N (only the original submitter)
 *   operator         →  /nomination_review N action [reason]
 *                                  (action: queue | promote | reject | duplicate)
 *
 * Promoted nominations get assigned an MGP-XXX id and a registry entry
 * draft is prepared for operator review. The operator opens the actual
 * voting via the same activation flow as MGP-002.
 *
 * Rate limit: 3 nominations per user per UTC day. Stops spam without
 * blocking thoughtful contributors.
 *
 * Min text length: 20 chars (set as a CHECK constraint on the table).
 * Prevents one-word "do X" submissions that aren't actionable.
 */

import { query } from "../db/pool.js";

const MAX_NOMINATIONS_PER_DAY = 3;

/**
 * Check + bump the per-user rate limit. Returns { allowed, remaining }.
 * Idempotent — safe to call inside a transaction that may roll back.
 */
async function checkAndBumpRate(nominatorTgId) {
  // Insert or fetch the row
  await query(
    `INSERT INTO governance_nomination_rate (nominator_tg_id)
     VALUES ($1)
     ON CONFLICT (nominator_tg_id) DO NOTHING`,
    [nominatorTgId],
  );
  // Reset if day_bucket is stale
  await query(
    `UPDATE governance_nomination_rate
        SET nominations_today = 0,
            day_bucket = (now() AT TIME ZONE 'UTC')::date,
            updated_at = NOW()
      WHERE nominator_tg_id = $1
        AND day_bucket < (now() AT TIME ZONE 'UTC')::date`,
    [nominatorTgId],
  );
  // Check current count
  const { rows } = await query(
    `SELECT nominations_today FROM governance_nomination_rate WHERE nominator_tg_id = $1`,
    [nominatorTgId],
  );
  const today = rows[0]?.nominations_today ?? 0;
  if (today >= MAX_NOMINATIONS_PER_DAY) {
    return { allowed: false, remaining: 0 };
  }
  // Increment
  await query(
    `UPDATE governance_nomination_rate
        SET nominations_today = nominations_today + 1, updated_at = NOW()
      WHERE nominator_tg_id = $1`,
    [nominatorTgId],
  );
  return { allowed: true, remaining: MAX_NOMINATIONS_PER_DAY - today - 1 };
}

/**
 * Create a new nomination. Returns the new id.
 *
 * Throws if rate limit hit, text too short/long, or DB constraint
 * violation (the CHECK on nomination_text length catches that too).
 */
export async function createNomination({ nominationText, nominatorTgId, nominatorUsername, nominatorWallet }) {
  const text = String(nominationText ?? "").trim();
  if (text.length < 20) {
    throw new Error("nomination_too_short — minimum 20 characters so the operator can act on it");
  }
  if (text.length > 1000) {
    throw new Error("nomination_too_long — keep it under 1000 characters");
  }
  const rate = await checkAndBumpRate(String(nominatorTgId));
  if (!rate.allowed) {
    throw new Error(`rate_limit — you've already submitted ${MAX_NOMINATIONS_PER_DAY} nominations today. Try again tomorrow.`);
  }
  const { rows } = await query(
    `INSERT INTO governance_nominations
       (nomination_text, nominator_tg_id, nominator_username, nominator_wallet)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [text, String(nominatorTgId), nominatorUsername || null, nominatorWallet || null],
  );
  return rows[0].id;
}

/**
 * List pending/queued nominations sorted by upvote count (desc), then
 * by created_at (newer first within same count).
 *
 * Returns up to `limit` rows.
 */
export async function listNominations({ status = ["pending", "queued"], limit = 10 } = {}) {
  const { rows } = await query(
    `SELECT id, nomination_text, nominator_username, status, upvote_count,
            created_at, status_reason, promoted_to_proposal_id
       FROM governance_nominations
       WHERE status = ANY($1)
       ORDER BY upvote_count DESC, created_at DESC
       LIMIT $2`,
    [status, limit],
  );
  return rows;
}

/**
 * Get nomination detail by id.
 */
export async function getNomination(id) {
  const { rows } = await query(
    `SELECT * FROM governance_nominations WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Toggle an upvote. Insert if not present, delete if present.
 * Returns { now_upvoted: bool, count: number }.
 */
export async function toggleUpvote({ nominationId, upvoterTgId, upvoterWallet }) {
  const exists = await query(
    `SELECT 1 FROM governance_nomination_upvotes
       WHERE nomination_id = $1 AND upvoter_tg_id = $2`,
    [nominationId, String(upvoterTgId)],
  );
  if (exists.rows.length > 0) {
    await query(
      `DELETE FROM governance_nomination_upvotes
         WHERE nomination_id = $1 AND upvoter_tg_id = $2`,
      [nominationId, String(upvoterTgId)],
    );
    const after = await getNomination(nominationId);
    return { now_upvoted: false, count: after?.upvote_count ?? 0 };
  }
  await query(
    `INSERT INTO governance_nomination_upvotes
       (nomination_id, upvoter_tg_id, upvoter_wallet)
     VALUES ($1, $2, $3)`,
    [nominationId, String(upvoterTgId), upvoterWallet || null],
  );
  const after = await getNomination(nominationId);
  return { now_upvoted: true, count: after?.upvote_count ?? 0 };
}

/**
 * Withdraw — only the original nominator can call.
 */
export async function withdrawNomination({ nominationId, nominatorTgId }) {
  const r = await query(
    `UPDATE governance_nominations
        SET status = 'withdrawn', updated_at = NOW()
      WHERE id = $1
        AND nominator_tg_id = $2
        AND status = 'pending'
      RETURNING id`,
    [nominationId, String(nominatorTgId)],
  );
  if (r.rowCount === 0) {
    throw new Error("not_found_or_not_yours_or_already_acted_on");
  }
}

/**
 * Operator review — set the status. Valid actions:
 *   - queue     : status='queued'    (mark for future proposal)
 *   - promote   : status='promoted'  (operator opens actual MGP-XXX next)
 *   - reject    : status='rejected'  (closes; reason captured)
 *   - duplicate : status='duplicate' (links to duplicate_of_id)
 */
export async function reviewNomination({
  nominationId,
  operatorTgId,
  action,
  reason,
  promotedToProposalId,
  duplicateOfId,
}) {
  const valid = ["queue", "promote", "reject", "duplicate"];
  if (!valid.includes(action)) {
    throw new Error(`invalid_action — must be one of ${valid.join(", ")}`);
  }
  const statusByAction = {
    queue: "queued",
    promote: "promoted",
    reject: "rejected",
    duplicate: "duplicate",
  };
  const newStatus = statusByAction[action];
  const r = await query(
    `UPDATE governance_nominations
        SET status = $1,
            status_reason = $2,
            promoted_to_proposal_id = $3,
            duplicate_of_id = $4,
            reviewed_by = $5,
            reviewed_at = NOW(),
            updated_at = NOW()
      WHERE id = $6
        AND status IN ('pending', 'queued')
      RETURNING id`,
    [
      newStatus,
      reason || null,
      action === "promote" ? promotedToProposalId : null,
      action === "duplicate" ? duplicateOfId : null,
      String(operatorTgId),
      nominationId,
    ],
  );
  if (r.rowCount === 0) {
    throw new Error("not_found_or_already_acted_on");
  }
}
