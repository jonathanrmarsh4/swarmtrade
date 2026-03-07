-- LLM call tracking table
CREATE TABLE IF NOT EXISTS llm_calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent            TEXT NOT NULL,
  model            TEXT NOT NULL,
  deliberation_id  UUID REFERENCES deliberations(id) ON DELETE SET NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(12, 8) NOT NULL DEFAULT 0,
  called_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS llm_calls_called_at_idx ON llm_calls (called_at DESC);
CREATE INDEX IF NOT EXISTS llm_calls_agent_idx     ON llm_calls (agent);

-- Seed default cost limits into system_config
INSERT INTO system_config (key, value, updated_at)
VALUES (
  'cost_limits',
  '{"dailyCapUsd": 1.00, "hardStop": false, "warningThresholdPct": 0.8}',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
