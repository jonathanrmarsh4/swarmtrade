'use strict';

/**
 * News Sentinel — reactive sub-function of the Sentiment Agent.
 *
 * Polls CryptoPanic every 3 minutes for important crypto news.
 * For each unseen headline, asks MODELS.sentiment (Haiku): "is this market-moving?"
 * If yes → writes a row to news_sentinel_log with acknowledged=false.
 * The Orchestrator reads the interrupt state via getInterruptState() before
 * each deliberation and calls acknowledgeInterrupt() once it has acted.
 *
 * Exports:
 *   start()               — starts the cron poller (called once at boot)
 *   getInterruptState()   — returns newsInterrupt flag + latest unacknowledged headline
 *   acknowledgeInterrupt()— marks all unacknowledged rows as acknowledged
 */

const cron      = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const { MODELS, TOKEN_BUDGETS } = require('../../config/models.js');
const { buildNewsAssessmentPrompt } = require('./prompt.js');

// ── Constants ─────────────────────────────────────────────────────────────────

const CRYPTOPANIC_URL = 'https://cryptopanic.com/api/v1/posts/';

// Only posts CryptoPanic flags as "important" are sent to the LLM.
// This prevents burning Haiku tokens on routine market chatter.
const CRYPTOPANIC_FILTER = 'important';

// node-cron expression: every 3 minutes
const POLL_SCHEDULE = '*/3 * * * *';

// ── Lazy clients ──────────────────────────────────────────────────────────────
// Initialised on first use so the module can be imported without env vars set.
// This allows clean unit test imports and deferred validation.

let anthropic = null;
function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

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

// ── In-memory deduplication ───────────────────────────────────────────────────
// Prevents re-assessing the same CryptoPanic post across successive polls.
// Resets on service restart — acceptable given the 3-minute poll cadence.

const seenIds = new Set();

// ── CryptoPanic fetch ─────────────────────────────────────────────────────────

async function fetchCryptoPanicNews() {
  const url = new URL(CRYPTOPANIC_URL);
  url.searchParams.set('auth_token', process.env.CRYPTOPANIC_API_KEY);
  url.searchParams.set('filter', CRYPTOPANIC_FILTER);
  url.searchParams.set('public', 'true');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': 'CryptoQuant-Swarm/1.0 (news-sentinel)' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `[news-sentinel] CryptoPanic API returned ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return data.results ?? [];
}

// ── LLM assessment ────────────────────────────────────────────────────────────
// Asks MODELS.sentiment (Haiku) whether a headline is market-moving.
// Model and token budget always sourced from config/models.js — never inline.

