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

  /**
   * MGP-003 — July 1, 2026 Streamflow unlock allocation (~5% of supply).
   *
   * Added to the canonical registry 2026-06-25 after it was found LIVE in the
   * vote-submission registry (src/api/governance-api.js ACTIVE_PROPOSALS) ONLY —
   * a split-brain. tally/voting-power/pipeline all read THIS file via
   * getProposal()/listProposalIds(), so MGP-003 was invisible to them: live
   * results 404'd ("Unknown proposal") and the vote would have gone nowhere at
   * close. See feedback_governance_lifecycle_automation_mandate.
   *
   * Electorate model: CURRENT HOLDERS (close-time) — operator decision
   * 2026-06-25. snapshot_mode 'at_close' => the pipeline re-snapshots holders at
   * close (Jun 29) for the BINDING tally (snapshot_id 'MGP-003_close'). A
   * full-holder 'MGP-003' snapshot is generated now (scripts/governance-live-snapshot.js)
   * to power LIVE results during voting.
   *
   * Multi-choice ballot (A/B/C/D + ABSTAIN): plurality winner needs > 40% of
   * cast; ABSTAIN >= 30% of weight -> operator discretion among A-D. NOTE: the
   * generic pipeline tally is YES/NO; the plurality+abstain winner determination
   * and the on-chain executor are tracked separately (do NOT auto-fire at close
   * until built). implementation_plan is manual_required for now.
   */
  "MGP-003": {
    id: "MGP-003",
    title: "Allocation decision for the July 1, 2026 $MAGPIE Streamflow unlock (~5% of supply)",
    proposal_type: "allocation_vote",
    voting_started_at_iso: "2026-06-25T00:00:00Z",
    voting_ends_at_iso: "2026-06-30T00:00:00Z",
    quorum_pct: 7.5,
    threshold_pct: 40.0, // plurality: winning option needs > 40% of cast votes
    snapshot_id: "MGP-003",
    snapshot_mode: "at_close",
    question_id: "Vote",
    choices: ["A", "B", "C", "D", "ABSTAIN"],
    abstain_discretion_pct: 30.0, // ABSTAIN >= 30% of weight -> operator discretion among A-D
    // Human labels for the announcement (maps a winning letter → "Option C — …").
    option_labels: {
      A: "Patience (36-month re-lock)",
      B: "Loyalty (24-month holder vest)",
      C: "Build (24-month locked Growth Treasury)",
      D: "Discipline + Build (50% burn / 50% treasury)",
    },
    // Accurate passed-message for the operator-gated treasury allocation (no false
    // "auto-applied" claim; reflects the tranche + no-burn). Used by buildVariables.
    result_message_passed:
      "Option C — Build wins. The ~50,494,118 $MAGPIE July-1 unlock moves to a NEW dedicated multi-sig Growth Treasury (hardware-key Squads vault, 48h timelock, separate from operational funds): a reserve tranche Streamflow-locked >=24 months (to 2028-07-01) + a working tranche deployable ONLY on the five pre-declared categories. NO burn — total supply unchanged. Execution is operator-signed within 14 days of the unlock; every step posts to magpie.capital/distributions with an on-chain receipt.",
    // Operator executes the winning option's Streamflow lock/burn MANUALLY (no
    // Streamflow integration in the bot). At close the autopilot DMs the operator
    // the winning option's exact instructions from this map (see pipeline.js).
    per_option_execution: {
      A: "PATIENCE — Re-lock 100% (~50M $MAGPIE) into a NEW Streamflow vesting contract: 36-month linear vest ending July 2029, same beneficiary, full unlocked balance, no cliff.",
      B: "LOYALTY — Distribute 100% (~50M) to current $MAGPIE holders via a 24-month linear Streamflow vest, pro-rata by the close snapshot (governance_snapshot_weights snapshot_id 'MGP-003_close'), ~0.137%/day each.",
      C: "BUILD — Move 100% (~50M) to the multi-sig Magpie Treasury, Streamflow-locked >= 24 months; spend only the pre-declared categories; log on /distributions.",
      D: "DISCIPLINE + BUILD — (1) Burn 50% (~25M) permanently via SPL burn from the holding wallet; (2) lock the other 50% (~25M) in the Growth Treasury (Option C terms, 24-month).",
    },
    implementation_plan: [
      {
        type: "manual_required",
        description:
          "Execute the winning allocation option on-chain (A 36mo re-lock / B 24mo holder vest / C locked treasury / D 50% burn + 50% treasury). The autonomous executor is under construction; until it is wired + adversarially verified, the autopilot tallies + determines the winner + alerts, but does NOT fire the irreversible on-chain action.",
        alert_text:
          "MGP-003 closed. The on-chain execution (Streamflow re-lock / holder vest / treasury / burn) is pending the autonomous governance executor. Do NOT auto-fire.",
      },
    ],
    announcement_template:
      "MGP-003 — {{title}} — RESULT\n\n" +
      "Winning option: {{outcome}}\n" +
      "Participation: {{participation_pct}}% of eligible weight (quorum {{quorum_pct}}%)\n" +
      "Winner share: {{winner_pct}}% of cast (plurality threshold {{threshold_pct}}%)\n\n" +
      "{{outcome_message}}\n\n" +
      "Full proposal: magpie.capital/governance/proposal/MGP-003\n" +
      "Verifiable via snapshot hash {{snapshot_hash_short}}.",
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
