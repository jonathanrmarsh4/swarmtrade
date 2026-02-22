-- Migration 005: Add status column to deliberations table.
-- Tracks which deliberation round is currently active for a given row.
-- Populated by the Orchestrator as it advances through the three-round flow.
-- Values: 'round1' | 'round2' | 'round3' | 'complete' | 'vetoed'
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'round1';
