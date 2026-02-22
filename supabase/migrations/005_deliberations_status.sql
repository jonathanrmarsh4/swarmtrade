-- Track which deliberation round each row is currently in.
-- 'pending'  → row created but no agents have run yet (shouldn't persist long)
-- 'round1'   → Round 1 agent outputs written, waiting for Round 2
-- 'round2'   → Bull/Bear rebuttals written, waiting for Orchestrator synthesis
-- 'complete' → Orchestrator synthesis and Risk decision written
ALTER TABLE deliberations ADD COLUMN status TEXT DEFAULT 'pending';
