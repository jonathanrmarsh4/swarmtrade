CREATE TABLE agent_reputation (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name              TEXT,
  week_ending             DATE,
  dissent_correct_rate    NUMERIC,
  overall_accuracy        NUMERIC,
  current_weight          NUMERIC DEFAULT 1.0,
  trades_sampled          INT
);
