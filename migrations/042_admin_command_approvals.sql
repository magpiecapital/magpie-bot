-- migration 042: multi-step admin command approval (audit F-4 follow-up)
--
-- PR #105 shipped the audit-log foundation. This migration ships the
-- second-admin approval workflow for the most sensitive commands
-- (/enablemint, /disablemint, /broadcast by default; tunable via
-- ADMIN_COMMAND_APPROVAL_REQUIRED env var).
--
-- Threat model: a SIM-swap or social-engineering compromise of an
-- admin TG account. With single-admin auth, the attacker can
-- unilaterally /enablemint a rug token and drain the pool. With
-- second-admin approval, they need to compromise TWO independent
-- admin accounts within a 5-minute window before the pending request
-- expires.
--
-- Flow:
--   1. Admin A types `/enablemint <mint> <symbol> <decimals>`
--      → row inserted into admin_command_approvals with status='pending'
--      → bot DMs every OTHER admin "request #N: /enablemint ..."
--   2. Admin B types `/approve <N>` within 5 min
--      → row's status → 'approved', approved_by_tg_id + approved_at set
--      → executor reads stored args_json and runs the real handler
--   3. OR Admin B types `/deny <N>` → status='denied', no action
--   4. OR 5 min passes → status='expired' on next sweep, no action
--
-- Same-admin self-approval is explicitly REJECTED at the application
-- layer (audit log captures the attempt as outcome='denied'); the
-- CHECK constraint here just guards data shape.
--
-- Solo-admin case: when ADMIN_TELEGRAM_IDS has exactly one entry, the
-- approval gate short-circuits to execute immediately and logs as
-- outcome='solo_admin_bypass' so the operator can see those events.
-- The DB enforces nothing here — that's an app-layer policy decision.

CREATE TABLE IF NOT EXISTS admin_command_approvals (
  id                   BIGSERIAL    PRIMARY KEY,
  command              TEXT         NOT NULL,
  args_json            JSONB        NOT NULL,
  requester_tg_id      BIGINT       NOT NULL,
  requester_username   TEXT,
  requester_chat_id    BIGINT,
  requested_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ  NOT NULL,
  status               TEXT         NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','denied','expired','executed')),
  approver_tg_id       BIGINT,
  approver_username    TEXT,
  approved_at          TIMESTAMPTZ,
  denied_at            TIMESTAMPTZ,
  executed_at          TIMESTAMPTZ,
  execute_error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_command_approvals_status_expires
  ON admin_command_approvals (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_command_approvals_requester
  ON admin_command_approvals (requester_tg_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_command_approvals_pending
  ON admin_command_approvals (id) WHERE status = 'pending';

-- Expand the admin_command_log outcome enum to cover the two new states
-- this migration introduces:
--   solo_admin_bypass — single-admin operator; gate short-circuited
--   pending_approval  — request enqueued, awaiting second admin
-- migration 041 originally allowed only success/denied/error; both new
-- values are forensic events the operator wants visible in /admincmds.
ALTER TABLE admin_command_log DROP CONSTRAINT IF EXISTS admin_command_log_outcome_check;
ALTER TABLE admin_command_log
  ADD CONSTRAINT admin_command_log_outcome_check
  CHECK (outcome IN ('success','denied','error','solo_admin_bypass','pending_approval'));

COMMENT ON TABLE admin_command_approvals IS
  'Two-step approval queue for sensitive admin commands (audit F-4).
   Requester creates a row with status=pending; a DIFFERENT admin must
   /approve or /deny within expires_at. Solo-admin operators bypass
   the gate but the bypass is logged via admin_command_log
   (outcome=solo_admin_bypass).';
