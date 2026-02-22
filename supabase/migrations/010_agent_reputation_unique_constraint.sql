-- Add unique constraint on agent_name + week_ending for proper upsert behavior
ALTER TABLE agent_reputation 
ADD CONSTRAINT agent_reputation_agent_week_unique 
UNIQUE (agent_name, week_ending);
