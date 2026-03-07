'use strict';
// cost-tracker.js — LLM token & cost monitor
// Never throws — tracking failure is always non-fatal.

const { createClient } = require('@supabase/supabase-js');
const { MODEL_METADATA } = require('../config/models.js');

function costForTokens(model, inputTokens, outputTokens) {
  const meta = MODEL_METADATA[model] ?? {
    costPer1kInputTokens:  0.003,
    costPer1kOutputTokens: 0.015,
  };
  return (
    (inputTokens  / 1000) * meta.costPer1kInputTokens +
    (outputTokens / 1000) * meta.costPer1kOutputTokens
  );
}

let _supabase = null;
function db() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _supabase;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// trackCall — call immediately after every anthropic.messages.create()
// @param { agent, model, deliberationId?, usage } opts
async function trackCall({ agent, model, deliberationId = null, usage }) {
  if (!usage) return;
  const inputTokens  = usage.input_tokens  ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const costUsd      = costForTokens(model, inputTokens, outputTokens);

  db()
    .from('llm_calls')
    .insert({
      agent,
      model,
      deliberation_id: deliberationId,
      input_tokens:    inputTokens,
      output_tokens:   outputTokens,
      cost_usd:        parseFloat(costUsd.toFixed(8)),
      called_at:       new Date().toISOString(),
    })
    .then(({ error }) => {
      if (error) console.warn('[cost-tracker] Failed to log call:', error.message);
    })
    .catch(err => console.warn('[cost-tracker] DB error:', err.message));
}

// getDailySummary — aggregates last N days of LLM usage
async function getDailySummary(days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await db()
    .from('llm_calls')
    .select('agent, model, input_tokens, output_tokens, cost_usd, called_at')
    .gte('called_at', cutoff.toISOString())
    .order('called_at', { ascending: false });

  if (error) throw error;

  const byDay = {}, byAgent = {}, byModel = {};
  let totalCost = 0, totalCalls = 0;

  for (const row of (data ?? [])) {
    const day = row.called_at.slice(0, 10);

    if (!byDay[day]) byDay[day] = { date: day, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    byDay[day].calls++;
    byDay[day].inputTokens  += row.input_tokens;
    byDay[day].outputTokens += row.output_tokens;
    byDay[day].costUsd      += row.cost_usd;

    if (!byAgent[row.agent]) byAgent[row.agent] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    byAgent[row.agent].calls++;
    byAgent[row.agent].inputTokens  += row.input_tokens;
    byAgent[row.agent].outputTokens += row.output_tokens;
    byAgent[row.agent].costUsd      += row.cost_usd;

    if (!byModel[row.model]) byModel[row.model] = { calls: 0, costUsd: 0 };
    byModel[row.model].calls++;
    byModel[row.model].costUsd += row.cost_usd;

    totalCost  += row.cost_usd;
    totalCalls += 1;
  }

  const today = todayKey();
  const todayData = byDay[today] ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  return {
    today:      { ...todayData, date: today },
    byDay:      Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date)),
    byAgent:    Object.entries(byAgent).map(([agent, v]) => ({ agent, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    byModel:    Object.entries(byModel).map(([model, v]) => ({ model, ...v })),
    totals:     { calls: totalCalls, costUsd: parseFloat(totalCost.toFixed(6)) },
    periodDays: days,
  };
}

// checkBudget — call before each deliberation. Throws if hardStop=true and cap hit.
async function checkBudget() {
  let dailyCapUsd = 1.00;
  let hardStop    = false;
  try {
    const { data } = await db().from('system_config').select('value').eq('key', 'cost_limits').single();
    if (data?.value) {
      dailyCapUsd = data.value.dailyCapUsd ?? dailyCapUsd;
      hardStop    = data.value.hardStop    ?? hardStop;
    }
  } catch { /* use defaults */ }

  const today = todayKey();
  const { data: rows } = await db()
    .from('llm_calls').select('cost_usd').gte('called_at', `${today}T00:00:00Z`);

  const spentToday = (rows ?? []).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const withinBudget = spentToday < dailyCapUsd;

  if (!withinBudget) {
    const msg = `Daily budget cap hit: $${spentToday.toFixed(4)} / $${dailyCapUsd.toFixed(2)}`;
    console.error('[cost-tracker]', msg);
    if (hardStop) throw new Error(`[cost-tracker] ${msg} — deliberation blocked`);
    console.warn('[cost-tracker] Hard stop OFF — continuing past cap (soft warning)');
  }

  return { spentToday, dailyCapUsd, withinBudget };
}

module.exports = { trackCall, getDailySummary, checkBudget, costForTokens };
