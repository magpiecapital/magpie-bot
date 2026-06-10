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

import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { getProposal, listProposalIds } from "./registry.js";
import { tallyProposal } from "./tally.js";
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
  const { readdirSync } = require("node:fs");
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

  // ── STEP 1: TALLY ───────────────────────────────────────────────
  let tally;
  let snapshotPath;
  {
    const t0 = Date.now();
    snapshotPath = findSnapshotFile(proposal.snapshot_id ?? proposalId);
    if (!snapshotPath) {
      await log("tally", "failed", { snapshot_dir: SNAPSHOT_DIR }, "no_snapshot_file_found", Date.now() - t0);
      await markPipelineError(proposalId, "no_snapshot_file_found");
      return "pipeline_error";
    }
    try {
      tally = await tallyProposal({
        proposalId,
        questionId: proposal.id,
        snapshotPath,
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
        questionId: proposal.id,
        snapshotPath,
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
      await operatorDm(`⚠️ AUTOPILOT HALT: ${proposalId} tally cross-check disagreed. Manual review required.`);
      return "pipeline_error";
    }
    await log("verify", "ok", { match: true }, null, Date.now() - t0);
  }

  // ── STEP 3: ANOMALY CHECKS ──────────────────────────────────────
  let anomaly;
  {
    const t0 = Date.now();
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const expectedHash = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
    anomaly = await runAnomalyChecks({
      proposalId,
      tally,
      snapshotPath,
      expectedSnapshotHash: expectedHash,
      windowEndsAtIso: proposal.voting_ends_at_iso,
    });
    if (!anomaly.ok) {
      await log("anomaly", "halted", { flags: anomaly.flags }, "anomaly_detected", Date.now() - t0);
      await query(
        `UPDATE governance_proposal_state
            SET outcome = 'anomaly_held', anomaly_flags = $1::text[], updated_at = NOW()
          WHERE proposal_id = $2`,
        [anomaly.flags, proposalId],
      );
      await operatorDm(`⚠️ AUTOPILOT HALT: ${proposalId} anomaly checks failed:\n${anomaly.flags.join("\n")}`);
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
        `⚠️ AUTOPILOT HALT: ${proposalId} passed the vote but implementation audit failed.\n` +
        `Blocking unverified actions: ${auditResult.summary.blocking_unverified}\n` +
        `Announcement WITHHELD. Manual review required.`,
      );
      return "verification_failed";
    }
  }

  // ── STEP 7: ANNOUNCE — only after audit passes ──────────────────
  if (proposal.announcement_template && COMMUNITY_CHAT_ID && BOT_TOKEN) {
    const t0 = Date.now();
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const snapshotHash = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
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
      `✅ AUTOPILOT: ${proposalId} (${proposal.title})\n` +
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
