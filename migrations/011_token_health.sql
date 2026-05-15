-- Track consecutive degraded health checks per token (2 strikes → delist)
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS health_strikes INTEGER DEFAULT 0;
