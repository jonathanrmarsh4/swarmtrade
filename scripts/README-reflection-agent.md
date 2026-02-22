# Reflection Agent

**Location:** `/scripts/reflection-agent.js`

**Model:** `claude-sonnet-4-5` (via `MODELS.orchestrator` from `/config/models.js`)

**Schedule:** Runs nightly at 00:00 UTC via `node-cron`

---

## Purpose

The Reflection Agent reviews closed trades from the past 7 days and evaluates each agent's predictive accuracy. It calculates two key metrics per agent:

1. **Overall Accuracy** — Did high-confidence calls (score > 70) close profitably?
2. **Dissent Correct Rate** — When this agent had the minority view, was it right?

Based on consecutive performance trends, the agent's `current_weight` is adjusted up or down. These weights are used by the Orchestrator to calibrate vote influence over time.

---

## Workflow

### Step 1: Gather Trade Data
Fetches all closed trades from the past 7 days with full deliberation context:

```sql
SELECT trades.*, deliberations.*
FROM trades
JOIN deliberations ON trades.deliberation_id = deliberations.id
WHERE exit_time IS NOT NULL
  AND exit_time >= (NOW() - INTERVAL '7 days')
```

### Step 2: Calculate Per-Agent Metrics

For each agent (`bull`, `bear`, `quant`, `macro`, `sentiment`):

- **High-confidence trades:** Trades where the agent's score/signal was > 70 (or equivalent)
- **Dissent trades:** Trades where this agent had the minority view (e.g., Bull > 70, Bear < 30)

Accuracy is calculated as:

```
overallAccuracy = (correct high-confidence calls) / (total high-confidence calls)
dissentCorrectRate = (correct dissent calls) / (total dissent calls)
```

### Step 3: LLM Analysis

Sends a formatted summary to Claude Sonnet with this week's data:

```
You are reviewing the performance of a multi-agent trading committee.

## This Week's Trade Summary
Total closed trades: 12
Profitable trades: 8
Unprofitable trades: 4

## Per-Agent Performance
### BULL
- Overall Accuracy: 66.7% (9 trades)
- Dissent Correct Rate: 50.0% (2 trades)
- Current Weight: 1.0

...

## Task
Identify:
1. Which agents showed the best signal quality this week?
2. Any systematic biases across the committee.
3. Patterns in winning vs losing trades.
4. One specific, actionable improvement recommendation for next week.
```

### Step 4: Update Agent Reputation

For each agent:

1. Fetch previous week's weight and metrics from `agent_reputation`
2. Apply weight adjustment rules:
   - If `dissentCorrectRate > 0.6` for 2+ consecutive weeks → `weight += 0.1`
   - If `overallAccuracy < 0.4` for 2+ consecutive weeks → `weight -= 0.1`
3. Clamp weight between `0.5` and `1.5`
4. Upsert new row in `agent_reputation` table

### Step 5: Write Reflection Summary

Parse Sonnet's response and write to `reflections` table:

- `week_ending` (DATE)
- `trades_analysed` (INT)
- `best_agent` (TEXT)
- `worst_agent` (TEXT)
- `systematic_biases` (TEXT)
- `winning_patterns` (TEXT)
- `losing_patterns` (TEXT)
- `recommendation` (TEXT)
- `full_summary` (TEXT) — complete Sonnet response

---

## Running Manually

The agent runs automatically at midnight, but can be triggered manually:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
SUPABASE_URL=https://... \
SUPABASE_SERVICE_KEY=... \
node scripts/test-reflection-agent.js
```

Or from code:

```javascript
const { runWeeklyReflection } = require('./scripts/reflection-agent.js');
await runWeeklyReflection();
```

---

## Database Schema

### `agent_reputation`

```sql
CREATE TABLE agent_reputation (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name              TEXT,
  week_ending             DATE,
  dissent_correct_rate    NUMERIC,
  overall_accuracy        NUMERIC,
  current_weight          NUMERIC DEFAULT 1.0,
  trades_sampled          INT,
  UNIQUE (agent_name, week_ending)
);
```

### `reflections`

```sql
CREATE TABLE reflections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_ending         DATE NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  trades_analysed     INT NOT NULL,
  best_agent          TEXT,
  worst_agent         TEXT,
  systematic_biases   TEXT,
  winning_patterns    TEXT,
  losing_patterns     TEXT,
  recommendation      TEXT NOT NULL,
  full_summary        TEXT NOT NULL
);
```

---

## Weight Adjustment Rules

| Condition | Action |
|-----------|--------|
| `dissentCorrectRate > 0.6` for 2+ consecutive weeks | `weight += 0.1` |
| `overallAccuracy < 0.4` for 2+ consecutive weeks | `weight -= 0.1` |
| Weight is clamped between `0.5` and `1.5` | Always enforced |

**Example:**

- Week 1: Bull Agent has `dissentCorrectRate = 0.65`, `weight = 1.0`
- Week 2: Bull Agent has `dissentCorrectRate = 0.70`, `weight = 1.1` ✓ (2 consecutive weeks > 0.6)
- Week 3: Bull Agent has `overallAccuracy = 0.35`, `weight = 1.1` (no change, need 2 consecutive)
- Week 4: Bull Agent has `overallAccuracy = 0.38`, `weight = 1.0` ✓ (2 consecutive weeks < 0.4)

---

## Notes

- **Model:** Uses `MODELS.orchestrator` (Sonnet) for deep analysis — never Haiku
- **No LLM calls for calculations:** All metrics are computed deterministically before sending to Sonnet
- **Consecutive tracking:** Weight adjustments require 2 consecutive weeks to avoid overreacting to noise
- **Runs nightly:** Even though it analyses a 7-day window, it runs every day to capture rolling windows
- **Manual callable:** Useful for debugging or testing without waiting for the cron schedule

---

## Integration

Called at app startup in root `index.js`:

```javascript
const reflectionAgent = require('./scripts/reflection-agent.js');
reflectionAgent.schedule();
```

Or add to existing orchestrator startup if already structured that way.

---

## Phase

**Phase 3** — Full Committee + Dashboard

This is a Phase 3 feature. It should be deployed after:
- [ ] All agents are live and generating deliberations
- [ ] Trades are closing with `exit_time` populated
- [ ] At least 7 days of trade history exists in Supabase
