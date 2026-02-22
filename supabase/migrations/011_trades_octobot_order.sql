-- Migration 011: Add octobot_order_id column to trades table.
-- Stores the order identifier returned by OctoBot on successful execution.
-- Used for reconciliation, audit, and potential order management calls.
--
-- Full status lifecycle after this migration:
--   'pending_execution' — Orchestrator created the row, awaiting executor
--   'open'              — OctoBot accepted the order and it is now live (paper)
--   'execution_failed'  — OctoBot webhook call failed; trade was not placed
--   'placed'            — order confirmed placed on exchange (set by fill handler)
--   'filled'            — order confirmed filled at a price (set by fill handler)
--   'cancelled'         — order was cancelled before fill (set by fill handler)
--   'error'             — unexpected exchange error (set by fill handler)
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS octobot_order_id TEXT;
