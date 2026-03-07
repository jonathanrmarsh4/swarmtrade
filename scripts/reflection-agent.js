'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Reflection Agent — nightly job. Runs at 00:00 via node-cron.
// Reviews completed trade history in Supabase to evaluate each agent's predictive accuracy.
// Calculates dissent_correct_rate and overall_accuracy per agent for the past week.
// Updates the agent_reputation table with new scores and adjusts current_weight.
// These weights are read by the Orchestrator to calibrate vote influence over time.
//
// Uses MODELS.orchestrator (claude-sonnet-4-5) from /config/models.js for analysis.
// ─────────────────────────────────────────────────────────────────────────────

const cron             = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const Anthropic        = require('@anthropic-ai/sdk');
const { MODELS, TOKEN_BUDGETS } = require('../config/models.js');
const { trackCall } = require('../lib/cost-tracker');

// ── Supabase client ───────────────────────────────────────────────────────────

let supabase = null;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return supabase;
}

// ── Anthropic client ──────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Agent names (single source of truth for iteration) ────────────────────────

const AGENT_NAMES = ['bull', 'bear', 'quant', 'macro', 'sentiment'];

// ── Weight adjustment rules ───────────────────────────────────────────────────
// Weights are clamped between 0.5 and 1.5

const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 1.5;
const WEIGHT_INCREMENT = 0.1;
const WEIGHT_DECREMENT = 0.1;

// ── runWeeklyReflection ──────────────────────────────────────────────────────
// Main entry point for weekly reflection.
// Can be called manually or triggered by the cron schedule.
//
// Steps:
//   1. Gather last 7 days of closed trades with full deliberation context
//   2. For each agent, calculate this week's metrics:
//      - overallAccuracy: did high-confidence calls (score > 70) close profitably?
//      - dissentCorrectRate: when this agent had the minority view, was it right?
//   3. Send full summary to Sonnet with prompt for analysis
//   4. Update agent_reputation table with new metrics and adjust current_weight
//   5. Write full reflection summary to reflections table
//
// @returns {Promise<void>}
// @throws {Error} if any step fails

