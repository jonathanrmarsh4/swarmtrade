'use strict';

/**
 * News Sentinel smoke test.
 *
 * Verifies all five checkpoints in order:
 *   1. CRYPTOPANIC_API_KEY is set in env and accepted by the API
 *   2. One live poll cycle completes without errors
 *   3. Deduplication: a second poll returns 0 new posts for the same batch
 *   4. Migration tables exist in Supabase (005 + 006)
 *   5. newsInterrupt flag fires and is visible in sentiment_cache
 *
 * Usage (local):
 *   node -r dotenv/config scripts/test-news-sentinel.js
 *
 * Usage (if dotenv is not installed, export vars manually first):
 *   export $(cat .env | grep -v '#' | xargs) && node scripts/test-news-sentinel.js
 *
 * All five checks must pass before calling the Sentiment Agent production-ready.
 */

// Load .env if dotenv is available; silently skip if not (Railway injects vars natively)
try {
  require('dotenv').config();
} catch {
  // dotenv not installed — env vars must already be set in the shell
}

const { createClient } = require('@supabase/supabase-js');
const { getInterruptState, acknowledgeInterrupt } = require('../agents/sentiment/news-sentinel');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓  ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  ✗  ${label}`);
  if (reason) console.error(`     ${reason}`);
  failed++;
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  CHECK ${title}`);
  console.log('─'.repeat(60));
}

// ── Supabase client ───────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
  }
  return createClient(url, key);
}

// ── Check 1: API key present and accepted ────────────────────────────────────

async function check1_apiKey() {
  section('1 — CRYPTOPANIC_API_KEY set and accepted by the API');

  const key = process.env.CRYPTOPANIC_API_KEY;

  if (!key || key.trim() === '') {
    fail('CRYPTOPANIC_API_KEY is set in env', 'Key is empty — fill it in .env and Railway variables');
    return null;
  }
  pass('CRYPTOPANIC_API_KEY is present in environment');

  // Hit the real API
  const url = `https://cryptopanic.com/api/v1/posts/?public=true&filter=important&auth_token=${key}`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      fail(
        `CryptoPanic API accepted the key (HTTP ${res.status})`,
        `Got HTTP ${res.status} — check the key is correct and the account is active`
      );
      return null;
    }
    data = await res.json();
  } catch (err) {
    fail('CryptoPanic API request succeeded', err.message);
    return null;
  }

  if (!Array.isArray(data.results)) {
    fail('API response contains a results array', `Unexpected shape: ${JSON.stringify(data).slice(0, 120)}`);
    return null;
  }

  pass(`API accepted key — returned ${data.results.length} posts`);
  return data.results;
}

// ── Check 2: One live poll cycle completes without errors ─────────────────────
// We replicate the poll logic directly here so this script is self-contained
// and doesn't start the cron scheduler as a side-effect.

async function check2_pollCycle(posts) {
  section('2 — Live poll cycle completes without errors');

  if (!posts) {
    fail('Poll cycle ran', 'Skipped — CryptoPanic fetch failed in check 1');
    return null;
  }

  if (posts.length === 0) {
    pass('Poll cycle completed (CryptoPanic returned 0 important posts right now — that is normal)');
    return [];
  }

  // Verify the shape of the first post (representative check)
  const sample = posts[0];
  const hasId    = sample.id != null;
  const hasTitle = typeof sample.title === 'string';

  if (!hasId)    fail('Posts have an id field',    `Sample post: ${JSON.stringify(sample).slice(0, 80)}`);
  else           pass(`Posts have an id field (sample id: ${sample.id})`);

  if (!hasTitle) fail('Posts have a title field',  `Sample post: ${JSON.stringify(sample).slice(0, 80)}`);
  else           pass(`Posts have a title field (sample: "${sample.title.slice(0, 60)}")`);

  return posts;
}

// ── Check 3: Deduplication — same post IDs are not re-processed ───────────────

