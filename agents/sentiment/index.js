'use strict';

/**
 * Sentiment Agent — main entry point.
 *
 * Exports two public functions:
 *
 *   getSentimentSnapshot()
 *     Called by the Orchestrator during deliberation Round 1.
 *     Reads from sentiment_cache (score + LLM-generated summary written by the
 *     Crowd Thermometer) and news_sentinel_log (unacknowledged breaking news).
 *     Combines them into a validated response and returns it.
 *     Does NOT call the LLM and does NOT trigger new polling — both happen in
 *     the background via startSentimentAgents().
 *
 *   startSentimentAgents()
 *     Called once at application startup.
 *     Starts the Crowd Thermometer (30-min poll) and News Sentinel (2-min poll)
 *     background loops. Non-blocking.
 *
 * Model: claude-haiku-4-5-20251001 (via MODELS.sentiment in /config/models.js)
 * The LLM is called in crowd-thermometer.js, not here.
 */

const { createClient } = require('@supabase/supabase-js');
const { AGENT_OUTPUT_SCHEMA } = require('../../config/models.js');
const crowdThermometer           = require('./crowd-thermometer.js');
const { start: startNewsSentinel,
        getInterruptState,
        acknowledgeInterrupt } = require('./news-sentinel.js');

// ── Supabase client ───────────────────────────────────────────────────────────
// Lazily initialised so the module can be imported without env vars set.

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

// ── Output validator ──────────────────────────────────────────────────────────
// Validates the assembled snapshot against AGENT_OUTPUT_SCHEMA.sentiment.
// getSentimentSnapshot() also returns newsHeadline and newsDirection — these
// extend the base schema for the Orchestrator's news interrupt handling.

function validateOutput(output) {
  const errors = [];

  if (typeof output.score !== 'number' || output.score < 0 || output.score > 100) {
    errors.push(`score must be a number 0-100, got: ${JSON.stringify(output.score)}`);
  }
  if (typeof output.summary !== 'string' || output.summary.trim().length === 0) {
    errors.push('summary must be a non-empty string');
  }
  if (typeof output.newsInterrupt !== 'boolean') {
    errors.push(`newsInterrupt must be a boolean, got: ${JSON.stringify(output.newsInterrupt)}`);
  }
  if (!Array.isArray(output.sources)) {
    errors.push('sources must be an array');
  }

  if (errors.length > 0) {
    throw new Error(
      `[sentiment] Output validation failed against AGENT_OUTPUT_SCHEMA.sentiment:\n  ${errors.join('\n  ')}`,
    );
  }
}

// ── Supabase reads ────────────────────────────────────────────────────────────

