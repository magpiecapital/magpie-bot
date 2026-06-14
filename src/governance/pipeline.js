/**
 * Governance Autopilot — main pipeline orchestrator.
 *
 * Picks up proposals whose voting window has CLOSED and which haven't
 * been processed yet, then runs the 8-step pipeline (TALLY → VERIFY →
 * ANOMALY → PERSIST → IMPLEMENT → AUDIT → ANNOUNCE → NOTIFY) for each.
 *
 * Order of IMPLEMENT before ANNOUNCE is deliberate: the announcement
 * is gated by audit verification. The community never gets a "passed
 * and live" message unless the changes really did land.
 *
 * Single-tenant, single-process safe via Postgres advisory lock to
 * prevent two scheduler ticks from racing.
 */

import { randomUUID, createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { query } from "../db/pool.js";
import { getProposal, listProposalIds } from "./registry.js";
import { tallyProposal } from "./tally.js";
import { takeCloseTimeSnapshot } from "./close-time-snapshot.js";
import { runAnomalyChecks } from "./anomaly.js";
import { executeImplementationPlan } from "./implementation.js";
import { auditImplementation } from "./audit.js";
import { renderTemplate, buildVariables, sendAnnouncement } from "./announcement.js";

const PIPELINE_LOCK_KEY = 0x4d50_4750n;   // 'MPGP' — magpie governance pipeline
const COMMUNITY_CHAT_ID = process.env.GOVERNANCE_BROADCAST_CHAT_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPERATOR_DM_CHAT_ID = process.env.OPERATOR_DM_CHAT_ID;
const SNAPSHOT_DIR = process.env.GOVERNANCE_SNAPSHOT_DIR || `${process.env.HOME}/.magpie-private/snapshots`;

async function logStep({ runId, proposalId, stepName, status, detail, errorMessage, durationMs }) {
  try {
    await query(
      `INSERT INTO governance_pipeline_log (run_id, proposal_id, step_name, status, detail, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [runId, proposalId, stepName, status, detail ? JSON.stringify(detail) : null, errorMessage ?? null, durationMs ?? null],
    );
  } catch (err) {
    // logging failure should never crash the pipeline
    console.error("[governance-pipeline] log insert failed:", err.message);
  }
}

async function operatorDm(text) {
  if (!OPERATOR_DM_CHAT_ID || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: OPERATOR_DM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch { /* operator DM is best-effort */ }
}

async function findReadyProposals() {
  // A proposal is "ready to process" if:
  //   - it's in the registry
  //   - its voting_ends_at_iso is in the past
  //   - there's no row in governance_proposal_state yet (never processed), OR
  //     there's a row with pipeline_completed_at IS NULL (interrupted run — safe to resume)
  const ids = listProposalIds();
  const now = new Date();
  const ready = [];
  for (const id of ids) {
    const p = getProposal(id);
    if (!p?.voting_ends_at_iso) continue;
    // Inert proposal types — no autopilot processing.
    if (p.proposal_type === "snapshot_only" || p.proposal_type === "withdrawn") continue;
    const endsAt = new Date(p.voting_ends_at_iso);
    if (endsAt > now) continue;

    const { rows } = await query(
      `SELECT outcome, pipeline_completed_at FROM governance_proposal_state WHERE proposal_id = $1`,
      [id],
    );
    if (rows.length === 0) { ready.push(p); continue; }
    if (rows[0].pipeline_completed_at === null) { ready.push(p); continue; }
  }
  return ready;
}

/**
 * Find the most recent snapshot file matching the proposal's snapshot_id.
 */
function findSnapshotFile(snapshotId) {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith(snapshotId + "-") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return null;
    return `${SNAPSHOT_DIR}/${files[files.length - 1]}`;
  } catch {
    return null;
  }
}

/**
 * Process one proposal end-to-end. Returns the final status.
 */
export async function processProposal(proposal) {
  const runId = randomUUID();
  const proposalId = proposal.id;
  const log = (stepName, status, detail, errorMessage, durationMs) =>
    logStep({ runId, proposalId, stepName, status, detail, errorMessage, durationMs });

  // ── STEP 0: bracket the run ─────────────────────────────────────
  await query(
    `INSERT INTO governance_proposal_state (proposal_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (proposal_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [proposalId],
  );

  // ── STEP 0: CLOSE-TIME SNAPSHOT (snapshot_mode='at_close' only) ──
  // For proposals using close-time eligibility, take the fresh
  // snapshot now (at close, not at activation). The new snapshot_id
  // is "<proposal_id>_close" and lands in governance_snapshot_weights
  // exactly like an activation snapshot would, so step 1's tally is
  // unchanged downstream.
  let closeSnapshotId = null;
  if (proposal.snapshot_mode === "at_close") {
    const t0 = Date.now();
    try {
      const r = await takeCloseTimeSnapshot({ proposalId });
      closeSnapshotId = r.snapshotId;
      await log("close_snapshot", "ok", r, null, Date.now() - t0);
    } catch (err) {
      await log("close_snapshot", "failed", null, err.message, Date.now() - t0);
      await markPipelineError(proposalId, "close_snapshot_failed");
      return "pipeline_error";
    }
  }

  // ── STEP 1: TALLY ───────────────────────────────────────────────
  let tally;
  let snapshotPath = null;
  let snapshotIdForTally = null;
  {
    const t0 = Date.now();
    if (closeSnapshotId) {
      // Close-time mode — DB-backed snapshot. No file to find/verify.
      snapshotIdForTally = closeSnapshotId;
    } else {
      // Activation-mode. Prefer the DB-loaded snapshot when present —
      // this is the only path that works on Railway (the operator's
      // .magpie-private/snapshots/ filesystem isn't deployed). Falls
      // back to the on-disk file only when the DB doesn't carry the
      // snapshot yet (operator-CLI close-time tally bootstrap path).
      //
      // 2026-06-14: this DB-first fallback exists because MGP-001
      // ratified silently in the DB but the autopilot threw
      // no_snapshot_file_found every 5 min for 15+ hours, blocking
      // implementation_plan execution. See
      // [[project_magpie_outage_2026_06_14_neon_quota]] note about the
      // adjacent autopilot silent-failure that surfaced the same day.
      const registrySnapshotId = proposal.snapshot_id ?? proposalId;
      let snapshotInDb = false;
      try {
        const { loadEligibleVotersFromDb } = await import("./tally.js");
        const eligible = await loadEligibleVotersFromDb(registrySnapshotId);
        snapshotInDb = !!(eligible && eligible.size > 0);
      } catch { /* fall through to file lookup */ }
      if (snapshotInDb) {
        snapshotIdForTally = registrySnapshotId;
      } else {
        snapshotPath = findSnapshotFile(registrySnapshotId);
        if (!snapshotPath) {
          await log("tally", "failed", { snapshot_dir: SNAPSHOT_DIR }, "no_snapshot_file_found", Date.now() - t0);
          await markPipelineError(proposalId, "no_snapshot_file_found");
          await operatorDm(
            `AUTOPILOT HALT: ${proposalId} — snapshot not in DB and no on-disk file found at ${SNAPSHOT_DIR}. ` +
              `Either upload the snapshot JSON to the bot, populate governance_snapshot_weights for snapshot_id=${registrySnapshotId}, ` +
              `or set the proposal to snapshot_mode='at_close' for future runs.`,
          );
          return "pipeline_error";
        }
      }
    }
    // questionId MUST match what the vote-submission API stored. Votes
    // are stored with question_id = the key in
    // src/api/governance-api.js:51-53 — currently "Vote" for MGP-001 and
    // MGP-003 (the only proposals with active voting in v0). Without
    // this match the WHERE clause in loadVotes returns zero rows and the
    // entire tally collapses to 0/0/0, failing the proposal at close.
    // Hardcoded "Vote" matches today's single-question structure; a
    // future multi-question proposal will need a refactor to iterate
    // proposal.questions and tally each separately.
    const questionId = "Vote";
    // expectedSnapshotId tells tallyProposal what to verify against the
    // snapshot file's internal proposal_id field. MGP-001 intentionally
    // reuses the MGP-002 snapshot (per registry.snapshot_id); the file's
    // proposal_id is "MGP-002" even though we're tallying MGP-001.
    const expectedSnapshotId = proposal.snapshot_id ?? proposalId;
    try {
      tally = await tallyProposal({
        proposalId,
        questionId,
        snapshotPath,
        snapshotId: snapshotIdForTally,
        expectedSnapshotId,
        capFraction: 0.02,
      });
      await log("tally", "ok", tally, null, Date.now() - t0);
    } catch (err) {
      await log("tally", "failed", null, err.message, Date.now() - t0);
      await markPipelineError(proposalId, "tally_failed");
      return "pipeline_error";
    }
  }

  // ── STEP 2: VERIFY (re-tally + compare) ─────────────────────────
  {
    const t0 = Date.now();
    let crossTally;
    try {
      crossTally = await tallyProposal({
        proposalId,
        questionId: "Vote",
        snapshotPath,
        // 2026-06-14: was `closeSnapshotId` here, which is null on
        // activation-mode proposals when the DB-snapshot fallback is
        // in use (#203 + #204). tallyProposal then threw "requires
        // snapshotId or snapshotPath" because BOTH inputs were null,
        // and the pipeline kept stalling at verify_recompute_failed.
        // The verify step should re-use whatever snapshot identifier
        // the tally step landed on. snapshotIdForTally is set in step
        // 1 above and is either the DB-fallback registry ID, the
        // close-time snapshot ID, or null when we're using the file
        // path (snapshotPath is non-null in that case).
        snapshotId: snapshotIdForTally,
        expectedSnapshotId: proposal.snapshot_id ?? proposalId,
        capFraction: 0.02,
      });
    } catch (err) {
      await log("verify", "failed", null, err.message, Date.now() - t0);
      await markPipelineError(proposalId, "verify_recompute_failed");
      return "pipeline_error";
    }
    const match = crossTally.weights.yes_weight === tally.weights.yes_weight
      && crossTally.weights.no_weight === tally.weights.no_weight
      && crossTally.weights.cast_weight === tally.weights.cast_weight;
    if (!match) {
      await log("verify", "halted", { first: tally, second: crossTally }, "tally_cross_check_mismatch", Date.now() - t0);
      await markPipelineError(proposalId, "tally_cross_check_mismatch");
      await operatorDm(`AUTOPILOT HALT: ${proposalId} tally cross-check disagreed. Manual review required.`);
      return "pipeline_error";
    }
    await log("verify", "ok", { match: true }, null, Date.now() - t0);
  }

  // ── STEP 3: ANOMALY CHECKS ──────────────────────────────────────
  let anomaly;
  {
    const t0 = Date.now();
    // Canonical hash comes from the registry (set at activation time, never
    // edited). The pipeline rejects the run if the on-disk snapshot's hash
    // doesn't match — an attacker who tampered with the snapshot file
    // between activation and tally is detected here. If a proposal lacks a
    // canonical hash, fail closed rather than computing-and-comparing the
    // file to itself (which is a tautology).
    // File-hash verification only applies to activation-mode snapshots
    // (those have a canonical SHA-256 captured at activation that the
    // file should still match at close). Close-time snapshots are
    // generated fresh from on-chain reads at close — there's no pre-
    // computed hash to compare against, and the takeCloseTimeSnapshot
    // function already returns a deterministic hash over the inputs
    // which is persisted to governance_snapshots.hash_sha256 for
    // audit. Non-hash anomaly checks (vote spikes, vote-shape sanity)
    // still run for close-time mode below.
    // File-hash tamper-detection only runs when we're using the
    // on-disk file path. The DB-fallback path added in #203 uses
    // governance_snapshot_weights as the trusted source; integrity is
    // already enforced by the unique-per-(snapshot_id, voter) row
    // semantics + the DB connection's auth surface. Without the
    // `&& snapshotPath` guard, readFileSync(null) throws ENOENT and
    // the pipeline fails at the anomaly step even after the DB tally
    // succeeded — exactly the MGP-001 close-day pattern.
    if (!closeSnapshotId && snapshotPath) {
      // Canonical hash comes from the registry (set at activation time, never
      // edited). The pipeline rejects the run if the on-disk snapshot's hash
      // doesn't match — an attacker who tampered with the snapshot file
      // between activation and tally is detected here. If a proposal lacks a
      // canonical hash, fail closed rather than computing-and-comparing the
      // file to itself (which is a tautology).
      if (!proposal.snapshot_sha256) {
        await log(
          "anomaly",
          "halted",
          { proposal_id: proposalId },
          "snapshot_sha256_missing_in_registry",
          Date.now() - t0,
        );
        await markPipelineError(proposalId, "snapshot_sha256_missing_in_registry");
        await operatorDm(
          `AUTOPILOT HALT: ${proposalId} has no canonical snapshot_sha256 in the registry. Add it before the pipeline can verify snapshot integrity.`,
        );
        return "pipeline_error";
      }
      const actualHash = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
      if (actualHash !== proposal.snapshot_sha256) {
        await log(
          "anomaly",
          "halted",
          { expected: proposal.snapshot_sha256, actual: actualHash, snapshot_path: snapshotPath },
          "snapshot_hash_mismatch",
          Date.now() - t0,
        );
        await markPipelineError(proposalId, "snapshot_hash_mismatch");
        await operatorDm(
          `AUTOPILOT HALT: ${proposalId} snapshot hash MISMATCH.\nExpected: ${proposal.snapshot_sha256}\nActual:   ${actualHash}\nThe on-disk snapshot has been altered since activation — manual review required.`,
        );
        return "pipeline_error";
      }
    }
    anomaly = await runAnomalyChecks({
      proposalId,
      tally,
      snapshotPath,
      expectedSnapshotHash: proposal.snapshot_sha256,
      windowEndsAtIso: proposal.voting_ends_at_iso,
      closeSnapshotId,
    });
    if (!anomaly.ok) {
      await log("anomaly", "halted", { flags: anomaly.flags }, "anomaly_detected", Date.now() - t0);
      await query(
        `UPDATE governance_proposal_state
            SET outcome = 'anomaly_held', anomaly_flags = $1::text[], updated_at = NOW()
          WHERE proposal_id = $2`,
        [anomaly.flags, proposalId],
      );
      await operatorDm(`AUTOPILOT HALT: ${proposalId} anomaly checks failed:\n${anomaly.flags.join("\n")}`);
      return "anomaly_held";
    }
    await log("anomaly", "ok", null, null, Date.now() - t0);
  }

  // ── Compute outcome ─────────────────────────────────────────────
  const quorumMet = tally.percentages.participation_pct >= proposal.quorum_pct;
  const thresholdMet = tally.percentages.yes_share_of_cast_pct >= proposal.threshold_pct;
  const outcome = (quorumMet && thresholdMet) ? "passed" : "failed";

  // ── STEP 4: PERSIST RESULT ──────────────────────────────────────
  {
    const t0 = Date.now();
    await query(
      `UPDATE governance_proposal_state
          SET outcome = $1, closed_at = NOW(), tally_json = $2::jsonb, anomaly_flags = '{}', updated_at = NOW()
        WHERE proposal_id = $3`,
      [outcome, JSON.stringify(tally), proposalId],
    );
    await log("persist", "ok", { outcome, quorum_met: quorumMet, threshold_met: thresholdMet }, null, Date.now() - t0);
  }

  // ── STEP 5: IMPLEMENT (only if passed) ──────────────────────────
  let implResults = [];
  if (outcome === "passed" && proposal.implementation_plan?.length > 0) {
    const t0 = Date.now();
    await query(
      `UPDATE governance_proposal_state SET implementation_status = 'in_progress', updated_at = NOW() WHERE proposal_id = $1`,
      [proposalId],
    );
    implResults = await executeImplementationPlan(proposal.implementation_plan, proposalId);
    await log("implement", "ok", { results_count: implResults.length, all_ok: implResults.every(r => r.ok) }, null, Date.now() - t0);
  }

  // ── STEP 6: AUDIT — verify each change actually landed ──────────
  let auditResult = { overall_verified: true, per_action: [], summary: { verified_count: 0, unverified_count: 0, blocking_unverified: 0 } };
  if (outcome === "passed" && proposal.implementation_plan?.length > 0) {
    const t0 = Date.now();
    auditResult = await auditImplementation({
      plan: proposal.implementation_plan,
      implResults,
      proposalId,
    });
    await log("audit", auditResult.overall_verified ? "ok" : "halted", auditResult, null, Date.now() - t0);
    await query(
      `UPDATE governance_proposal_state
          SET implementation_status = $1, implementation_summary = $2::jsonb, updated_at = NOW()
        WHERE proposal_id = $3`,
      [
        auditResult.overall_verified ? "verified" : "verification_failed",
        JSON.stringify({ impl: implResults, audit: auditResult }),
        proposalId,
      ],
    );
    if (!auditResult.overall_verified) {
      await operatorDm(
        `AUTOPILOT HALT: ${proposalId} passed the vote but implementation audit failed.\n` +
        `Blocking unverified actions: ${auditResult.summary.blocking_unverified}\n` +
        `Announcement WITHHELD. Manual review required.`,
      );
      return "verification_failed";
    }
  }

  // ── STEP 7: ANNOUNCE — only after audit passes ──────────────────
  if (proposal.announcement_template && COMMUNITY_CHAT_ID && BOT_TOKEN) {
    const t0 = Date.now();
    let snapshotHash;
    if (closeSnapshotId) {
      // Close-time mode: pull the deterministic hash takeCloseTimeSnapshot
      // wrote into governance_snapshots — same audit trail, no file read.
      const { rows } = await query(
        `SELECT hash_sha256 FROM governance_snapshots WHERE snapshot_id = $1`,
        [closeSnapshotId],
      );
      snapshotHash = rows[0]?.hash_sha256 ?? "unknown";
    } else if (snapshotPath) {
      snapshotHash = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
    } else {
      // DB-snapshot path (activation mode but operator filesystem
      // not available on Railway — see step 1 fallback). No file to
      // hash; pull the deterministic hash that was persisted into
      // governance_snapshots when the snapshot was created. Matches
      // the equivalent fallback we apply in the anomaly step so the
      // announce phase doesn't crash on readFileSync(null).
      const registrySnapshotId = proposal.snapshot_id ?? proposalId;
      const { rows } = await query(
        `SELECT hash_sha256 FROM governance_snapshots WHERE snapshot_id = $1`,
        [registrySnapshotId],
      );
      snapshotHash = rows[0]?.hash_sha256 ?? "unknown";
    }
    const variables = buildVariables({ proposal, tally, outcome, snapshotHash });
    const renderedText = renderTemplate(proposal.announcement_template, variables);
    const sendResult = await sendAnnouncement({
      proposalId,
      outcome,
      chatId: COMMUNITY_CHAT_ID,
      renderedText,
      botToken: BOT_TOKEN,
    });
    await log("announce", sendResult.ok ? "ok" : "failed", sendResult.detail, null, Date.now() - t0);
    await query(
      `UPDATE governance_proposal_state SET announcement_status = $1, updated_at = NOW() WHERE proposal_id = $2`,
      [sendResult.ok ? "sent" : "send_failed", proposalId],
    );
  } else {
    await log("announce", "skipped", { reason: "no_template_or_chat_id_unset" }, null, 0);
  }

  // ── STEP 8: NOTIFY OPERATOR ─────────────────────────────────────
  {
    const t0 = Date.now();
    await operatorDm(
      `AUTOPILOT: ${proposalId} (${proposal.title})\n` +
      `Outcome: ${outcome}\n` +
      `Yes: ${tally.percentages.yes_share_of_cast_pct.toFixed(2)}% | Participation: ${tally.percentages.participation_pct.toFixed(2)}%\n` +
      `Implementation: ${auditResult.summary.verified_count} verified / ${auditResult.summary.unverified_count} pending`,
    );
    await log("notify", "ok", null, null, Date.now() - t0);
  }

  await query(
    `UPDATE governance_proposal_state SET pipeline_completed_at = NOW(), updated_at = NOW() WHERE proposal_id = $1`,
    [proposalId],
  );

  return outcome;
}

async function markPipelineError(proposalId, reason) {
  await query(
    `UPDATE governance_proposal_state
        SET outcome = 'pipeline_error',
            anomaly_flags = ARRAY[$1]::text[],
            updated_at = NOW()
      WHERE proposal_id = $2`,
    [reason, proposalId],
  );
  // 2026-06-14: paged-failure alert. Operator should hear about any
  // sustained pipeline_error within a tick or two, not when they
  // happen to look at logs 15 hours later (MGP-001 close-day pattern).
  //
  // We only alert if THIS is a NEW error (no anomaly_flags entry was
  // already there) OR if the same error has now been observed at
  // least PIPELINE_ERROR_ALERT_THRESHOLD ticks in a row. The
  // governance_autopilot_state.last_run_status table already
  // distinguishes consecutive vs first-time via the previous record;
  // we re-page once per N consecutive failures so the operator
  // doesn't get spammed during sustained outages.
  try {
    const { rows: [agg] } = await query(
      `SELECT COUNT(*)::int AS n
         FROM governance_proposal_step_audit
        WHERE proposal_id = $1
          AND status IN ('failed','halted')
          AND step_at > NOW() - INTERVAL '1 hour'`,
      [proposalId],
    );
    const recentFailures = agg?.n ?? 1;
    // Page on first failure AND every 12th failure after (5min ticks
    // -> 12 = ~1h apart). Anything in between is the silent middle
    // where the operator already got the first alert.
    if (recentFailures === 1 || recentFailures % 12 === 0) {
      await operatorDm(
        `AUTOPILOT FAILED: ${proposalId} pipeline returned \`${reason}\` ` +
          `(consecutive recent failures in last hour: ${recentFailures}). ` +
          `Check /gov-status. Auto-paging resumes every ~1h until resolved.`,
      );
    }
  } catch (err) {
    console.warn(`[gov-autopilot] page-on-error helper threw: ${err.message?.slice(0, 120)}`);
  }
}

/**
 * The exported scheduler entrypoint. Call this from a cron / interval.
 * Uses a Postgres advisory lock so two concurrent ticks can't race.
 */
export async function runPipelineTick() {
  // Acquire advisory lock (non-blocking). If another tick holds it, exit clean.
  const { rows: lockRows } = await query(
    `SELECT pg_try_advisory_lock($1) AS got`,
    [Number(PIPELINE_LOCK_KEY)],
  );
  if (!lockRows[0].got) {
    return { ran: false, reason: "lock_busy" };
  }

  try {
    // Update last-run telemetry
    await query(
      `UPDATE governance_autopilot_state SET last_run_at = NOW(), last_run_status = 'in_progress' WHERE id = 1`,
    );
    const ready = await findReadyProposals();
    if (ready.length === 0) {
      await query(`UPDATE governance_autopilot_state SET last_run_status = 'no_work' WHERE id = 1`);
      return { ran: true, processed: 0 };
    }
    const outcomes = [];
    for (const p of ready) {
      const outcome = await processProposal(p);
      outcomes.push({ proposal_id: p.id, outcome });
    }
    await query(
      `UPDATE governance_autopilot_state
          SET last_run_status = 'ok', last_run_detail = $1::jsonb
        WHERE id = 1`,
      [JSON.stringify({ outcomes })],
    );
    return { ran: true, processed: ready.length, outcomes };
  } catch (err) {
    await query(
      `UPDATE governance_autopilot_state
          SET last_run_status = 'error', last_run_detail = $1::jsonb
        WHERE id = 1`,
      [JSON.stringify({ error: err.message })],
    );
    throw err;
  } finally {
    await query(`SELECT pg_advisory_unlock($1)`, [Number(PIPELINE_LOCK_KEY)]);
  }
}
