-- Stores the latest crowd sentiment snapshot produced by the Crowd Thermometer.
-- Written every 30 minutes. The Orchestrator reads the most recent row when
-- getSentimentSnapshot() is called — it does not query live APIs at deliberation time.
CREATE TABLE sentiment_cache (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at          TIMESTAMPTZ DEFAULT now(),
  score                INT NOT NULL CHECK (score >= 0 AND score <= 100),
  fear_greed_value     INT,
  fear_greed_label     TEXT,
  reddit_bullish       INT DEFAULT 0,
  reddit_bearish       INT DEFAULT 0,
  reddit_posts_sampled INT DEFAULT 0,
  sources              JSONB DEFAULT '[]'
);
