-- Add asset context columns to trades table so the Portfolio can display
-- symbol, direction, stop/take levels without joining to deliberations.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS asset         TEXT,
  ADD COLUMN IF NOT EXISTS direction     TEXT,
  ADD COLUMN IF NOT EXISTS stop_loss     NUMERIC,
  ADD COLUMN IF NOT EXISTS take_profit   NUMERIC,
  ADD COLUMN IF NOT EXISTS timeframe     TEXT,
  ADD COLUMN IF NOT EXISTS trading_mode  TEXT;
