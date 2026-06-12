-- migration 041: admin command audit log
--
-- Security audit finding F-4 (2026-06-12, MEDIUM severity): every admin
-- command — /enablemint, /disablemint, /pause, /resume, /announcement,
-- /broadcast, /ban_user, etc. — runs behind a single env-var gate
-- (ADMIN_TELEGRAM_IDS). No logging, no forensic trail.
--
-- A SIM-swap or social-engineering compromise of an admin TG account
-- gives the attacker:
--   /pause                  → freeze borrowing → ransom
--   /enablemint <rug>       → drain pool against attacker-controlled rug
--   /announcement <phish>   → DM the entire user base with malicious links
--   /ban_user <legit user>  → grief
--
-- With no log, the operator wouldn't know which actions to undo, when,
-- or by whom.
--
-- This migration creates the append-only log. The log writer is
-- src/services/admin-audit.js logAdminCommand(). Reader is /admincmds.
--
-- Future: pair with admin_command_approvals (separate migration) for the
-- multi-step approval workflow on sensitive commands.

CREATE TABLE IF NOT EXISTS admin_command_log (
  id              BIGSERIAL    PRIMARY KEY,
  admin_tg_id     BIGINT       NOT NULL,
  admin_username  TEXT,
  command         TEXT         NOT NULL,
  args_redacted   TEXT,
  outcome         TEXT         NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  error_excerpt   TEXT,
  chat_id         BIGINT,
  chat_type       TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_command_log_created_at
  ON admin_command_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_command_log_admin_tg_id
  ON admin_command_log (admin_tg_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_command_log_command
  ON admin_command_log (command, created_at DESC);

COMMENT ON TABLE admin_command_log IS
  'Append-only forensic log of every admin command attempt. Written by
   src/services/admin-audit.js logAdminCommand(); read by /admincmds.
   args_redacted strips secrets/long-form content; never store full
   pubkeys or signatures here. outcome=denied means isAdmin() rejected;
   that case is the most important to log — captures unauthorized attempts
   that would otherwise be invisible.';