async function assessHeadline(headline, source) {
  const { system, user } = buildNewsAssessmentPrompt(headline, source);

  const response = await getAnthropic().messages.create({
    model:      MODELS.sentiment,        // ← from config/models.js only
    max_tokens: TOKEN_BUDGETS.sentiment, // ← from config/models.js only
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw = response.content[0]?.text ?? '';

  let parsed;
  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(
      `[news-sentinel] LLM returned non-JSON for "${headline.slice(0, 60)}": ${raw}`,
    );
  }

  if (typeof parsed.isMarketMoving !== 'boolean') {
    throw new Error(
      `[news-sentinel] LLM response missing isMarketMoving for "${headline.slice(0, 60)}"`,
    );
  }

  return parsed;
}

// ── Interrupt writer ──────────────────────────────────────────────────────────
// Writes a market-moving headline to news_sentinel_log with acknowledged=false.

async function writeInterrupt(headline, url, direction, urgency, source, asset, rawPayload) {
  const { error } = await getSupabase()
    .from('news_sentinel_log')
    .insert({
      headline,
      url:         url ?? null,
      source,
      direction,
      urgency,
      asset:       asset ?? null,
      acknowledged: false,
      raw_payload:  rawPayload ?? null,
    });

  if (error) {
    console.error('[news-sentinel] Failed to write to news_sentinel_log:', error.message);
  } else {
    console.log(
      `[news-sentinel] INTERRUPT written — direction=${direction} urgency=${urgency} ` +
      `"${headline.slice(0, 80)}"`,
    );
  }
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function pollCycle() {
  console.log('[news-sentinel] Poll cycle started');

  let posts;
  try {
    posts = await fetchCryptoPanicNews();
  } catch (err) {
    console.error('[news-sentinel] CryptoPanic fetch failed — skipping cycle:', err.message);
    return;
  }

  if (posts.length === 0) {
    console.log('[news-sentinel] No posts returned — skipping cycle');
    return;
  }

  const newPosts = posts.filter((p) => p.id != null && !seenIds.has(String(p.id)));
  console.log(`[news-sentinel] ${posts.length} fetched, ${newPosts.length} new`);

  if (newPosts.length === 0) return;

  // Mark seen before LLM calls — prevents re-assessment if the cycle crashes mid-way
  for (const p of newPosts) seenIds.add(String(p.id));

  for (const post of newPosts) {
    const headline = post.title ?? '';
    const source   = post.source?.title ?? post.domain ?? 'Unknown';
    const asset    = post.currencies?.[0]?.code ?? null;
    const postUrl  = post.url ?? null;

    if (!headline.trim()) continue;

    let assessment;
    try {
      assessment = await assessHeadline(headline, source);
    } catch (err) {
      console.error(
        `[news-sentinel] Assessment failed for "${headline.slice(0, 60)}": ${err.message}`,
      );
      continue;
    }

    console.log(
      `[news-sentinel] assessed: isMarketMoving=${assessment.isMarketMoving} ` +
      `direction=${assessment.direction ?? 'n/a'} ` +
      `confidence=${assessment.confidence} — "${headline.slice(0, 60)}"`,
    );

    if (assessment.isMarketMoving && assessment.direction) {
      const urgency = assessment.confidence >= 0.8 ? 'high' : 'medium';
      await writeInterrupt(
        headline, postUrl, assessment.direction, urgency, source, asset, post,
      );
    }
  }
}

// ── Public: getInterruptState ─────────────────────────────────────────────────

/**
 * Returns the current interrupt state by reading the most recent unacknowledged
 * row from news_sentinel_log.
 *
 * Called by getSentimentSnapshot() in index.js before every deliberation.
 *
 * @returns {Promise<{
 *   newsInterrupt:      boolean,
 *   interruptHeadline:  string|null,
 *   interruptDirection: string|null,
 *   pendingCount:       number,
 * }>}
 */
async function getInterruptState() {
  const { data, error } = await getSupabase()
    .from('news_sentinel_log')
    .select('headline, direction, urgency, detected_at')
    .eq('acknowledged', false)
    .order('detected_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('[news-sentinel] Failed to read news_sentinel_log:', error.message);
    return { newsInterrupt: false, interruptHeadline: null, interruptDirection: null, pendingCount: 0 };
  }

  const rows = data ?? [];
  const latest = rows[0] ?? null;

  return {
    newsInterrupt:      rows.length > 0,
    interruptHeadline:  latest?.headline  ?? null,
    interruptDirection: latest?.direction ?? null,
    pendingCount:       rows.length,
  };
}

// ── Public: acknowledgeInterrupt ──────────────────────────────────────────────

/**
 * Marks all unacknowledged news_sentinel_log rows as acknowledged.
 * Called by the Orchestrator after it has processed the interrupt.
 *
 * @returns {Promise<void>}
 */
async function acknowledgeInterrupt() {
  const { error } = await getSupabase()
    .from('news_sentinel_log')
    .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
    .eq('acknowledged', false);

  if (error) {
    console.error('[news-sentinel] Failed to acknowledge log entries:', error.message);
  } else {
    console.log('[news-sentinel] Interrupt acknowledged — all pending rows stamped');
  }
}

// ── Public: start ─────────────────────────────────────────────────────────────

/**
 * Starts the News Sentinel cron poller.
 * Validates required env vars before scheduling — fails fast rather than
 * polling silently with a bad token.
 * Called once by startSentimentAgents() in index.js.
 */
function start() {
  if (!process.env.CRYPTOPANIC_API_KEY) {
    throw new Error(
      '[news-sentinel] CRYPTOPANIC_API_KEY is not set. ' +
      'Add it to Railway environment variables before starting.',
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('[news-sentinel] ANTHROPIC_API_KEY is not set.');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('[news-sentinel] SUPABASE_URL or SUPABASE_SERVICE_KEY is not set.');
  }

  console.log('[news-sentinel] Starting — polling CryptoPanic every 3 minutes');

  pollCycle().catch((err) => {
    console.error('[news-sentinel] Initial poll cycle failed:', err.message);
  });

  cron.schedule(POLL_SCHEDULE, () => {
    pollCycle().catch((err) => {
      console.error('[news-sentinel] Poll cycle error:', err.message);
    });
  });
}

module.exports = { start, getInterruptState, acknowledgeInterrupt };
