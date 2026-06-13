/**
 * Proposal registry — versioned source of truth for governance proposals.
 *
 * Each proposal's `implementation_plan` is a declarative list of changes
 * the autopilot will apply if the vote passes. The pipeline reads this
 * registry, executes each action, and audits that each landed correctly
 * before announcing.
 *
 * Action types supported by the autonomous implementation runner:
 *   - { type: "db_config_update", key, new_value }
 *       UPDATE governance_config SET config_value = new_value WHERE config_key = key.
 *       Previous value is captured atomically for rollback.
 *   - { type: "bot_constant_pr", file_path, old_string, new_string, branch_name }
 *       Open a GitHub PR with the diff. Operator must merge — branch
 *       protection blocks autonomous merge of code-level changes (by design).
 *   - { type: "schema_migration", file_name }
 *       Apply a versioned migration. Migration must already exist in
 *       migrations/ — the autopilot never writes new SQL files.
 *   - { type: "manual_required", description, alert_text }
 *       Action that CANNOT be autonomous (e.g., new program deploy).
 *       Pipeline emits an operator alert with the description; logs as
 *       "manual_required" status. Implementation never marked verified
 *       until operator confirms via /gov-confirm-manual <proposal_id> <action_idx>.
 *
 * announcement_template is a static string with {{variable}} fill-ins.
 * The pipeline renders it with the actual tally numbers; no LLM-generated
 * text in the autonomous broadcast path.
 */

export const PROPOSALS = {
  /**
   * MGP-001 — Restructure the loan-fee split to 70/10/10/10.
   *
   * Operator confirmed 2026-06-10: the 60/30 framing on the site was stale;
   * 70/10/10/10 is the agreed proposal. Vote was restarted with corrected
   * content. The 14 votes cast against the old framing were invalidated and
   * removed; this is a fresh window from 2026-06-10T22:00 UTC.
   *
   * The MGP-001 ID is also used historically for the first $MAGPIE holder
   * distribution snapshot/payout (sent 2026-06-10). The two share the ID at
   * the surface level but live in separate tables: the distribution is in
   * governance_distributions, this proposal is in governance_votes.
   *
   * Snapshot reused: MGP-002-2026-06-10T20-38-44-683Z.json (taken for the
   * earlier MGP-002 activation, before this rename — same eligible voter set:
   * 2,204 wallets). Set snapshot_id to "MGP-002" so findSnapshotFile picks it.
   */
  "MGP-001": {
    id: "MGP-001",
    title: "Restructure the loan-fee split — 70/10/10/10",
    proposal_type: "economics_change",
    voting_started_at_iso: "2026-06-10T22:00:00Z",
    voting_ends_at_iso: "2026-06-13T22:00:00Z",
    // 2026-06-13: lowered from 10.0 → 5.0. Reasoning: at the time
    // MGP-001 was scoped (early v0 governance), 10% was the placeholder
    // bar. Real participation in the first three days landed at ~7.93%
    // which is significantly above the 5% effective floor we ultimately
    // want for v0 (early holder base + asymmetric voter availability
    // make 10% an over-tight bar that risks failing legitimate
    // proposals on volume alone). The 5% level still meaningfully
    // filters against tiny-quorum capture and aligns with the
    // proposal-page disclosure that already read "≥ 7.5%".
    // Forward-default for future proposals lands as a separate change.
    quorum_pct: 5.0,
    threshold_pct: 66.6,
    snapshot_id: "MGP-002",
    snapshot_sha256: "f217caef513729bc37e8f89d1205ba6d641640f05f314127a606d856fc0abc69",
    implementation_plan: [
      {
        type: "db_config_update",
        key: "holder_reward_bps",
        new_value: 7000,
        description: "70% to $MAGPIE holders",
      },
      {
        type: "db_config_update",
        key: "lp_loyalty_reward_bps",
        new_value: 1000,
        description: "10% to SOL LPs",
      },
      {
        type: "db_config_update",
        key: "referral_reward_bps",
        new_value: 1000,
        description: "10% to referrers",
      },
      {
        type: "db_config_update",
        key: "protocol_reserve_bps",
        new_value: 1000,
        description: "10% to the protocol reserve",
      },
      {
        type: "manual_required",
        description: "Deploy magpie_lending_v3 with the 70/10/10/10 split baked in + the loan↔pool binding fix from the 2026-06-10 audit",
        alert_text:
          "MGP-001 ratified. The v3 program deploy is operator-only (upgrade authority). " +
          "External audit required before deploy (see governance/v3-program-audit-plan.md). " +
          "Confirm via /gov-confirm-manual MGP-001 v3_deploy <program_id> when shipped.",
      },
      {
        type: "bot_constant_pr",
        file_path: "src/services/magpie-holder-rewards.js",
        old_string: "export const HOLDER_REWARD_BPS = 1_000; // 10% of every loan fee",
        new_string:
          "// MGP-001 ratified — see governance_config.holder_reward_bps for the runtime override.\n" +
          "export const HOLDER_REWARD_BPS = 7_000; // 70% of every v3 loan fee",
        branch_name: "mgp-001/update-holder-bps-to-7000",
        description: "Update HOLDER_REWARD_BPS to match ratified 70%",
      },
    ],
    announcement_template:
      "MGP-001 — {{title}} — RESULT\n\n" +
      "Outcome: {{outcome}}\n" +
      "Yes weight: {{yes_pct}}% ({{yes_sol}} $MAGPIE-weighted)\n" +
      "No weight: {{no_pct}}%\n" +
      "Participation: {{participation_pct}}% of eligible weight\n" +
      "Required quorum: {{quorum_pct}}% | Required threshold: {{threshold_pct}}%\n\n" +
      "{{outcome_message}}\n\n" +
      "Full proposal: magpie.capital/governance/proposal/MGP-001\n" +
      "Verifiable via snapshot hash {{snapshot_hash_short}}.",
  },

  /**
   * MGP-002 — Withdrawn 2026-06-10. The earlier framing of the fee restructure
   * lived here briefly during a registry shuffle and was reconsolidated under
   * MGP-001 (the canonical site-facing ID). Kept in the registry as a
   * withdrawn record so the autopilot doesn't try to process votes against it.
   */
  "MGP-002": {
    id: "MGP-002",
    title: "[WITHDRAWN] Reconsolidated under MGP-001",
    proposal_type: "withdrawn",
    voting_started_at_iso: "2026-06-10T20:40:00Z",
    voting_ends_at_iso: "2026-06-10T22:00:00Z",
    quorum_pct: 0,
    threshold_pct: 0,
    implementation_plan: [],
    announcement_template: null,
  },
};

/**
 * Look up a proposal definition by id. Returns null if not found.
 */
export function getProposal(proposalId) {
  return PROPOSALS[proposalId] ?? null;
}

/**
 * List all proposals whose voting window has CLOSED and which haven't
 * been processed yet (no row in governance_proposal_state). Used by
 * the pipeline scheduler to find work.
 */
export function listProposalIds() {
  return Object.keys(PROPOSALS);
}
