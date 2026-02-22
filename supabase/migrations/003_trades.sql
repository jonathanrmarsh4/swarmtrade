CREATE TABLE trades (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deliberation_id     UUID REFERENCES deliberations(id),
  entry_price         NUMERIC,
  entry_time          TIMESTAMPTZ DEFAULT now(),
  exit_price          NUMERIC,
  exit_time           TIMESTAMPTZ,
  position_size_usd   NUMERIC,
  pnl_usd             NUMERIC,
  pnl_pct             NUMERIC,
  mode                TEXT DEFAULT 'paper',
  exchange            TEXT
);
