'use strict';

/**
 * Smoke test for getSentimentSnapshot() and startSentimentAgents().
 *
 * Run with:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/test-sentiment-snapshot.js
 *
 * What is tested (in order):
 *   STEP 1 — Module shape:        exports exist and have correct types (no credentials)
 *   STEP 2 — Empty tables:        newsInterrupt=false, score=50 neutral fallback
 *   STEP 3 — News interrupt ON:   insert unacknowledged news row → newsInterrupt=true,
 *                                  newsHeadline and newsDirection are populated
 *   STEP 4 — News interrupt OFF:  mark news row acknowledged → newsInterrupt=false
 *   STEP 5 — With crowd data:     insert sentiment_cache row → score and summary from cache
 *   STEP 6 — Output schema check: every field matches AGENT_OUTPUT_SCHEMA.sentiment
 *   STEP 7 — startSentimentAgents(): both sub-agents start without throwing
 *
 * Steps 2-6 require SUPABASE_URL and SUPABASE_SERVICE_KEY.
 * Steps 2-6 also require ANTHROPIC_API_KEY to be absent (the snapshot function
 * no longer calls the LLM — it reads the pre-generated summary from sentiment_cache).
 * All inserted rows are cleaned up at the end regardless of pass/fail.
 */

const DIVIDER = '─'.repeat(70);