async function runWeeklyReflection() {
  console.log('[reflection-agent] Weekly reflection started...');

  const weekEnding = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // ── STEP 1: Gather last 7 days of closed trades ────────────────────────────

  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: trades, error: tradesError } = await getSupabase()
    .from('trades')
    .select(`
      id,
      entry_price,
      exit_price,
      entry_time,
      exit_time,
      pnl_pct,
      deliberation_id,
      deliberations (
        id,
        bull_score,
        bear_score,
        sentiment_score,
        quant_ev,
        macro_flag,
        final_decision,
        outcome
      )
    `)
    .not('exit_time', 'is', null)
    .gte('exit_time', cutoff)
    .order('exit_time', { ascending: false });

  if (tradesError) {
    throw new Error(`[reflection-agent] Failed to fetch trades: ${tradesError.message}`);
  }

  if (!trades || trades.length === 0) {
    console.log('[reflection-agent] No closed trades in the past 7 days. Skipping reflection.');
    return;
  }

  console.log(`[reflection-agent] Found ${trades.length} closed trades in the past 7 days.`);

  // ── STEP 2: Calculate per-agent metrics ─────────────────────────────────────

  const agentMetrics = {};

  for (const agentName of AGENT_NAMES) {
    agentMetrics[agentName] = {
      agentName,
      weekEnding,
      highConfidenceTrades: [],
      dissentTrades: [],
      overallAccuracy: 0,
      dissentCorrectRate: 0,
      currentWeight: 1.0,
      tradesSampled: 0,
    };
  }

  // Build data structures for analysis
  for (const trade of trades) {
    const delib = trade.deliberations;
    if (!delib) continue;

    const isProfitable = trade.pnl_pct > 0;

    // Bull Agent
    if (typeof delib.bull_score === 'number') {
      if (delib.bull_score > 70) {
        agentMetrics.bull.highConfidenceTrades.push({
          score: delib.bull_score,
          profitable: isProfitable,
          pnl_pct: trade.pnl_pct,
        });
      }
    }

    // Bear Agent
    if (typeof delib.bear_score === 'number') {
      if (delib.bear_score > 70) {
        agentMetrics.bear.highConfidenceTrades.push({
          score: delib.bear_score,
          profitable: !isProfitable, // Bear is bearish — profits when trade loses
          pnl_pct: -trade.pnl_pct,
        });
      }
    }

    // Sentiment Agent
    if (typeof delib.sentiment_score === 'number') {
      if (delib.sentiment_score > 70) {
        agentMetrics.sentiment.highConfidenceTrades.push({
          score: delib.sentiment_score,
          profitable: isProfitable,
          pnl_pct: trade.pnl_pct,
        });
      }
    }

    // Quant Agent (EV positive → bullish, EV negative → bearish)
    if (typeof delib.quant_ev === 'number') {
      const quantConfidence = Math.abs(delib.quant_ev) * 100;
      if (quantConfidence > 70) {
        const quantBullish = delib.quant_ev > 0;
        agentMetrics.quant.highConfidenceTrades.push({
          score: quantConfidence,
          profitable: quantBullish ? isProfitable : !isProfitable,
          pnl_pct: quantBullish ? trade.pnl_pct : -trade.pnl_pct,
        });
      }
    }

    // Macro Agent (flag = true → bearish/cautious)
    if (typeof delib.macro_flag === 'boolean') {
      const macroScore = delib.macro_flag ? 30 : 70;
      agentMetrics.macro.highConfidenceTrades.push({
        score: macroScore,
        profitable: delib.macro_flag ? !isProfitable : isProfitable,
        pnl_pct: delib.macro_flag ? -trade.pnl_pct : trade.pnl_pct,
      });
    }

    // Dissent detection — compare Bull vs Bear scores
    if (typeof delib.bull_score === 'number' && typeof delib.bear_score === 'number') {
      const bullBearDiff = Math.abs(delib.bull_score - delib.bear_score);
      if (bullBearDiff > 40) {
        const bullishView = delib.bull_score > delib.bear_score;
        const minorityAgent = bullishView ? 'bear' : 'bull';
        const minorityCorrect = bullishView ? !isProfitable : isProfitable;

        agentMetrics[minorityAgent].dissentTrades.push({
          correct: minorityCorrect,
          pnl_pct: minorityAgent === 'bull' ? trade.pnl_pct : -trade.pnl_pct,
        });
      }
    }
  }

  // Calculate accuracy rates
  for (const agentName of AGENT_NAMES) {
    const metrics = agentMetrics[agentName];

    if (metrics.highConfidenceTrades.length > 0) {
      const correctCount = metrics.highConfidenceTrades.filter(t => t.profitable).length;
      metrics.overallAccuracy = correctCount / metrics.highConfidenceTrades.length;
    }

    if (metrics.dissentTrades.length > 0) {
      const correctCount = metrics.dissentTrades.filter(t => t.correct).length;
      metrics.dissentCorrectRate = correctCount / metrics.dissentTrades.length;
    }

    metrics.tradesSampled = metrics.highConfidenceTrades.length;
  }

  console.log('[reflection-agent] Per-agent metrics calculated.');

  // ── STEP 3: Send summary to Sonnet for analysis ─────────────────────────────

  const prompt = buildReflectionPrompt(trades, agentMetrics);

  let sonnetAnalysis;
  try {
    const response = await anthropic.messages.create({
      model:      MODELS.orchestrator,
      max_tokens: TOKEN_BUDGETS.orchestrator,
      messages:   [{ role: 'user', content: prompt }],
    });
    await trackCall({ agent: 'reflection', model: response.model ?? 'claude-sonnet-4-5', deliberationId: null, usage: response.usage });

    sonnetAnalysis = response.content[0]?.text ?? '';
  } catch (err) {
    console.error(`[reflection-agent] Sonnet LLM call failed: ${err.message}`);
    throw err;
  }

  console.log('[reflection-agent] Sonnet analysis complete.');

  // ── STEP 4: Update agent_reputation table ───────────────────────────────────

  for (const agentName of AGENT_NAMES) {
    const metrics = agentMetrics[agentName];

    // Fetch previous week's weight to check for consecutive trends
    const { data: prevWeek } = await getSupabase()
      .from('agent_reputation')
      .select('current_weight, dissent_correct_rate, overall_accuracy, week_ending')
      .eq('agent_name', agentName)
      .order('week_ending', { ascending: false })
      .limit(1)
      .single();

    let newWeight = prevWeek?.current_weight ?? 1.0;

    // Weight adjustment logic
    if (metrics.dissentCorrectRate > 0.6 && prevWeek?.dissent_correct_rate > 0.6) {
      newWeight += WEIGHT_INCREMENT;
      console.log(`[reflection-agent] ${agentName}: dissent correct for 2+ weeks → weight +${WEIGHT_INCREMENT}`);
    }

    if (metrics.overallAccuracy < 0.4 && prevWeek?.overall_accuracy < 0.4) {
      newWeight -= WEIGHT_DECREMENT;
      console.log(`[reflection-agent] ${agentName}: accuracy < 40% for 2+ weeks → weight -${WEIGHT_DECREMENT}`);
    }

    // Clamp weight
    newWeight = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, newWeight));
    metrics.currentWeight = newWeight;

    // Upsert agent_reputation
    const { error: upsertError } = await getSupabase()
      .from('agent_reputation')
      .upsert({
        agent_name:          agentName,
        week_ending:         weekEnding,
        dissent_correct_rate: metrics.dissentCorrectRate,
        overall_accuracy:     metrics.overallAccuracy,
        current_weight:       newWeight,
        trades_sampled:       metrics.tradesSampled,
      }, {
        onConflict: 'agent_name,week_ending',
      });

    if (upsertError) {
      console.error(`[reflection-agent] Failed to upsert reputation for ${agentName}: ${upsertError.message}`);
    } else {
      console.log(
        `[reflection-agent] ${agentName}: accuracy=${(metrics.overallAccuracy * 100).toFixed(1)}% ` +
        `dissent=${(metrics.dissentCorrectRate * 100).toFixed(1)}% weight=${newWeight.toFixed(2)}`
      );
    }
  }

  // ── STEP 5: Write full reflection to reflections table ──────────────────────

  const bestAgent = AGENT_NAMES.reduce((best, name) =>
    agentMetrics[name].overallAccuracy > agentMetrics[best].overallAccuracy ? name : best
  );

  const worstAgent = AGENT_NAMES.reduce((worst, name) =>
    agentMetrics[name].overallAccuracy < agentMetrics[worst].overallAccuracy ? name : worst
  );

  const { error: reflectionError } = await getSupabase()
    .from('reflections')
    .insert({
      week_ending:        weekEnding,
      trades_analysed:    trades.length,
      best_agent:         bestAgent,
      worst_agent:        worstAgent,
      systematic_biases:  extractSection(sonnetAnalysis, 'systematic biases') ?? 'None identified',
      winning_patterns:   extractSection(sonnetAnalysis, 'winning') ?? 'None identified',
      losing_patterns:    extractSection(sonnetAnalysis, 'losing') ?? 'None identified',
      recommendation:     extractSection(sonnetAnalysis, 'recommendation') ?? 'Continue monitoring',
      full_summary:       sonnetAnalysis,
    });

  if (reflectionError) {
    console.error(`[reflection-agent] Failed to write reflection summary: ${reflectionError.message}`);
  } else {
    console.log('[reflection-agent] Reflection summary written to database.');
  }

  console.log('[reflection-agent] Weekly reflection complete.');
}