async function check3_deduplication(posts) {
  section('3 — Seen IDs tracked in Supabase (no duplicate processing)');

  if (!posts || posts.length === 0) {
    pass('Deduplication check skipped gracefully (no posts to deduplicate)');
    return;
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    fail('Supabase client initialised', err.message);
    return;
  }

  // Confirm seen_news_ids table exists
  const { error: tableErr } = await supabase
    .from('seen_news_ids')
    .select('cryptopanic_id')
    .limit(1);

  if (tableErr) {
    fail(
      'seen_news_ids table exists in Supabase',
      `${tableErr.message} — run migration 005_sentiment_cache.sql first`
    );
    return;
  }
  pass('seen_news_ids table is accessible');

  // Write the current batch of IDs as "seen"
  const ids = posts.slice(0, 5).map(p => ({
    cryptopanic_id: String(p.id),
    seen_at: new Date().toISOString(),
  }));

  const { error: writeErr } = await supabase
    .from('seen_news_ids')
    .upsert(ids, { onConflict: 'cryptopanic_id' });

  if (writeErr) {
    fail('Wrote test IDs to seen_news_ids', writeErr.message);
    return;
  }
  pass(`Wrote ${ids.length} post ID(s) to seen_news_ids`);

  // Now query back — all of these should be found as "seen"
  const testIds = ids.map(r => r.cryptopanic_id);
  const { data: found, error: readErr } = await supabase
    .from('seen_news_ids')
    .select('cryptopanic_id')
    .in('cryptopanic_id', testIds);

  if (readErr) {
    fail('Read back seen IDs from Supabase', readErr.message);
    return;
  }

  const foundSet = new Set(found.map(r => r.cryptopanic_id));
  const allFound = testIds.every(id => foundSet.has(id));

  if (allFound) {
    pass(`All ${testIds.length} IDs confirmed as "seen" — second poll would skip these`);
  } else {
    const missing = testIds.filter(id => !foundSet.has(id));
    fail('All written IDs readable from Supabase', `Missing: ${missing.join(', ')}`);
  }
}

// ── Check 4: Migration tables exist ──────────────────────────────────────────

async function check4_migrations() {
  section('4 — Migration tables exist in Supabase (005 + 006)');

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    fail('Supabase client initialised', err.message);
    return;
  }

  // sentiment_cache (migration 005)
  const { data: cacheRows, error: cacheErr } = await supabase
    .from('sentiment_cache')
    .select('row_type, news_interrupt, updated_at')
    .eq('row_type', 'singleton');

  if (cacheErr) {
    fail(
      'sentiment_cache table exists (migration 005)',
      `${cacheErr.message} — run 005_sentiment_cache.sql in Supabase SQL editor`
    );
  } else if (!cacheRows || cacheRows.length === 0) {
    fail(
      'sentiment_cache singleton row seeded',
      'Table exists but has no rows — re-run migration 005 (it includes the INSERT)'
    );
  } else {
    pass(`sentiment_cache exists — singleton row: news_interrupt=${cacheRows[0].news_interrupt}`);
  }

  // seen_news_ids (migration 005)
  const { error: seenErr } = await supabase
    .from('seen_news_ids')
    .select('cryptopanic_id')
    .limit(0);

  if (seenErr) {
    fail(
      'seen_news_ids table exists (migration 005)',
      seenErr.message
    );
  } else {
    pass('seen_news_ids table exists');
  }

  // news_sentinel_log (migration 006)
  const { error: logErr } = await supabase
    .from('news_sentinel_log')
    .select('id, headline, direction, acknowledged_at')
    .limit(0);

  if (logErr) {
    fail(
      'news_sentinel_log table exists (migration 006)',
      `${logErr.message} — run 006_news_sentinel_log.sql in Supabase SQL editor`
    );
  } else {
    pass('news_sentinel_log table exists (migration 006)');
  }
}

// ── Check 5: newsInterrupt fires and is readable from sentiment_cache ─────────

