-- Add missing columns to deliberations table.
-- The orchestrator inserts asset/direction/signal_type/entry_price but these
-- columns were never added, causing inserts to fail silently.

ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS asset        TEXT,
  ADD COLUMN IF NOT EXISTS direction    TEXT,
  ADD COLUMN IF NOT EXISTS signal_type  TEXT,
  ADD COLUMN IF NOT EXISTS entry_price  NUMERIC;
