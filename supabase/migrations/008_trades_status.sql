-- Migration 008: Add status column to trades table.
-- Tracks where each trade sits in the execution lifecycle.
-- The Orchestrator writes 'pending_execution' when a trade is approved.
-- The OctoBot handler updates to 'placed', 'filled', 'cancelled', or 'error'.
-- Values: 'pending_execution' | 'placed' | 'filled' | 'cancelled' | 'error'
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending_execution';
