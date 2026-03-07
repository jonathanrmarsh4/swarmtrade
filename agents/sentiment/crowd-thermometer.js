'use strict';

/**
 * Crowd Thermometer — ambient sub-function of the Sentiment Agent.
 *
 * Polls the Fear & Greed Index, r/CryptoCurrency, and r/Bitcoin every 30 minutes.
 * Calls Claude Haiku (MODELS.sentiment) with the raw data to produce a
 * { score, summary, sources } snapshot that is written to sentiment_cache.
 *
 * The Orchestrator reads from sentiment_cache at deliberation time via
 * getSentimentSnapshot() in index.js — it never calls this module directly.
 *
 * If the LLM call fails, falls back to a deterministic score (Fear & Greed 70%,
 * Reddit ratio 30%) and a plain-text fallback summary so the polling loop
 * never goes dark.
 */

const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const { MODELS, TOKEN_BUDGETS } = require('../../config/models.js');
const { buildCrowdThermometerPrompt } = require('./prompt.js');
const { trackCall } = require('../../lib/cost-tracker');

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const FEAR_GREED_URL      = 'https://api.alternative.me/fng/?limit=1';
// Use old.reddit.com which returns JSON more reliably than www.reddit.com for server requests
const CRYPTO_REDDIT_URL   = 'https://old.reddit.com/r/CryptoCurrency/hot.json?limit=20&t=day';
const BITCOIN_REDDIT_URL  = 'https://old.reddit.com/r/Bitcoin/hot.json?limit=10&t=day';

// Keyword fallback for deterministic Reddit score (used only if LLM fails)
const BULLISH_TERMS = [
  'moon', 'pump', 'buy', 'bull', 'breakout', 'all-time high', 'ath',
  'surge', 'rally', 'adoption', 'partnership', 'launch', 'upgrade',
];
const BEARISH_TERMS = [
  'crash', 'dump', 'sell', 'bear', 'breakdown', 'drop', 'rekt',
  'collapse', 'hack', 'exploit', 'ban', 'lawsuit', 'fraud',
];

// ── Lazy clients ──────────────────────────────────────────────────────────────
// Initialised on first use so the module can be imported without env vars set.

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

// ── HTTP helper ───────────────────────────────────────────────────────────────
// Uses a realistic browser User-Agent to avoid bot-blocking from Reddit.
// Checks HTTP status before parsing so we get a clean error instead of
// "Unexpected token < ... is not valid JSON" when Reddit returns an HTML page.

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      },
      (res) => {
        // Reject early on non-2xx so we get a meaningful error, not a JSON parse failure.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // drain the response body
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) {
            reject(new Error(`JSON parse failed for ${url}: ${err.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after 10s`));
    });
  });
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchFearGreed() {
  const data  = await fetchJson(FEAR_GREED_URL);
  const entry = data?.data?.[0];
  if (!entry || entry.value == null) {
    throw new Error('[crowd-thermometer] Fear & Greed API returned unexpected shape');
  }
  return { value: parseInt(entry.value, 10), classification: entry.value_classification };
}

async function fetchRedditPosts(url) {
  const data  = await fetchJson(url);
  const items = data?.data?.children ?? [];
  return items
    .map((c) => ({
      title:       c.data?.title         ?? '',
      score:       c.data?.score         ?? 0,
      upvoteRatio: c.data?.upvote_ratio  ?? 0,
      numComments: c.data?.num_comments  ?? 0,
    }))
    .filter((p) => p.title.length > 0);
}

// ── Deterministic fallback score ──────────────────────────────────────────────
// Used only when the LLM call fails — keeps the cache from going stale.

