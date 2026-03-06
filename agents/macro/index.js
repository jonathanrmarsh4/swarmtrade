'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Macro Agent — zoomed-out economic and geopolitical analysis.
//
// Model: claude-sonnet-4-5 (via MODELS.macro from /config/models.js)
//
// Sets the risk ceiling for all other agents via the macro flag:
//   flag = true  → Orchestrator must apply 50% position size reduction system-wide
//   flag = false → No macro-level size constraint beyond the agent's regime signal
//
// Single-round agent — does not participate in the Bull/Bear debate.
//
// Output validated against AGENT_OUTPUT_SCHEMA.macro before being returned.
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const { MODELS, TOKEN_BUDGETS, AGENT_OUTPUT_SCHEMA } = require('../../config/models.js');
const { buildMacroPrompt } = require('./prompt.js');

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



// Valid regime values — 'unknown' is explicitly excluded and treated as a bug
const VALID_REGIMES = new Set(['risk-on', 'risk-off', 'neutral']);


// ── validateOutput ────────────────────────────────────────────────────────────
// Validates the parsed LLM response against AGENT_OUTPUT_SCHEMA.macro.
// Throws a descriptive error on any violation — never silently returns bad data.
//
// @param {object} parsed — raw JSON parsed from the LLM response
// @throws {Error} if validation fails
function validateOutput(parsed) {
  // Assert the schema key exists at import time
  void AGENT_OUTPUT_SCHEMA.macro;

  const errors = [];

  if (!VALID_REGIMES.has(parsed.regime)) {
    errors.push(`regime must be 'risk-on', 'risk-off', or 'neutral' — got: ${JSON.stringify(parsed.regime)}`);
  }

  if (typeof parsed.flag !== 'boolean') {
    errors.push(`flag must be a boolean, got: ${JSON.stringify(parsed.flag)}`);
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    errors.push('summary must be a non-empty string');
  }

  // Warn if summary exceeds 100 words but do not reject — log only
  if (typeof parsed.summary === 'string') {
    const wordCount = parsed.summary.trim().split(/\s+/).length;
    if (wordCount > 100) {
      console.warn(`[macro] summary exceeds 100-word limit (${wordCount} words) — Orchestrator will truncate if needed`);
    }
  }

  if (!Array.isArray(parsed.keyRisks) || parsed.keyRisks.length === 0) {
    errors.push('keyRisks must be a non-empty array of strings');
  } else if (parsed.keyRisks.some(r => typeof r !== 'string' || r.trim().length === 0)) {
    errors.push('every item in keyRisks must be a non-empty string');
  }

  if (errors.length > 0) {
    throw new Error(
      `[macro] Output validation failed against AGENT_OUTPUT_SCHEMA.macro:\n  ${errors.join('\n  ')}`
    );
  }
}


// ── callLLM ───────────────────────────────────────────────────────────────────
// Sends the system + user prompt to Anthropic and returns parsed JSON.
// Model and token budget are always sourced from config/models.js — never inline.
//
// @param {string} system — system prompt string
// @param {string} user   — user message string
// @returns {Promise<object>} — parsed JSON object from the LLM
// @throws {Error} if the API call fails or the response is not valid JSON
async function callLLM(system, user) {
  const raw = await callLLMWithRetry(system, user, MODELS.macro, TOKEN_BUDGETS.macro);

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
    throw new Error(`[macro] LLM returned non-JSON output:\n${raw}`);
  }

  return parsed;
}


// ── run ───────────────────────────────────────────────────────────────────────
// Main entry point called by the Orchestrator during Round 1.
//
// @param {object}   macroData
// @param {string}   macroData.currentDate               — ISO date string, e.g. '2025-11-01'
// @param {string}   macroData.assetPair                 — e.g. 'BTC/USDT'
// @param {string[]} macroData.recentNewsHeadlines        — array of recent news headline strings
// @param {number}   macroData.dxyValue                  — DXY index value, e.g. 104.3
// @param {number}   macroData.btcDominance              — BTC dominance %, e.g. 54.2
// @param {number}   macroData.fearGreedIndex            — 0-100 (0 = extreme fear, 100 = extreme greed)
// @param {object[]} macroData.upcomingEconomicEvents     — array of { name: string, date: string, impact?: string }
//
// @returns {Promise<{ regime: string, flag: boolean, summary: string, keyRisks: string[] }>}
// @throws {Error} if input validation fails, the LLM call fails, or schema validation fails
async function run(macroData) {
  // ── Input validation ────────────────────────────────────────────────────────
  const {
    currentDate,
    assetPair,
    recentNewsHeadlines,
    dxyValue,
    btcDominance,
    fearGreedIndex,
    upcomingEconomicEvents,
  } = macroData;

  if (typeof currentDate !== 'string' || currentDate.trim().length === 0) {
    throw new Error('[macro] macroData.currentDate must be a non-empty string');
  }
  if (typeof assetPair !== 'string' || assetPair.trim().length === 0) {
    throw new Error('[macro] macroData.assetPair must be a non-empty string');
  }
  if (!Array.isArray(recentNewsHeadlines)) {
    throw new Error('[macro] macroData.recentNewsHeadlines must be an array');
  }
  if (typeof dxyValue !== 'number' || isNaN(dxyValue)) {
    throw new Error('[macro] macroData.dxyValue must be a number');
  }
  if (typeof btcDominance !== 'number' || isNaN(btcDominance) || btcDominance < 0 || btcDominance > 100) {
    throw new Error('[macro] macroData.btcDominance must be a number between 0 and 100');
  }
  if (typeof fearGreedIndex !== 'number' || isNaN(fearGreedIndex) || fearGreedIndex < 0 || fearGreedIndex > 100) {
    throw new Error('[macro] macroData.fearGreedIndex must be a number between 0 and 100');
  }
  if (!Array.isArray(upcomingEconomicEvents)) {
    throw new Error('[macro] macroData.upcomingEconomicEvents must be an array');
  }

  console.log(
    `[macro] Analysis started — asset=${assetPair} date=${currentDate} ` +
    `dxy=${dxyValue.toFixed(2)} btcDom=${btcDominance.toFixed(1)}% fg=${fearGreedIndex}`
  );

  // ── Build prompt ────────────────────────────────────────────────────────────
  const { system, user } = buildMacroPrompt(macroData);

  // ── LLM call ────────────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = await callLLM(system, user);
  } catch (err) {
    console.error(`[macro] LLM call failed: ${err.message}`);
    throw err;
  }

  // ── Schema validation ────────────────────────────────────────────────────────
  // Regime must be one of the three explicit values. 'unknown' is a model
  // hallucination and must never propagate. Throw immediately so the Orchestrator
  // can log and retry — do not silently coerce invalid data into a valid-looking result.
  if (!VALID_REGIMES.has(parsed.regime)) {
    throw new Error(
      `[macro] LLM returned invalid regime '${parsed.regime}'. ` +
      `Valid values are: risk-on, risk-off, neutral. ` +
      `'unknown' is not a permitted classification — the model must always commit.`
    );
  }

  try {
    validateOutput(parsed);
  } catch (err) {
    console.error(err.message);
    throw err;
  }

  const result = {
    regime:   parsed.regime,
    flag:     parsed.flag,
    summary:  parsed.summary.trim(),
    keyRisks: parsed.keyRisks.map(r => r.trim()).filter(Boolean),
  };

  console.log(
    `[macro] Analysis complete — regime=${result.regime} flag=${result.flag} ` +
    `risks=${result.keyRisks.length} summary="${result.summary.slice(0, 80)}..."`
  );

  return result;
}


module.exports = { run };
