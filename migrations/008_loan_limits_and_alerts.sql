-- 6-hour deadline warning column
ALTER TABLE loans ADD COLUMN IF NOT EXISTS warned_6h_at TIMESTAMPTZ;

-- Track last pump notification so we don't spam
ALTER TABLE loans ADD COLUMN IF NOT EXISTS last_pump_alert_value NUMERIC;
