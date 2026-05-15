-- Protected tokens are exempt from automated delisting by the health monitor
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS protected BOOLEAN DEFAULT FALSE;
