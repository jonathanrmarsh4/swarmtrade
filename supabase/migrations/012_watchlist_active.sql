-- Migration: watchlist_active table for Scanner v2
-- Stores the current WebSocket watchlist so the dashboard can display it.
-- Pairs persist until they score below threshold on a rescan (no time expiry).

CREATE TABLE IF NOT EXISTS watchlist_active (
  id         SERIAL PRIMARY KEY,
  symbol     VARCHAR(20)  NOT NULL,
  score      INTEGER      NOT NULL,
  direction  TEXT,
  reasons    JSONB,
  price      DECIMAL(20,8),
  volume_24h DECIMAL(20,2),
  created_at TIMESTAMP    DEFAULT NOW(),
  expires_at TIMESTAMP    NOT NULL
);

-- Unique constraint so upsert works correctly
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_active_symbol ON watchlist_active(symbol);
CREATE INDEX        IF NOT EXISTS idx_watchlist_expires       ON watchlist_active(expires_at);

-- Add direction column to scanner_results if not already present
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS direction TEXT;

-- Enable realtime so dashboard Scanner tab updates live
ALTER PUBLICATION supabase_realtime ADD TABLE watchlist_active;
