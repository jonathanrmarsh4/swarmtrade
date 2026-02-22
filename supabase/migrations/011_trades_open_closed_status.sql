-- Migration 011: Document 'open' and 'closed' as valid status values for the trades table.
--
-- Full status lifecycle:
--   pending_execution  — approved by Orchestrator, not yet dispatched to OctoBot
--   placed             — dispatch sent to OctoBot
--   open               — OctoBot confirmed execution; position is active
--   closed             — position closed by trade-monitor (SL/TP hit) or manual close
--   cancelled          — cancelled before execution
--   error              — OctoBot reported an execution error
COMMENT ON COLUMN trades.status IS 'pending_execution | placed | open | closed | cancelled | error';
