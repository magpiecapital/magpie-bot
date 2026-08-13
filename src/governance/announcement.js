/**
 * Announcement rendering + idempotent broadcast.
 *
 * The template fill-in is intentionally NOT LLM-generated. It uses
 * deterministic string substitution with a fixed set of variables.
 * This guarantees the operator can predict the exact message that
 * will broadcast — the safety promise of the autopilot.
 *
 * Idempotency is enforced by the governance_announcements table's
 * primary key (proposal_id, outcome, chat_id). The sender first INSERTs
 * a row with send_status='pending'; on duplicate-key, the previous send
 * already fired and we no-op. After a successful sendMessage, we UPDATE
 * the row to send_status='sent' with the message_id.
 */

import { createHash } from "node:crypto";
import { query } from "../db/pool.js";

/**
 * Fill {{var}} placeholders in the template.
 */
export function renderTemplate(template, variables) {
  if (typeof template !== "string") return "";
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = variables[name];
    return v === undefined ? `{{${name}}}` : String(v);
  });
}

/**
 * Compute the standard variable set from a proposal definition + tally
 * + outcome. Adds outcome-specific message ("ratified — changes are now
 * live" vs "did not pass — economics unchanged").
 */
export function buildVariables({ proposal, tally, outcome, snapshotHash }) {
  // outcome_detail is threaded by the pipeline for BOTH binary + multi-choice
  // (pipeline.js ~L410): { winner_choice, winner_share_pct, quorum_met, threshold_met, is_multi_choice }.
  const det = (tally && tally.outcome_detail) || {};

  // PASS determination that works for binary ("passed") AND multi-choice (a
  // winning option letter like "C" with quorum+threshold both met). The old
  // code keyed off `outcome === "passed"`, so a multi-choice winner ("C")
  // rendered the FAILED message — fixed here.
  const didPass =
    outcome === "passed" ||
    (det.quorum_met === true &&
      det.threshold_met === true &&
      outcome !== "failed" &&
      outcome !== "operator_discretion" &&
      outcome !== "anomaly_held");

  const participationPct = Number(tally?.percentages?.participation_pct ?? 0).toFixed(2);

  // Winner share: multi-choice → outcome_detail.winner_share_pct; binary → yes share.
  // (Old code never populated {{winner_pct}}, so the MGP-003 template rendered it literally.)
  const yesShare = Number(tally?.percentages?.yes_share_of_cast_pct ?? 0);
  const winnerSharePct = det.winner_share_pct != null ? Number(det.winner_share_pct) : yesShare;
  const winnerPct = winnerSharePct.toFixed(2);
  const yesPct = yesShare.toFixed(2);
  const noPct = (100 - yesShare).toFixed(2);
  const yesSol = (Number(tally?.weights?.yes_weight ?? 0) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 });

  // Display a winning option letter with its human label when the proposal
  // provides one (registry `option_labels`), e.g. "Option C — Build (...)".
  const label = proposal.option_labels && outcome ? proposal.option_labels[outcome] : null;
  const outcomeDisplay = label ? `Option ${outcome} — ${label}` : outcome;

  let outcomeMessage;
  if (didPass) {
    // Proposal-specific copy wins (e.g. MGP-003's operator-gated treasury move);
    // otherwise an accurate generic that does NOT falsely claim auto-application.
    outcomeMessage =
      proposal.result_message_passed ||
      "Result ratified. Any autonomous config changes are applied immediately; on-chain or operator-gated actions are staged for execution and tracked publicly on magpie.capital/distributions.";
  } else if (outcome === "operator_discretion") {
    outcomeMessage =
      "No option reached the required margin (or ABSTAIN reached the discretion threshold). The operator decides among the options per the proposal's rules.";
  } else {
    outcomeMessage = "Proposal did not meet quorum + threshold. Current economics remain in force.";
  }
  const outcomeEmoji = didPass ? "PASSED" : outcome === "operator_discretion" ? "OPERATOR DISCRETION" : "DID NOT PASS";

  return {
    title: proposal.title,
    outcome: outcomeDisplay,
    outcome_raw: outcome,
    outcome_emoji: outcomeEmoji,
    outcome_message: outcomeMessage,
    winner_pct: winnerPct,
    yes_pct: yesPct,
    no_pct: noPct,
    yes_sol: yesSol,
    participation_pct: participationPct,
    quorum_pct: proposal.quorum_pct.toFixed(1),
    threshold_pct: proposal.threshold_pct.toFixed(1),
    snapshot_hash_short: snapshotHash ? snapshotHash.slice(0, 12) + "…" : "(no snapshot)",
  };
}

/**
 * Send the announcement. Returns { ok, detail }.
 *
 * If a prior send already happened for this (proposal_id, outcome, chat_id),
 * returns ok=true with detail.skipped=true.
 */
export async function sendAnnouncement({ proposalId, outcome, chatId, renderedText, botToken }) {
  if (!chatId) return { ok: false, detail: { error: "missing_chat_id" } };
  if (!botToken) return { ok: false, detail: { error: "missing_bot_token" } };
  if (!renderedText) return { ok: false, detail: { error: "missing_rendered_text" } };

  const textHash = createHash("sha256").update(renderedText, "utf8").digest("hex");

  // Idempotency: INSERT pending row. Duplicate-key → already sent or in-flight.
  let inserted;
  try {
    const r = await query(
      `INSERT INTO governance_announcements (proposal_id, outcome, chat_id, rendered_text_sha256, send_status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (proposal_id, outcome, chat_id) DO NOTHING
       RETURNING proposal_id`,
      [proposalId, outcome, chatId, textHash],
    );
    inserted = r.rowCount > 0;
  } catch (err) {
    return { ok: false, detail: { error: `idempotency_row_insert_failed: ${err.message}` } };
  }
  if (!inserted) {
    // Already a row — check its status
    const existing = await query(
      `SELECT send_status, rendered_text_sha256, message_id FROM governance_announcements
        WHERE proposal_id = $1 AND outcome = $2 AND chat_id = $3`,
      [proposalId, outcome, chatId],
    );
    const row = existing.rows[0];
    if (row.send_status === "sent") {
      return { ok: true, detail: { skipped: true, reason: "already_sent", message_id: row.message_id } };
    }
    // pending or failed — could be a crashed prior run. Conservative call:
    // do NOT retry autonomously. Operator can manually clear the row to retry.
    return {
      ok: false,
      detail: {
        error: "prior_send_in_inconclusive_state",
        send_status: row.send_status,
        hint: "Operator must DELETE the row in governance_announcements to allow retry.",
      },
    };
  }

  // Fire the send
  let response;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: renderedText, disable_web_page_preview: true }),
    });
    response = await res.json();
    if (!response.ok) {
      throw new Error(`telegram_error: ${response.description || res.status}`);
    }
  } catch (err) {
    await query(
      `UPDATE governance_announcements
          SET send_status = 'failed', error_message = $1
        WHERE proposal_id = $2 AND outcome = $3 AND chat_id = $4`,
      [String(err.message).slice(0, 500), proposalId, outcome, chatId],
    );
    return { ok: false, detail: { error: "telegram_send_failed", message: err.message } };
  }

  await query(
    `UPDATE governance_announcements
        SET send_status = 'sent', message_id = $1, sent_at = NOW()
      WHERE proposal_id = $2 AND outcome = $3 AND chat_id = $4`,
    [response.result.message_id, proposalId, outcome, chatId],
  );

  return { ok: true, detail: { message_id: response.result.message_id, text_hash: textHash } };
}