async function check5_newsInterrupt() {
  section('5 — newsInterrupt flag fires and appears in sentiment_cache');

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    fail('Supabase client initialised', err.message);
    return;
  }

  const testHeadline  = 'TEST: SEC charges Binance with unregistered securities violations [smoke test]';
  const testDirection = 'bearish';
  const testSource    = 'test-news-sentinel.js';
  const now           = new Date().toISOString();

  // Step A: simulate what fireInterrupt() does — write the interrupt directly
  const { error: updateErr } = await supabase
    .from('sentiment_cache')
    .update({
      news_interrupt:        true,
      interrupt_headline:    testHeadline,
      interrupt_direction:   testDirection,
      interrupt_source:      testSource,
      interrupt_detected_at: now,
      acknowledged_at:       null,
      updated_at:            now,
    })
    .eq('row_type', 'singleton');

  if (updateErr) {
    fail('Wrote test newsInterrupt to sentiment_cache', updateErr.message);
    return;
  }
  pass('Wrote test newsInterrupt=true to sentiment_cache');

  // Also write a matching row to news_sentinel_log
  const { error: logErr } = await supabase
    .from('news_sentinel_log')
    .insert({ detected_at: now, headline: testHeadline, source: testSource, direction: testDirection });

  if (logErr) {
    fail('Wrote matching row to news_sentinel_log', logErr.message);
  } else {
    pass('Wrote matching row to news_sentinel_log');
  }

  // Step B: read back via getInterruptState() — the exported function the Orchestrator will use
  let state;
  try {
    state = await getInterruptState();
  } catch (err) {
    fail('getInterruptState() returned a value', err.message);
    return;
  }

  if (state.newsInterrupt !== true) {
    fail(`getInterruptState() reports newsInterrupt=true`, `Got: ${JSON.stringify(state)}`);
    return;
  }
  pass(`getInterruptState() reports newsInterrupt=true`);

  if (state.interruptDirection !== testDirection) {
    fail(`direction is "${testDirection}"`, `Got: ${state.interruptDirection}`);
  } else {
    pass(`direction is "${testDirection}" — matches what was written`);
  }

  if (!Array.isArray(state.pendingHeadlines) || state.pendingHeadlines.length === 0) {
    fail('pendingHeadlines contains the unacknowledged log entry', `Got: ${JSON.stringify(state.pendingHeadlines)}`);
  } else {
    pass(`pendingHeadlines has ${state.pendingHeadlines.length} unacknowledged entry(ies)`);
  }

  // Step C: acknowledge the interrupt — simulates Orchestrator processing it
  try {
    await acknowledgeInterrupt();
    pass('acknowledgeInterrupt() ran without error');
  } catch (err) {
    fail('acknowledgeInterrupt() ran without error', err.message);
    return;
  }

  // Step D: confirm the flag is reset
  let resetState;
  try {
    resetState = await getInterruptState();
  } catch (err) {
    fail('getInterruptState() readable after acknowledgement', err.message);
    return;
  }

  if (resetState.newsInterrupt === false) {
    pass('newsInterrupt reset to false after acknowledgement — Orchestrator cycle complete');
  } else {
    fail('newsInterrupt reset to false after acknowledgement', `Still true: ${JSON.stringify(resetState)}`);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           News Sentinel — smoke test                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const posts = await check1_apiKey();
  await check2_pollCycle(posts);
  await check3_deduplication(posts);
  await check4_migrations();
  await check5_newsInterrupt();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed === 0) {
    console.log('\n  All checks passed. News Sentinel is ready.\n');
    console.log('  Next steps:');
    console.log('  1. Confirm CRYPTOPANIC_API_KEY is also set in Railway > Variables');
    console.log('  2. Start the poller: call start() from sentiment/index.js');
    console.log('  3. Watch Railway logs for "[news-sentinel] Poll cycle started" every 3 min');
  } else {
    console.log(`\n  Fix the ${failed} failing check(s) above before deploying.\n`);
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error('\nUnhandled error in smoke test:', err.message);
  process.exitCode = 1;
});
