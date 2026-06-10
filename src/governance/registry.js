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
   * MGP-001 — Holder snapshot for the first distribution. Not really a
   * "vote" in the traditional sense — it's a snapshot+distribution gate.
   * Kept here for autopilot completeness so the pipeline can handle
   * announce-but-no-code-change cases.
   */
  "MGP-001": {
    id: "MGP-001",
    title: "First $MAGPIE Holder Snapshot — Distribution Eligibility",
    proposal_type: "snapshot_only",
    voting_started_at_iso: "2026-06-10T00:00:00Z",
    voting_ends_at_iso: "2026-06-13T23:59:59Z",
    quorum_pct: 0,
    threshold_pct: 0,
    snapshot_id: "MGP-001",
    implementation_plan: [],  // Distribution is human-initiated, not autopilot-driven.
    announcement_template: null, // No autonomous announcement for snapshot-only proposals.
  },

  /**
   * MGP-002 — Fee restructure to 70/10/10/10.
   * Full spec at magpiecapital/magpie-partners:protocol-economics.md.
   *
   * ACTIVATED 2026-06-10T20:40 UTC, closes 2026-06-13T20:40 UTC (72h window).
   * Snapshot taken at activation: MGP-002-2026-06-10T20-38-44-683Z.json,
   *   sha256 f217caef513729bc37e8f89d1205ba6d641640f05f314127a606d856fc0abc69,
   *   2,204 unique eligible wallets.
   */
  "MGP-002": {
    id: "MGP-002",
    title: "Fee Restructure — Holder-First Economics (70/10/10/10)",
    proposal_type: "economics_change",
    voting_started_at_iso: "2026-06-10T20:40:00Z",
    voting_ends_at_iso: "2026-06-13T20:40:00Z",
    quorum_pct: 10.0,
    threshold_pct: 66.6,
    snapshot_id: "MGP-002",
    // The implementation_plan below is the autopilot's task list IF MGP-002 passes.
    // Order matters — actions execute sequentially; failure halts the rest.
    implementation_plan: [
      {
        type: "db_config_update",
        key: "holder_reward_bps",
        new_value: 7000,
        description: "70% holder accrual on every v3 fee",
      },
      {
        type: "db_config_update",
        key: "lp_loyalty_reward_bps",
        new_value: 1000,
        description: "10% LP-or-reserve slot (legacy LP runway, then Insurance Reserve)",
      },
      {
        type: "db_config_update",
        key: "referral_reward_bps",
        new_value: 500,
        description: "5% referrer share (unchanged numerically; semantics shift into the 10% misc pool)",
      },
      {
        type: "manual_required",
        description: "Deploy magpie_lending_v3 with protocol_fee_bps=10000",
        alert_text:
          "MGP-002 ratified. The v3 program deploy requires the upgrade authority " +
          "signature, which is operator-only. Please deploy from the v3 source branch " +
          "and initialize the LendingPool with at least 70 SOL operator seed. The " +
          "autopilot will mark this action as verified once you run " +
          "/gov-confirm-manual MGP-002 v3_deploy with the resulting program ID.",
      },
      {
        type: "bot_constant_pr",
        file_path: "src/services/magpie-holder-rewards.js",
        old_string: "export const HOLDER_REWARD_BPS = 1_000; // 10% of every loan fee",
        new_string:
          "// MGP-002 ratified 2026-XX-XX — see governance_config.holder_reward_bps as runtime override.\n" +
          "export const HOLDER_REWARD_BPS = 7_000; // 70% of every v3 loan fee (default; v1/v2 legacy still uses old runtime path)",
        branch_name: "mgp-002/update-holder-bps",
        description: "Update HOLDER_REWARD_BPS code constant to match the ratified value",
      },
    ],
    announcement_template:
      "📜 MGP-002 — {{title}} — RESULT\n\n" +
      "Outcome: {{outcome_emoji}} {{outcome}}\n" +
      "Yes weight: {{yes_pct}}% ({{yes_sol}} $MAGPIE-weighted)\n" +
      "No weight: {{no_pct}}%\n" +
      "Participation: {{participation_pct}}% of eligible weight\n" +
      "Required quorum: {{quorum_pct}}% | Required threshold: {{threshold_pct}}%\n\n" +
      "{{outcome_message}}\n\n" +
      "Full proposal: magpie.capital/governance/MGP-002\n" +
      "Audit log: this announcement is verifiable on-chain via the snapshot hash {{snapshot_hash_short}}.",
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
