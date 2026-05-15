-- Track who submitted a token for review
ALTER TABLE token_screen_queue ADD COLUMN IF NOT EXISTS submitted_by BIGINT;
