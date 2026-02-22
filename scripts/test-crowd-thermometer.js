'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Manual test runner for the Crowd Thermometer.
//
// Usage:
//   node scripts/test-crowd-thermometer.js
//
// What it tests (in order):
//   STEP 1 — Fear & Greed API fetch (no credentials required)
//   STEP 2 — Reddit API fetch       (no credentials required)
//   STEP 3 — Prompt builder output  (no credentials required)
//   STEP 4 — Full LLM scoring       (requires ANTHROPIC_API_KEY)
//   STEP 5 — Supabase write + read  (requires SUPABASE_URL + SUPABASE_SERVICE_KEY)
//
// Steps 4 and 5 are skipped with a clear message if the relevant env vars are missing.
// Run this locally to verify the fetch + prompt layers; run on Railway for the full test.
// ─────────────────────────────────────────────────────────────────────────────

const { buildCrowdThermometerPrompt } = require('../agents/sentiment/prompt.js');

const DIVIDER = '─'.repeat(70);

function header(label) {
  console.log(`\n${DIVIDER}`);
  console.log(` ${label}`);
  console.log(DIVIDER);
}

function pass(msg)  { console.log(`  ✓  ${msg}`); }
function fail(msg)  { console.error(`  ✗  ${msg}`); }
function skip(msg)  { console.log(`  ─  SKIPPED: ${msg}`); }
function info(msg)  { console.log(`     ${msg}`); }

