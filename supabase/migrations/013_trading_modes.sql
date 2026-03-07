-- Migration: add trading_mode + timeframe columns for multi-profile support

ALTER TABLE deliberations   ADD COLUMN IF NOT EXISTS trading_mode TEXT DEFAULT 'dayTrade';
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS trading_mode TEXT;
ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS timeframe    TEXT;
ALTER TABLE watchlist_active ADD COLUMN IF NOT EXISTS trading_mode TEXT;
ALTER TABLE watchlist_active ADD COLUMN IF NOT EXISTS timeframe    TEXT;