function deterministicScore(fearGreedValue, cryptoPosts) {
  let bullish = 0;
  let bearish = 0;
  for (const p of cryptoPosts) {
    const t = p.title.toLowerCase();
    const isBull = BULLISH_TERMS.some((kw) => t.includes(kw));
    const isBear = BEARISH_TERMS.some((kw) => t.includes(kw));
    if (isBull && !isBear) bullish++;
    else if (isBear && !isBull) bearish++;
  }
  const total       = bullish + bearish;
  const redditScore = total > 0 ? Math.round((bullish / total) * 100) : 50;
  return Math.round(fearGreedValue * 0.7 + redditScore * 0.3);
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function poll() {
  console.log('[crowd-thermometer] Polling Fear & Greed + Reddit...');

  // Fear & Greed is the primary signal — abort the cycle if it fails
  let fearGreed;
  try {
    fearGreed = await fetchFearGreed();
  } catch (err) {
    console.error(`[crowd-thermometer] Fear & Greed fetch failed: ${err.message}`);
    return;
  }

  // Reddit fetches fail gracefully — empty arrays are valid LLM input
  let cryptoPosts = [];
  let bitcoinPosts = [];
  try {
    cryptoPosts = await fetchRedditPosts(CRYPTO_REDDIT_URL);
  } catch (err) {
    console.error(`[crowd-thermometer] r/CryptoCurrency fetch failed (continuing): ${err.message}`);
  }
  try {
    bitcoinPosts = await fetchRedditPosts(BITCOIN_REDDIT_URL);
  } catch (err) {
    console.error(`[crowd-thermometer] r/Bitcoin fetch failed (continuing): ${err.message}`);
  }

  // ── LLM scoring ─────────────────────────────────────────────────────────────
  let score;
  let summary;
  let sources = ['fear-greed-index'];
  if (cryptoPosts.length > 0) sources.push('reddit-cryptocurrency');
  if (bitcoinPosts.length > 0) sources.push('reddit-bitcoin');

  try {
    const { system, user } = buildCrowdThermometerPrompt(fearGreed, cryptoPosts, bitcoinPosts);
    const response = await getAnthropic().messages.create({
      model:      MODELS.sentiment,        // ← from config/models.js only
      max_tokens: TOKEN_BUDGETS.sentiment, // ← from config/models.js only
      system,
      messages: [{ role: 'user', content: user }],
    });
    await trackCall({ agent: 'crowd-thermometer', model: MODELS.sentiment, deliberationId: null, usage: response.usage });
    const raw   = response.content[0]?.text ?? '';
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(clean);

    if (typeof parsed.score !== 'number' || typeof parsed.summary !== 'string') {
      throw new Error('LLM response missing score or summary field');
    }

    score   = Math.max(0, Math.min(100, Math.round(parsed.score)));
    summary = parsed.summary.trim();
    if (Array.isArray(parsed.sources)) sources = parsed.sources;

    console.log(`[crowd-thermometer] LLM scored: ${score}/100`);
  } catch (err) {
    console.error(`[crowd-thermometer] LLM scoring failed — using deterministic fallback: ${err.message}`);
    score   = deterministicScore(fearGreed.value, cryptoPosts);
    summary = `Fear & Greed Index: ${fearGreed.value} (${fearGreed.classification}). Composite score: ${score}/100.`;
  }

  // ── Count raw Reddit stats for reference ────────────────────────────────────
  let redditBullish = 0;
  let redditBearish = 0;
  for (const p of [...cryptoPosts, ...bitcoinPosts]) {
    const t = p.title.toLowerCase();
    if (BULLISH_TERMS.some((kw) => t.includes(kw)) && !BEARISH_TERMS.some((kw) => t.includes(kw))) redditBullish++;
    else if (BEARISH_TERMS.some((kw) => t.includes(kw)) && !BULLISH_TERMS.some((kw) => t.includes(kw))) redditBearish++;
  }

  const row = {
    score,
    summary,
    fear_greed_value:     fearGreed.value,
    fear_greed_label:     fearGreed.classification,
    reddit_bullish:       redditBullish,
    reddit_bearish:       redditBearish,
    reddit_posts_sampled: cryptoPosts.length + bitcoinPosts.length,
    sources,
  };

  try {
    const { error } = await getSupabase().from('sentiment_cache').insert(row);
    if (error) throw error;
    console.log(
      `[crowd-thermometer] Wrote to sentiment_cache — score=${score} ` +
      `fear_greed=${fearGreed.value} (${fearGreed.classification})`,
    );
  } catch (err) {
    console.error(`[crowd-thermometer] Supabase write failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts the Crowd Thermometer polling loop.
 * Fires immediately on startup so data is available before the first deliberation,
 * then repeats every 30 minutes.
 * Called once by startSentimentAgents() in index.js.
 */
function start() {
  console.log('[crowd-thermometer] Starting — polling every 30 minutes');
  poll().catch((err) => console.error(`[crowd-thermometer] Initial poll error: ${err.message}`));
  setInterval(() => {
    poll().catch((err) => console.error(`[crowd-thermometer] Poll error: ${err.message}`));
  }, POLL_INTERVAL_MS);
}

module.exports = { start };