// ── buildReflectionPrompt ────────────────────────────────────────────────────
// Constructs the prompt for Sonnet to analyse the week's trade performance.
//
// @param {array}  trades        — array of trade objects with deliberation context
// @param {object} agentMetrics  — per-agent metrics calculated in Step 2
// @returns {string}             — formatted prompt for Sonnet

function buildReflectionPrompt(trades, agentMetrics) {
  let prompt = `You are reviewing the performance of a multi-agent trading committee.\n\n`;

  prompt += `## This Week's Trade Summary\n\n`;
  prompt += `Total closed trades: ${trades.length}\n`;
  prompt += `Profitable trades: ${trades.filter(t => t.pnl_pct > 0).length}\n`;
  prompt += `Unprofitable trades: ${trades.filter(t => t.pnl_pct <= 0).length}\n\n`;

  prompt += `## Per-Agent Performance\n\n`;

  for (const agentName of AGENT_NAMES) {
    const m = agentMetrics[agentName];
    prompt += `### ${agentName.toUpperCase()}\n`;
    prompt += `- Overall Accuracy (high-confidence calls): ${(m.overallAccuracy * 100).toFixed(1)}% (${m.highConfidenceTrades.length} trades)\n`;
    prompt += `- Dissent Correct Rate (minority views): ${(m.dissentCorrectRate * 100).toFixed(1)}% (${m.dissentTrades.length} trades)\n`;
    prompt += `- Current Weight: ${m.currentWeight.toFixed(2)}\n\n`;
  }

  prompt += `## Task\n\n`;
  prompt += `Identify:\n`;
  prompt += `1. Which agents showed the best signal quality this week?\n`;
  prompt += `2. Any systematic biases across the committee (e.g., over-optimism, poor timing, macro blind spots).\n`;
  prompt += `3. Patterns in winning vs losing trades (timeframes, volatility, sentiment conditions, macro regime).\n`;
  prompt += `4. One specific, actionable improvement recommendation for next week.\n\n`;

  prompt += `Respond in clear sections:\n`;
  prompt += `- **Best Agents**: ...\n`;
  prompt += `- **Systematic Biases**: ...\n`;
  prompt += `- **Winning Patterns**: ...\n`;
  prompt += `- **Losing Patterns**: ...\n`;
  prompt += `- **Recommendation**: ...\n`;

  return prompt;
}


