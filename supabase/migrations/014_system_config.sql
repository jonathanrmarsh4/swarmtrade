-- system_config: key-value store for runtime-editable backend settings.
-- The scanner reads trading_universe from here on every scan cycle.
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the default trading universe so the scanner works before the UI saves anything
INSERT INTO system_config (key, value, updated_at)
VALUES (
  'trading_universe',
  '["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","MATICUSDT"]',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
