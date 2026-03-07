-- Seed default SL/TP config into system_config.
-- The backend reads this on every trade; frontend Settings page can update it.
INSERT INTO system_config (key, value, updated_at)
VALUES (
  'sl_tp_config',
  '{
    "global": {
      "strategy": "atr",
      "stopMult": 1.5,
      "tpMult":   3.0,
      "stopPct":  0.025,
      "tpPct":    0.060,
      "srBuffer": 0.005,
      "minRR":    1.5
    },
    "profiles": {
      "intraday": { "strategy": "atr", "stopMult": 1.2, "tpMult": 2.4 },
      "dayTrade": { "strategy": "atr", "stopMult": 1.5, "tpMult": 3.0 },
      "swing":    { "strategy": "atr", "stopMult": 2.0, "tpMult": 5.0 },
      "position": { "strategy": "atr", "stopMult": 2.5, "tpMult": 7.5 }
    }
  }',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