// ── extractSection ────────────────────────────────────────────────────────────
// Extracts a specific section from Sonnet's markdown-formatted response.
// Used to populate individual columns in the reflections table.
//
// @param {string} text    — full Sonnet response
// @param {string} keyword — section keyword to search for (case-insensitive)
// @returns {string|null}  — extracted section text, or null if not found

function extractSection(text, keyword) {
  const lines = text.split('\n');
  let capturing = false;
  let result = [];

  for (const line of lines) {
    if (line.toLowerCase().includes(keyword)) {
      capturing = true;
      continue;
    }

    if (capturing) {
      if (line.startsWith('**') || line.startsWith('##')) {
        break;
      }
      result.push(line);
    }
  }

  const extracted = result.join('\n').trim();
  return extracted.length > 0 ? extracted : null;
}


// ── schedule ──────────────────────────────────────────────────────────────────
// Called once at application startup by root index.js.
// Schedules runWeeklyReflection() at midnight every day using a 5-part cron expression
// (node-cron default: minute hour day month weekday).
//
// NOTE: Runs nightly, but named "weekly" because it analyses the past 7 days.

function schedule() {
  cron.schedule('0 0 * * *', () => {
    runWeeklyReflection().catch(err => {
      console.error('[reflection-agent] Nightly run failed:', err.message);
    });
  });

  console.log('[reflection-agent] Scheduled to run nightly at 00:00.');
}


module.exports = { schedule, runWeeklyReflection };