function header(label) {
  console.log(`\n${DIVIDER}`);
  console.log(` ${label}`);
  console.log(DIVIDER);
}
function pass(msg)  { console.log(`  ✓  ${msg}`); }
function fail(msg)  { console.error(`  ✗  ${msg}`); process.exitCode = 1; }
function skip(msg)  { console.log(`  ─  SKIPPED: ${msg}`); }
function info(msg)  { console.log(`     ${msg}`); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertEq(label, actual, expected) {
  if (actual === expected) {
    pass(`${label}: ${JSON.stringify(actual)}`);
  } else {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertType(label, value, type) {
  if (typeof value === type) {
    pass(`${label} is ${type}`);
  } else {
    fail(`${label}: expected type ${type}, got ${typeof value} (value: ${JSON.stringify(value)})`);
  }
}

function assertArray(label, value) {
  if (Array.isArray(value)) {
    pass(`${label} is Array (length ${value.length})`);
  } else {
    fail(`${label}: expected Array, got ${typeof value}`);
  }
}

// ── DB helper ─────────────────────────────────────────────────────────────────

function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// IDs of rows we insert during this run — cleaned up in the finally block
const insertedCacheIds = [];
const insertedNewsIds  = [];

async function insertCacheRow(supabase, overrides = {}) {
  const row = {
    score:               72,
    summary:             'Greed is running high as the Fear & Greed Index hits 72. Reddit r/CryptoCurrency shows bullish momentum with limited capitulation talk. Proceed with caution — crowd euphoria historically precedes short-term pullbacks.',
    fear_greed_value:    72,
    fear_greed_label:    'Greed',
    reddit_bullish:      8,
    reddit_bearish:      3,
    reddit_posts_sampled: 20,
    sources:             ['fear-greed-index', 'reddit-cryptocurrency', 'reddit-bitcoin'],
    ...overrides,
  };
  const { data, error } = await supabase
    .from('sentiment_cache')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert sentiment_cache row: ${error.message}`);
  insertedCacheIds.push(data.id);
  return data.id;
}

async function insertNewsRow(supabase, overrides = {}) {
  const row = {
    headline:    'Major cryptocurrency exchange suffers $120M exploit — withdrawals halted',
    url:         'https://cryptopanic.com/news/test-exploit',
    source:      'cryptopanic',
    direction:   'bearish',
    urgency:     'high',
    asset:       'BTC',
    acknowledged: false,
    raw_payload:  { id: 'test-exploit-001', votes: { important: 42 } },
    ...overrides,
  };
  const { data, error } = await supabase
    .from('news_sentinel_log')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert news_sentinel_log row: ${error.message}`);
  insertedNewsIds.push(data.id);
  return data.id;
}

async function acknowledgeNewsRow(supabase) {
  // Mirrors what acknowledgeInterrupt() does — marks all unacknowledged rows
  const { error } = await supabase
    .from('news_sentinel_log')
    .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
    .eq('acknowledged', false);
  if (error) throw new Error(`Failed to acknowledge news rows: ${error.message}`);
}

async function cleanup(supabase) {
  if (insertedCacheIds.length > 0) {
    const { error } = await supabase
      .from('sentiment_cache')
      .delete()
      .in('id', insertedCacheIds);
    if (error) console.error(`[cleanup] sentiment_cache delete failed: ${error.message}`);
    else info(`Cleaned up ${insertedCacheIds.length} sentiment_cache row(s)`);
  }
  if (insertedNewsIds.length > 0) {
    const { error } = await supabase
      .from('news_sentinel_log')
      .delete()
      .in('id', insertedNewsIds);
    if (error) console.error(`[cleanup] news_sentinel_log delete failed: ${error.message}`);
    else info(`Cleaned up ${insertedNewsIds.length} news_sentinel_log row(s)`);
  }
}

// ── STEP 1: Module shape ──────────────────────────────────────────────────────

function testModuleShape() {
  header('STEP 1 — Module shape (no credentials required)');

  const sentiment = require('../agents/sentiment/index.js');

  assertType('getSentimentSnapshot', sentiment.getSentimentSnapshot, 'function');
  assertType('startSentimentAgents', sentiment.startSentimentAgents, 'function');

  // Confirm the schema definition itself is present and correct
  const { AGENT_OUTPUT_SCHEMA } = require('../config/models.js');
  const schema = AGENT_OUTPUT_SCHEMA.sentiment;

  if (schema && typeof schema.score === 'string') {
    pass('AGENT_OUTPUT_SCHEMA.sentiment.score defined');
  } else {
    fail('AGENT_OUTPUT_SCHEMA.sentiment.score missing');
  }
  if (schema && typeof schema.newsInterrupt === 'string') {
    pass('AGENT_OUTPUT_SCHEMA.sentiment.newsInterrupt defined');
  } else {
    fail('AGENT_OUTPUT_SCHEMA.sentiment.newsInterrupt missing');
  }
  if (schema && typeof schema.sources === 'string') {
    pass('AGENT_OUTPUT_SCHEMA.sentiment.sources defined');
  } else {
    fail('AGENT_OUTPUT_SCHEMA.sentiment.sources missing');
  }
}

// ── STEP 2: Empty tables → neutral fallback ───────────────────────────────────

async function testEmptyTables(supabase) {
  header('STEP 2 — Empty tables: neutral fallback (score=50, newsInterrupt=false)');

  // Delete any existing rows in both tables so we get the true empty-table behaviour
  await supabase.from('sentiment_cache').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('news_sentinel_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  const { getSentimentSnapshot } = require('../agents/sentiment/index.js');
  const result = await getSentimentSnapshot();

  info(`Result: ${JSON.stringify(result, null, 2).split('\n').join('\n     ')}`);

  assertEq('score',         result.score,         50);
  assertEq('newsInterrupt', result.newsInterrupt,  false);
  assertEq('newsHeadline',  result.newsHeadline,   '');
  assertEq('newsDirection', result.newsDirection,  '');
  assertType('summary', result.summary, 'string');
  if (result.summary.trim().length > 0) pass('summary is non-empty');
  else fail('summary is empty');
  assertArray('sources', result.sources);
}

// ── STEP 3: Unacknowledged news → newsInterrupt=true ──────────────────────────

async function testNewsInterruptTrue(supabase) {
  header('STEP 3 — Unacknowledged news row → newsInterrupt=true');

  const newsId = await insertNewsRow(supabase);
  info(`Inserted news_sentinel_log row id=${newsId} (acknowledged=false)`);

  const { getSentimentSnapshot } = require('../agents/sentiment/index.js');
  const result = await getSentimentSnapshot();

  info(`Result: ${JSON.stringify(result, null, 2).split('\n').join('\n     ')}`);

  assertEq('newsInterrupt',  result.newsInterrupt,  true);
  assertEq('newsHeadline',   result.newsHeadline,   'Major cryptocurrency exchange suffers $120M exploit — withdrawals halted');
  assertEq('newsDirection',  result.newsDirection,  'bearish');
  if (result.sources.includes('news-sentinel')) pass("sources includes 'news-sentinel'");
  else fail(`sources does not include 'news-sentinel': ${JSON.stringify(result.sources)}`);
}

// ── STEP 4: Acknowledge news → newsInterrupt=false ────────────────────────────

async function testNewsInterruptFalse(supabase) {
  header('STEP 4 — Acknowledge all news rows → newsInterrupt=false');

  await acknowledgeNewsRow(supabase);
  info('Marked all unacknowledged news_sentinel_log rows as acknowledged');

  const { getSentimentSnapshot } = require('../agents/sentiment/index.js');
  const result = await getSentimentSnapshot();

  info(`Result: ${JSON.stringify(result, null, 2).split('\n').join('\n     ')}`);

  assertEq('newsInterrupt',  result.newsInterrupt,  false);
  assertEq('newsHeadline',   result.newsHeadline,   '');
  assertEq('newsDirection',  result.newsDirection,  '');
  if (!result.sources.includes('news-sentinel')) pass("sources does not include 'news-sentinel'");
  else fail(`sources unexpectedly includes 'news-sentinel' after acknowledgement`);
}

// ── STEP 5: With crowd data → score and summary from cache ────────────────────

async function testWithCrowdData(supabase) {
  header('STEP 5 — With sentiment_cache data: score and summary read from cache');

  await insertCacheRow(supabase);
  info('Inserted sentiment_cache row — score=72, Greed, with pre-generated summary');

  const { getSentimentSnapshot } = require('../agents/sentiment/index.js');
  const result = await getSentimentSnapshot();

  info(`Result: ${JSON.stringify(result, null, 2).split('\n').join('\n     ')}`);

  assertEq('score',  result.score, 72);
  if (result.summary.length > 0) pass(`summary present (${result.summary.length} chars)`);
  else fail('summary is empty when cache row has a summary');
  if (result.sources.includes('fear-greed-index')) pass("sources includes 'fear-greed-index'");
  else fail(`sources missing 'fear-greed-index': ${JSON.stringify(result.sources)}`);
}

// ── STEP 6: Full schema check ─────────────────────────────────────────────────

async function testFullSchemaCheck(supabase) {
  header('STEP 6 — Full AGENT_OUTPUT_SCHEMA.sentiment shape check');

  // Insert both a cache row and a news row so all fields are exercised
  await insertCacheRow(supabase);
  const newsId = await insertNewsRow(supabase);

  const { getSentimentSnapshot } = require('../agents/sentiment/index.js');
  const result = await getSentimentSnapshot();

  info(`Result: ${JSON.stringify(result, null, 2).split('\n').join('\n     ')}`);

  // Required by AGENT_OUTPUT_SCHEMA.sentiment
  assertType('score',         result.score,         'number');
  assertType('summary',       result.summary,       'string');
  assertType('newsInterrupt', result.newsInterrupt, 'boolean');
  assertArray('sources',      result.sources);

  // score range
  if (result.score >= 0 && result.score <= 100) pass(`score in range [0,100]: ${result.score}`);
  else fail(`score out of range: ${result.score}`);

  // Extended fields present (not in schema minimum but required by the Orchestrator)
  assertType('newsHeadline',  result.newsHeadline,  'string');
  assertType('newsDirection', result.newsDirection, 'string');

  // No extra keys added accidentally
  const allowedKeys = ['score', 'summary', 'newsInterrupt', 'newsHeadline', 'newsDirection', 'sources'];
  const actualKeys  = Object.keys(result);
  const unexpectedKeys = actualKeys.filter((k) => !allowedKeys.includes(k));
  if (unexpectedKeys.length === 0) pass('No unexpected keys in output');
  else fail(`Unexpected keys in output: ${unexpectedKeys.join(', ')}`);
}

// ── STEP 7: startSentimentAgents() smoke ──────────────────────────────────────

function testStartSentimentAgents() {
  header('STEP 7 — startSentimentAgents() export present, News Sentinel validates env vars');

  const { startSentimentAgents, acknowledgeInterrupt } = require('../agents/sentiment/index.js');

  assertType('startSentimentAgents', startSentimentAgents, 'function');
  assertType('acknowledgeInterrupt', acknowledgeInterrupt, 'function');

  // startSentimentAgents() throws synchronously if required env vars are absent.
  // This is intentional — the service should fail fast at boot rather than poll silently.
  const hasAllEnv = !!(
    process.env.CRYPTOPANIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY   &&
    process.env.SUPABASE_URL        &&
    process.env.SUPABASE_SERVICE_KEY
  );

  if (hasAllEnv) {
    try {
      startSentimentAgents();
      pass('startSentimentAgents() started both polling loops without throwing');
      info('Crowd Thermometer: every 30 minutes | News Sentinel: every 3 minutes (cron)');
      info('Process will be force-exited after this step to prevent hanging on poll intervals.');
    } catch (err) {
      fail(`startSentimentAgents() threw unexpectedly: ${err.message}`);
    }
  } else {
    info('Not all env vars present — verifying that startSentimentAgents() throws with a clear message...');
    // It will throw on the first missing var; just confirm it doesn't crash silently
    try {
      startSentimentAgents();
      // If we get here, CRYPTOPANIC_API_KEY must be the missing var and it
      // somehow didn't throw — that's a bug in the validation logic
      fail('startSentimentAgents() should have thrown due to missing env vars but did not');
    } catch (err) {
      if (err.message.includes('not set')) {
        pass(`startSentimentAgents() threw with clear env-var error: "${err.message}"`);
      } else {
        fail(`startSentimentAgents() threw with unexpected error: ${err.message}`);
      }
    }
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\nSentiment Agent — getSentimentSnapshot() smoke test');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

  // Step 1 — no credentials needed
  try {
    testModuleShape();
  } catch (err) {
    fail(`Module shape test threw: ${err.message}`);
    process.exit(1);
  }

  // Steps 2-6 — require Supabase credentials
  if (!hasSupabase) {
    skip('Steps 2-6 require SUPABASE_URL and SUPABASE_SERVICE_KEY');
    skip('Set both env vars and re-run for full DB integration tests');
  } else {
    const supabase = getSupabase();
    try {
      await testEmptyTables(supabase);
    } catch (err) {
      fail(`Step 2 threw: ${err.message}`);
    }

    try {
      await testNewsInterruptTrue(supabase);
    } catch (err) {
      fail(`Step 3 threw: ${err.message}`);
    }

    // Step 4 doesn't need the news ID — it acknowledges all unacknowledged rows
    try {
      await testNewsInterruptFalse(supabase);
    } catch (err) {
      fail(`Step 4 threw: ${err.message}`);
    }

    try {
      await testWithCrowdData(supabase);
    } catch (err) {
      fail(`Step 5 threw: ${err.message}`);
    }

    try {
      await testFullSchemaCheck(supabase);
    } catch (err) {
      fail(`Step 6 threw: ${err.message}`);
    }

    // Cleanup — always runs, even if earlier steps failed
    header('CLEANUP');
    await cleanup(supabase);
  }

  // Step 7 — no credentials needed, but starts background loops
  testStartSentimentAgents();

  // Summary
  header('SUMMARY');
  const code = process.exitCode ?? 0;
  if (code === 0) {
    console.log('  All tests passed.\n');
  } else {
    console.log('  One or more tests FAILED. See ✗ lines above.\n');
  }

  console.log('  To run the full integration test:');
  console.log('    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/test-sentiment-snapshot.js');
  console.log('  Or on Railway:');
  console.log('    railway run node scripts/test-sentiment-snapshot.js\n');

  // Force exit because startSentimentAgents() registers setInterval handles
  process.exit(process.exitCode ?? 0);
})();
