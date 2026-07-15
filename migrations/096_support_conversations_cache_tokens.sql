-- migration 096: track prompt-cache tokens on support_conversations so the
-- AI-support daily spend cap (getTodaySpendUsd) reflects the REAL Anthropic bill.
--
-- Before this, only base input/output tokens were stored (total_input_tokens /
-- total_output_tokens = usage.input_tokens/output_tokens, i.e. the uncached
-- remainder). The ~50K-token cached system prompt — read or written on every
-- call, across up to 8 tool iterations — was never recorded, so cache
-- read/write cost (which dominates spend) was invisible to the cap and the
-- $20/day ceiling never fired even as the real bill ran to ~$16/day.
--
-- Backfill is intentionally omitted: rows are short-lived (30-min TTL) and the
-- cap only reads today's rows, which will populate correctly going forward.
ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS total_cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cache_write_tokens BIGINT NOT NULL DEFAULT 0;