async function readLatestCacheRow() {
  const { data, error } = await getSupabase()
    .from('sentiment_cache')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[sentiment] sentiment_cache read failed: ${error.message}`);
  return data; // null if table is empty
}

// ── getSentimentSnapshot ──────────────────────────────────────────────────────

/**
 * Called by the Orchestrator during deliberation Round 1.
 *
 * Reads from Supabase. Does NOT call the LLM and does NOT trigger polling.
 * The Crowd Thermometer's LLM call (crowd-thermometer.js) already produced and
 * cached the score and summary. This function assembles the final response by
 * combining the latest cache row with any unacknowledged breaking news.
 *
 * On degraded data (empty sentiment_cache), returns a neutral score of 50 and
 * a plain-text fallback summary so deliberation is never blocked.
 *
 * @returns {Promise<{
 *   score:         number,   // composite sentiment score 0-100, from crowd thermometer
 *   summary:       string,   // LLM-generated narrative, from crowd thermometer
 *   newsInterrupt: boolean,  // true if an unacknowledged breaking news row exists
 *   newsHeadline:  string,   // the breaking headline (empty string if none)
 *   newsDirection: string,   // 'bullish' | 'bearish' | 'neutral' (empty string if none)
 *   sources:       string[], // which data sources contributed to this snapshot
 * }>}
 */
async function getSentimentSnapshot() {
  console.log('[sentiment] getSentimentSnapshot() — reading from Supabase...');

  // ── Read crowd sentiment cache ──────────────────────────────────────────────
  let cacheRow = null;
  try {
    cacheRow = await readLatestCacheRow();
  } catch (err) {
    console.error(err.message);
    // Continue — degraded mode handled below
  }

  if (!cacheRow) {
    console.warn(
      '[sentiment] sentiment_cache is empty — Crowd Thermometer may not have run yet. ' +
      'Returning neutral score (50). Deliberation will proceed with degraded sentiment data.',
    );
  }

  // ── Read news interrupt state (via news-sentinel module) ────────────────────
  // getInterruptState() reads from news_sentinel_log — never throws, returns
  // safe defaults on DB error.
  let interrupt = { newsInterrupt: false, interruptHeadline: null, interruptDirection: null, pendingCount: 0 };
  try {
    interrupt = await getInterruptState();
  } catch (err) {
    console.error(`[sentiment] getInterruptState() failed: ${err.message}`);
  }

  // ── Score ───────────────────────────────────────────────────────────────────
  const score = cacheRow?.score ?? 50;

  // ── Summary ─────────────────────────────────────────────────────────────────
  // Primary: the LLM-generated narrative cached by crowd-thermometer.js.
  // Fallback: deterministic string so deliberation is never blocked.
  const summary = cacheRow?.summary
    ?? (cacheRow
      ? `Fear & Greed: ${cacheRow.fear_greed_value} (${cacheRow.fear_greed_label}). Composite score: ${score}/100.`
      : 'Sentiment data unavailable — Crowd Thermometer has not yet completed its first poll.');

  // ── Sources ─────────────────────────────────────────────────────────────────
  const sources = [];
  if (cacheRow) {
    const rawSources = cacheRow.sources;
    if (Array.isArray(rawSources)) {
      sources.push(...rawSources);
    } else if (typeof rawSources === 'string') {
      try { sources.push(...JSON.parse(rawSources)); } catch { sources.push('fear-greed-index'); }
    }
  }
  if (interrupt.newsInterrupt) sources.push('news-sentinel');

  // ── Assemble output ─────────────────────────────────────────────────────────
  const output = {
    score,
    summary,
    newsInterrupt: interrupt.newsInterrupt,
    newsHeadline:  interrupt.interruptHeadline  ?? '',
    newsDirection: interrupt.interruptDirection ?? '',
    sources,
  };

  // ── Validate against AGENT_OUTPUT_SCHEMA.sentiment ─────────────────────────
  // Hard error if minimum required fields fail — the Orchestrator must not
  // proceed with a malformed sentiment snapshot.
  try {
    validateOutput(output);
  } catch (err) {
    console.error(err.message);
    throw err;
  }

  console.log(
    `[sentiment] Snapshot ready — score=${score} newsInterrupt=${output.newsInterrupt} ` +
    `sources=[${sources.join(', ')}]`,
  );

  return output;
}

// ── startSentimentAgents ──────────────────────────────────────────────────────

/**
 * Starts both sub-agent polling loops.
 * Must be called exactly once at application startup (e.g. in the main server file).
 * Both loops are non-blocking — they run in the background via setInterval.
 * The Orchestrator does not call this; it only calls getSentimentSnapshot().
 */
function startSentimentAgents() {
  console.log('[sentiment] Starting sub-agents...');
  crowdThermometer.start();
  startNewsSentinel();
  console.log('[sentiment] Crowd Thermometer and News Sentinel are running.');
}

// acknowledgeInterrupt is re-exported so the Orchestrator imports everything
// from a single entry point rather than reaching into news-sentinel.js directly.
module.exports = { getSentimentSnapshot, startSentimentAgents, acknowledgeInterrupt };
