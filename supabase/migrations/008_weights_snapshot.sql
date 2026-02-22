-- Migration 008: Add weights_snapshot column to deliberations
-- Stores the agent reputation weights that were active during this deliberation

ALTER TABLE deliberations
ADD COLUMN weights_snapshot JSONB;

COMMENT ON COLUMN deliberations.weights_snapshot IS 
  'Snapshot of agent reputation weights used during this deliberation. Format: {"bull": 1.0, "bear": 0.95, ...}';
