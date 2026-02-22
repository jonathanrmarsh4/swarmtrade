'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Quant Agent — hybrid: deterministic maths first, Haiku for output formatting.
//
// Two public functions:
//   calculateMetrics(historicalTrades)  — pure JS, zero LLM calls
//   formatOutput(metrics, signalData)   — Haiku wraps the numbers into schema shape
//
// Main entry point:
//   run(signalData, historicalTrades)   — chains both and returns validated output
//
// Output is validated against AGENT_OUTPUT_SCHEMA.quant before being returned.
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const { MODELS, TOKEN_BUDGETS, AGENT_OUTPUT_SCHEMA } = require('../../config/models.js');
const { buildQuantPrompt, buildSentimentCrossCheckPrompt } = require('./prompt.js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


// ── calculateMetrics ──────────────────────────────────────────────────────────
// Pure JavaScript — no LLM, no side effects.
//
// Reads the pnl_pct column from completed trades (rows where pnl_pct is not null).
// All return values use the same decimal-percentage unit as pnl_pct in the trades
// table (e.g. 0.042 represents 4.2%). sampleSize is an integer count.
//
// Sharpe ratio here is per-trade (mean return / std dev of returns), not annualised.
// This is appropriate for an agent working at the individual-trade level.
//
// @param {Array<object>} historicalTrades  — rows from Supabase `trades` table
// @param {number|null}   historicalTrades[].pnl_pct  — null for open trades
// @returns {{ winRate, avgWin, avgLoss, expectedValue, sharpeRatio, sampleSize }}
// @throws {Error} if input is invalid or no closed trades are available
function calculateMetrics(historicalTrades) {
  if (!Array.isArray(historicalTrades) || historicalTrades.length === 0) {
    throw new Error('Quant Agent: historicalTrades must be a non-empty array');
  }

  // Only closed trades carry a pnl_pct; open trades have null
  const closedTrades = historicalTrades.filter(t => t.pnl_pct != null);
  if (closedTrades.length === 0) {
    throw new Error('Quant Agent: no closed trades found — cannot compute metrics with zero sample size');
  }

  const returns    = closedTrades.map(t => Number(t.pnl_pct));
  const sampleSize = returns.length;

  const wins   = returns.filter(r => r > 0);
  const losses = returns.filter(r => r <= 0);

  const winRate  = wins.length / sampleSize;
  const avgWin   = wins.length   > 0 ? wins.reduce((s, r)   => s + r, 0) / wins.length   : 0;
  const avgLoss  = losses.length > 0 ? losses.reduce((s, r) => s + r, 0) / losses.length : 0;

  // Kelly-style expected value: probability-weighted average outcome
  const expectedValue = (winRate * avgWin) + ((1 - winRate) * avgLoss);

  // Per-trade Sharpe: mean / population std dev
  // A zero std dev (all identical returns) yields a Sharpe of 0 to avoid Infinity
  const mean     = returns.reduce((s, r) => s + r, 0) / sampleSize;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / sampleSize;
  const stdDev   = Math.sqrt(variance);
  const sharpeRatio = stdDev === 0 ? 0 : mean / stdDev;

  return {
    winRate:       parseFloat(winRate.toFixed(4)),
    avgWin:        parseFloat(avgWin.toFixed(6)),
    avgLoss:       parseFloat(avgLoss.toFixed(6)),
    expectedValue: parseFloat(expectedValue.toFixed(6)),
    sharpeRatio:   parseFloat(sharpeRatio.toFixed(4)),
    sampleSize,
  };
}


// ── validateOutput ────────────────────────────────────────────────────────────
// Checks the Haiku response against AGENT_OUTPUT_SCHEMA.quant.
// Throws a descriptive error on any violation.
// Returns a clean object with only the schema-required fields on success.
//
// @param {object} output
// @returns {{ expectedValue, winRate, avgWin, avgLoss, sampleSize, recommendation }}
function validateOutput(output) {
  // Reference the schema but derive rules from its documented types
  void AGENT_OUTPUT_SCHEMA.quant; // asserts the schema key exists at import time

  const errors = [];

  if (typeof output.expectedValue !== 'number') {
    errors.push('expectedValue must be a number');
  }
  if (typeof output.winRate !== 'number' || output.winRate < 0 || output.winRate > 1) {
    errors.push('winRate must be a number between 0 and 1');
  }
  if (typeof output.avgWin !== 'number') {
    errors.push('avgWin must be a number');
  }
  if (typeof output.avgLoss !== 'number') {
    errors.push('avgLoss must be a number');
  }
  if (typeof output.sampleSize !== 'number' || output.sampleSize < 0 || !Number.isInteger(output.sampleSize)) {
    errors.push('sampleSize must be a non-negative integer');
  }
  if (!['take', 'skip'].includes(output.recommendation)) {
    errors.push("recommendation must be 'take' or 'skip'");
  }

  if (errors.length > 0) {
    throw new Error(`Quant Agent: schema validation failed — ${errors.join('; ')}`);
  }

  return {
    expectedValue:  output.expectedValue,
    winRate:        output.winRate,
    avgWin:         output.avgWin,
    avgLoss:        output.avgLoss,
    sampleSize:     output.sampleSize,
    recommendation: output.recommendation,
  };
}


// ── formatOutput ──────────────────────────────────────────────────────────────
// Sends pre-computed metrics to Haiku for formatting into the required schema.
//
// Haiku's sole job is repacking numbers — it does not recalculate anything.
// After parsing, recommendation is overridden deterministically (EV > 0 → 'take')
// to guarantee correctness regardless of the LLM response.
//
// @param {object} metrics    — output of calculateMetrics()
// @param {object} signalData — row from the Supabase `signals` table
// @returns {Promise<{ expectedValue, winRate, avgWin, avgLoss, sampleSize, recommendation }>}
async function formatOutput(metrics, signalData) {
  const prompt = buildQuantPrompt(metrics, signalData);

  console.log(`[quant] Calling Haiku to format output — asset=${signalData.asset} ev=${metrics.expectedValue}`);

  const response = await anthropic.messages.create({
    model:      MODELS.quant,
    max_tokens: TOKEN_BUDGETS.quant,
    messages:   [{ role: 'user', content: prompt }],
  });

  const rawText = response.content[0].text.trim();

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Quant Agent: failed to parse Haiku response as JSON — ${err.message}\nRaw response: ${rawText}`);
  }

  // Deterministic override — EV rule is not delegated to the LLM
  parsed.recommendation = metrics.expectedValue > 0 ? 'take' : 'skip';

  const validated = validateOutput(parsed);

  console.log(`[quant] Output validated — ev=${validated.expectedValue} winRate=${validated.winRate} recommendation=${validated.recommendation}`);

  return validated;
}


// ── run ───────────────────────────────────────────────────────────────────────
// Main entry point called by the Orchestrator during Round 1.
//
// Returns the schema-validated output plus a `data` object carrying extra metrics
// (sharpeRatio, raw metrics) for storage in the deliberations.quant_data JSONB column.
//
// @param {object}        signalData        — row from signals table
// @param {Array<object>} historicalTrades  — rows from trades table (may include open trades)
// @returns {Promise<{ expectedValue, winRate, avgWin, avgLoss, sampleSize, recommendation, data }>}
async function run(signalData, historicalTrades) {
  console.log(`[quant] Round 1 analysis started — asset=${signalData.asset} direction=${signalData.direction}`);

  const metrics = calculateMetrics(historicalTrades);

  console.log(`[quant] Metrics computed — sampleSize=${metrics.sampleSize} ev=${metrics.expectedValue} sharpe=${metrics.sharpeRatio} winRate=${metrics.winRate}`);

  const output = await formatOutput(metrics, signalData);

  // Attach the full metrics as `data` for Orchestrator logging to quant_data JSONB
  return {
    ...output,
    data: {
      sharpeRatio: metrics.sharpeRatio,
      sampleSize:  metrics.sampleSize,
      winRate:     metrics.winRate,
      avgWin:      metrics.avgWin,
      avgLoss:     metrics.avgLoss,
      expectedValue: metrics.expectedValue,
    },
  };
}


// ── crossCheckSentiment ───────────────────────────────────────────────────────
// Round 2 only. Asks Haiku whether the Sentiment Agent's crowd-mood score is
// consistent with the statistical edge computed in Round 1.
//
// The LLM provides the explanatory note. Boolean fields are then overridden
// deterministically so unambiguous conflicts are always flagged:
//   - Greed (>65) + negative EV  → conflict (crowded longs against the edge)
//   - Extreme fear (<35) + positive EV → conflict (crowd scared despite real edge)
//
// @param {object} quantOutput     — validated Round 1 output from run()
// @param {number} sentimentScore  — Sentiment Agent's Round 1 score (0-100)
//
// @returns {Promise<{ consistent: boolean, conflictFlag: boolean, note: string }>}
async function crossCheckSentiment(quantOutput, sentimentScore) {
  if (typeof sentimentScore !== 'number' || sentimentScore < 0 || sentimentScore > 100) {
    throw new Error(
      `[quant] crossCheckSentiment requires a sentiment score 0-100, got: ${JSON.stringify(sentimentScore)}`
    );
  }

  console.log(
    `[quant] Sentiment cross-check starting — sentiment=${sentimentScore} ev=${quantOutput.expectedValue} recommendation=${quantOutput.recommendation}`
  );

  const prompt = buildSentimentCrossCheckPrompt(quantOutput, sentimentScore);

  let response;
  try {
    response = await anthropic.messages.create({
      model:      MODELS.quant,          // ← from config/models.js only
      max_tokens: TOKEN_BUDGETS.quant,   // ← from config/models.js only
      messages:   [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    throw new Error(`[quant] crossCheckSentiment — Anthropic API call failed: ${err.message}`);
  }

  const rawText = response.content[0]?.text?.trim() ?? '';

  let parsed;
  try {
    const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    throw new Error(
      `[quant] crossCheckSentiment — failed to parse Haiku response as JSON: ${err.message}\nRaw: ${rawText}`
    );
  }

  if (typeof parsed.note !== 'string' || parsed.note.trim().length === 0) {
    throw new Error('[quant] crossCheckSentiment — note must be a non-empty string');
  }

  // Deterministic override — flags unambiguous conflicts regardless of LLM interpretation.
  // Keeps the LLM's explanatory note but enforces correct boolean values.
  const hasConflict =
    (sentimentScore > 65 && quantOutput.expectedValue < 0) ||
    (sentimentScore < 35 && quantOutput.expectedValue > 0);

  const conflictFlag = hasConflict;
  const consistent   = !conflictFlag;

  console.log(
    `[quant] Sentiment cross-check complete — consistent=${consistent} conflictFlag=${conflictFlag}`
  );

  return {
    consistent,
    conflictFlag,
    note: parsed.note.trim(),
  };
}


module.exports = {
  calculateMetrics,
  formatOutput,
  run,
  crossCheckSentiment,
};
