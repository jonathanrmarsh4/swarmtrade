// Reflection Agent — nightly job. Runs after market close (or on a cron schedule).
// Reviews completed trade history in Supabase to evaluate each agent's predictive accuracy.
// Calculates dissent_correct_rate and overall_accuracy per agent for the past week.
// Updates the agent_reputation table with new scores and adjusts current_weight.
// These weights are read by the Orchestrator to calibrate vote influence over time.
