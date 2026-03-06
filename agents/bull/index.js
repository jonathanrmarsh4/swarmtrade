'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { MODELS, TOKEN_BUDGETS, AGENT_OUTPUT_SCHEMA } = require('../../config/models.js');
const { buildRound1Prompt, buildRound2Prompt } = require('./prompt.js');

// ── Client ────────────────────────────────────────────────────────────────────
// Instantiated once at module load. API key sourced from Railway env only.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Retry helper ──────────────────────────────────────────────────────────────
// Retries the LLM call up to 3 times with exponential backoff on 529 overload.
async function callLLMWithRetry(system, user, model, maxTokens) {
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return response.content[0]?.text ?? '';
    } catch (err) {
      lastErr = err;
      const isOverload = err?.status === 529 || err?.message?.includes('overloaded');
      if (isOverload && attempt < MAX_RETRIES) {
        const waitMs = attempt * 10_000; // 10s, 20s
        console.warn(`[agent] API overloaded (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${waitMs/1000}s`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}



// ── Output validator ──────────────────────────────────────────────────────────
// Validates the parsed LLM response against AGENT_OUTPUT_SCHEMA.bull before
// anything is written to Supabase. Throws on invalid output — never silently swallow.
function validateOutput(parsed) {
  const schema = AGENT_OUTPUT_SCHEMA.bull;
  const errors = [];

  if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 100) {
    errors.push(`score must be a number 0-100, got: ${JSON.stringify(parsed.score)}`);
  }
  if (typeof parsed.thesis !== 'string' || parsed.thesis.trim().length === 0) {
    errors.push('thesis must be a non-empty string');
  }
  if (!parsed.data || typeof parsed.data !== 'object') {
    errors.push('data must be an object');
  }

  if (errors.length > 0) {
    throw new Error(
      `[bull] Output validation failed against AGENT_OUTPUT_SCHEMA.${Object.keys(schema).join('/')}:\n  ${errors.join('\n  ')}`
    );
  }
}

// ── LLM call ──────────────────────────────────────────────────────────────────
// Sends one prompt pair to the Anthropic API and returns the parsed JSON output.
// Model and token budget are always sourced from config/models.js — never inline.
async function callLLM(system, user) {
  const raw = await callLLMWithRetry(system, user, MODELS.bull, TOKEN_BUDGETS.bull);

  let parsed;
  try {
    // Extract JSON object robustly — handles markdown fences, trailing commentary,
    // and any other text the model wraps around the JSON.
    let clean = raw;
    // Try to find a JSON block inside markdown fences first
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      clean = fenceMatch[1].trim();
    } else {
      // Otherwise find the first { ... } block
      const start = raw.indexOf('{');
      const end   = raw.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        clean = raw.slice(start, end + 1);
      }
    }
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`[bull] LLM returned non-JSON output:\n${raw}`);
  }

  return parsed;
}

// ── Round 1: independent analysis ────────────────────────────────────────────
// Analyses the incoming signal independently, with no knowledge of other agents.
//
// @param {object} marketData
// @param {string} marketData.asset         — e.g. 'BTC/USDT'
// @param {number} marketData.currentPrice  — current asset price in USD
// @param {number} marketData.rsi           — RSI (0-100)
// @param {string} marketData.macdSignal    — 'bullish_crossover' | 'bearish_crossover' | 'neutral'
// @param {number} marketData.volume        — volume ratio vs average (e.g. 1.4 = 40% above avg)
// @param {string} marketData.direction     — 'long' | 'short' | 'close'
// @param {string} marketData.signalType    — e.g. 'MACD crossover'
// @param {string} marketData.timeframe     — e.g. '1h', '4h', '1d'
//
// @returns {Promise<{ score: number, thesis: string, data: object }>}
async function analyseRound1(marketData) {
  console.log(`[bull] Round 1 — analysing ${marketData.asset} @ $${marketData.currentPrice}`);

  const { system, user } = buildRound1Prompt(marketData);

  let parsed;
  try {
    parsed = await callLLM(system, user);
  } catch (err) {
    console.error(`[bull] Round 1 LLM call failed: ${err.message}`);
    throw err;
  }

  try {
    validateOutput(parsed);
  } catch (err) {
    console.error(err.message);
    throw err;
  }

  // Ensure score is an integer
  parsed.score = Math.round(parsed.score);

  console.log(`[bull] Round 1 complete — score=${parsed.score} thesis="${parsed.thesis.slice(0, 80)}..."`);

  return {
    score:  parsed.score,
    thesis: parsed.thesis,
    data:   parsed.data ?? {},
  };
}

// ── Round 2: rebuttal of Bear thesis ─────────────────────────────────────────
// Reads the Bear Agent's Round 1 thesis and submits a rebuttal.
// This round is mandatory — the Orchestrator must not skip it.
//
// @param {object} marketData  — same shape as Round 1
// @param {string} bearThesis  — Bear Agent's Round 1 thesis (read from Supabase)
//
// @returns {Promise<{ score: number, thesis: string, data: object }>}
async function analyseRound2(marketData, bearThesis) {
  if (!bearThesis || typeof bearThesis !== 'string' || bearThesis.trim().length === 0) {
    throw new Error('[bull] Round 2 requires a non-empty bearThesis. Bear Agent output must be written to Supabase before Round 2 begins.');
  }

  console.log(`[bull] Round 2 — rebutting Bear thesis for ${marketData.asset}`);

  const { system, user } = buildRound2Prompt(marketData, bearThesis);

  let parsed;
  try {
    parsed = await callLLM(system, user);
  } catch (err) {
    console.error(`[bull] Round 2 LLM call failed: ${err.message}`);
    throw err;
  }

  try {
    validateOutput(parsed);
  } catch (err) {
    console.error(err.message);
    throw err;
  }

  parsed.score = Math.round(parsed.score);

  console.log(`[bull] Round 2 complete — score=${parsed.score} thesis="${parsed.thesis.slice(0, 80)}..."`);

  return {
    score:  parsed.score,
    thesis: parsed.thesis,
    data:   parsed.data ?? {},
  };
}

module.exports = { analyseRound1, analyseRound2 };
