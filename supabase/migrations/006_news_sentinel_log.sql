-- Stores breaking news events detected by the News Sentinel.
-- Written when CryptoPanic returns high or medium urgency posts.
-- acknowledged = false means the Orchestrator has not yet acted on this news.
-- The Sentiment Agent reads the latest unacknowledged row; the Orchestrator
-- sets acknowledged = true after the resulting deliberation completes.
CREATE TABLE news_sentinel_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at     TIMESTAMPTZ DEFAULT now(),
  headline        TEXT NOT NULL,
  url             TEXT,
  source          TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  urgency         TEXT NOT NULL CHECK (urgency IN ('high', 'medium', 'low')),
  asset           TEXT,
  acknowledged    BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  raw_payload     JSONB
);
