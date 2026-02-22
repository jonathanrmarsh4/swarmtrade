CREATE TABLE signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at     TIMESTAMPTZ DEFAULT now(),
  asset           TEXT NOT NULL,
  direction       TEXT NOT NULL,
  timeframe       TEXT,
  signal_type     TEXT,
  raw_payload     JSONB
);
