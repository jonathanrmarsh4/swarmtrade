CREATE TABLE reflections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_ending         DATE NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  trades_analysed     INT NOT NULL,
  best_agent          TEXT,
  worst_agent         TEXT,
  systematic_biases   TEXT,
  winning_patterns    TEXT,
  losing_patterns     TEXT,
  recommendation      TEXT NOT NULL,
  full_summary        TEXT NOT NULL
);