// ── Step 1: Fear & Greed ──────────────────────────────────────────────────────
async function testFearAndGreed() {
  header('STEP 1 — Fear & Greed Index API');

  const response = await fetch('https://api.alternative.me/fng/?limit=1', {
    headers: { 'Accept': 'application/json' },
    signal:  AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json  = await response.json();
  const entry = json?.data?.[0];

  if (!entry || entry.value === undefined) {
    throw new Error('Unexpected response shape — data[0] missing');
  }

  const result = {
    value:          parseInt(entry.value, 10),
    classification: entry.value_classification,
    timestamp:      entry.timestamp,
  };

  pass(`Status: HTTP ${response.status}`);
  pass(`Value: ${result.value} — "${result.classification}"`);
  info(`Raw entry: ${JSON.stringify(entry)}`);

  return result;
}

// ── Step 2: Reddit ────────────────────────────────────────────────────────────
async function testReddit() {
  header('STEP 2 — Reddit public JSON API');

  const subreddits = [
    { name: 'cryptocurrency', limit: 10 },
    { name: 'bitcoin',        limit: 5  },
  ];

  const results = {};

  for (const { name, limit } of subreddits) {
    const url      = `https://www.reddit.com/r/${name}/hot.json?limit=${limit}`;
    const response = await fetch(url, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'CryptoQuant-SentimentAgent/1.0 (autonomous paper-trading system)',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`r/${name} returned HTTP ${response.status}`);
    }

    const json  = await response.json();
    const posts = (json?.data?.children ?? [])
      .map(c => ({
        title:       c.data?.title         ?? '',
        score:       c.data?.score         ?? 0,
        upvoteRatio: c.data?.upvote_ratio  ?? 0,
        numComments: c.data?.num_comments  ?? 0,
      }))
      .filter(p => p.title.length > 0);

    pass(`r/${name}: HTTP ${response.status} — ${posts.length} posts returned`);
    posts.slice(0, 3).forEach(p =>
      info(`  [score:${p.score}] ${p.title.slice(0, 75)}${p.title.length > 75 ? '…' : ''}`)
    );
    if (posts.length > 3) info(`  … and ${posts.length - 3} more`);

    results[name] = posts;
  }

  return results;
}

// ── Step 3: Prompt builder ────────────────────────────────────────────────────
async function testPromptBuilder(fearGreedData, redditResults) {
  header('STEP 3 — Prompt builder');

  const { system, user } = buildCrowdThermometerPrompt(
    fearGreedData,
    redditResults['cryptocurrency'],
    redditResults['bitcoin'],
  );

  if (typeof system !== 'string' || system.length === 0) {
    throw new Error('system prompt is empty');
  }
  if (typeof user !== 'string' || user.length === 0) {
    throw new Error('user message is empty');
  }

  pass(`System prompt: ${system.length} chars`);
  pass(`User message:  ${user.length} chars`);
  info('─── User message preview ───');
  user.split('\n').forEach(line => info(line));

  return { system, user };
}

// ── Step 4: LLM scoring ───────────────────────────────────────────────────────
async function testLLMScoring(system, user) {
  header('STEP 4 — LLM scoring via Claude Haiku (ANTHROPIC_API_KEY required)');

  if (!process.env.ANTHROPIC_API_KEY) {
    skip('ANTHROPIC_API_KEY not set — set it to test the full LLM call');
    return null;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const { MODELS, TOKEN_BUDGETS } = require('../config/models.js');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model:      MODELS.sentiment,
    max_tokens: TOKEN_BUDGETS.sentiment,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw   = response.content[0]?.text ?? '';
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(clean);

  pass(`Model:   ${response.model}`);
  pass(`Score:   ${parsed.score}`);
  pass(`Sources: ${JSON.stringify(parsed.sources)}`);
  pass(`Summary: ${parsed.summary.slice(0, 100)}${parsed.summary.length > 100 ? '…' : ''}`);
  info(`Tokens used — input: ${response.usage.input_tokens} output: ${response.usage.output_tokens}`);

  return parsed;
}

// ── Step 5: Supabase write + read ─────────────────────────────────────────────
async function testSupabase(scored, fearGreedValue) {
  header('STEP 5 — Supabase write + read (SUPABASE_URL + SUPABASE_SERVICE_KEY required)');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    skip('SUPABASE_URL or SUPABASE_SERVICE_KEY not set — set both to test the DB write');
    return;
  }

  if (!scored) {
    skip('No scored output from Step 4 — run with ANTHROPIC_API_KEY to enable this step');
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Write
  const { data: insertedRow, error: insertError } = await supabase
    .from('sentiment_cache')
    .insert({
      score:            Math.round(scored.score),
      summary:          scored.summary,
      sources:          scored.sources,
      fear_greed_value: fearGreedValue,
    })
    .select()
    .single();

  if (insertError) {
    throw new Error(`Insert failed: ${insertError.message}`);
  }

  pass(`Row written — id: ${insertedRow.id}`);
  pass(`recorded_at: ${insertedRow.recorded_at}`);

  // Read back the latest row
  const { data: latest, error: readError } = await supabase
    .from('sentiment_cache')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(1)
    .single();

  if (readError) {
    throw new Error(`Read back failed: ${readError.message}`);
  }

  if (latest.id !== insertedRow.id) {
    throw new Error(`Latest row id (${latest.id}) does not match inserted id (${insertedRow.id})`);
  }

  pass(`Read back confirmed — latest row id matches inserted row`);
  pass(`sentiment_cache has at least 1 row ✓`);
  info(`Full row: ${JSON.stringify(latest, null, 2).split('\n').join('\n     ')}`);
}

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\nCrowd Thermometer — manual test run');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  let fearGreedData, redditResults, promptOutput, scored;

  try {
    fearGreedData = await testFearAndGreed();
  } catch (err) {
    fail(`Fear & Greed fetch failed: ${err.message}`);
    process.exit(1);
  }

  try {
    redditResults = await testReddit();
  } catch (err) {
    fail(`Reddit fetch failed: ${err.message}`);
    process.exit(1);
  }

  try {
    promptOutput = await testPromptBuilder(fearGreedData, redditResults);
  } catch (err) {
    fail(`Prompt builder failed: ${err.message}`);
    process.exit(1);
  }

  try {
    scored = await testLLMScoring(promptOutput.system, promptOutput.user);
  } catch (err) {
    fail(`LLM scoring failed: ${err.message}`);
    process.exit(1);
  }

  try {
    await testSupabase(scored, fearGreedData.value);
  } catch (err) {
    fail(`Supabase test failed: ${err.message}`);
    process.exit(1);
  }

  header('SUMMARY');
  console.log('  Steps 1–3 require no credentials and always run.');
  console.log('  Steps 4–5 require ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY.');
  console.log('\n  To run the full test on Railway:');
  console.log('    railway run node scripts/test-crowd-thermometer.js\n');
})();
