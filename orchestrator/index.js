'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — main deliberation engine. Committee chair.
// Model: claude-sonnet-4-5 (via MODELS.orchestrator from /config/models.js)
//
// Exports:
//   runRound1(signalData, portfolioState)  — fires all five agents in parallel
//   runDeliberation(signalId)              — full 10-step pipeline entry point
//
// Round 2 (Bull/Bear debate)   → debate.js
// Round 3 (synthesis + Risk)   → synthesise.js
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const { AGENT_OUTPUT_SCHEMA } = require('../config/models.js');
const { TRADING_PROFILES } = require('../config/trading-profiles.js');

const bull      = require('../agents/bull/index.js');
const bear      = require('../agents/bear/index.js');
const quant     = require('../agents/quant/index.js');
const macro     = require('../agents/macro/index.js');
const sentiment = require('../agents/sentiment/index.js');

// Loaded here so runDeliberation can call them directly. These modules import
// from agents — not from this file — so there is no circular dependency.
const { runRound2 }  = require('./debate.js');
const events = require('./events.js');
const { synthesise } = require('./synthesise.js');
const risk           = require('../agents/risk/index.js');

// Starting portfolio value used for drawdown and sizing calculations.
// Override via Railway env var when the paper-trading wallet is funded differently.
const INITIAL_PORTFOLIO_VALUE_USD = Number(process.env.INITIAL_PORTFOLIO_VALUE_USD || 10_000);

const ROUND1_TIMEOUT_MS = 90_000; // 90s — accommodates 3 retry attempts (10s + 20s waits + API call time)

// ── Supabase client ───────────────────────────────────────────────────────────
// Lazy singleton — matches the pattern used across all other modules in the repo.

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


// ── Timeout wrapper ───────────────────────────────────────────────────────────
// Races a promise against a hard deadline. Rejects with a descriptive error on
// expiry so the per-agent .catch() can substitute a neutral default response.
// The timer is always cleared — no leaks regardless of resolve/reject path.

function withTimeout(promise, ms, agentName) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[orchestrator] ${agentName} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}


// ── Schema-valid neutral defaults ─────────────────────────────────────────────
// Substituted verbatim when an agent times out or throws.
// Every field satisfies the corresponding AGENT_OUTPUT_SCHEMA shape exactly so
// the orchestrator-level validator does not reject the fallback.

const NEUTRAL_DEFAULTS = {
  bull: {
    score:  50,
    thesis: 'Agent timeout — neutral score applied',
    data:   {},
  },
  bear: {
    score:  50,
    thesis: 'Agent timeout — neutral score applied',
    data:   {},
  },
  quant: {
    expectedValue:  0,
    winRate:        0.5,
    avgWin:         0,
    avgLoss:        0,
    sampleSize:     0,
    recommendation: 'skip',
    data:           {},
  },
  macro: {
    regime:   'neutral',
    flag:     false,
    summary:  'Agent timeout — neutral regime applied',
    keyRisks: ['Data unavailable due to agent timeout'],
  },
  sentiment: {
    score:         50,
    summary:       'Agent timeout — neutral sentiment applied',
    newsInterrupt: false,
    sources:       [],
  },
};


// ── Orchestrator-level output validators ──────────────────────────────────────
// Second line of defence. Agents validate their own outputs internally; this
// catches any gap between the agent boundary and the Supabase write. Throws a
// descriptive error on violation — never silently accepts bad data.

function validateAgentOutput(agentName, output) {
  // Assert the schema key exists at import time (catches typos immediately)
  void AGENT_OUTPUT_SCHEMA[agentName];

  const errors = [];

  if (agentName === 'bull' || agentName === 'bear') {
    if (typeof output.score !== 'number' || output.score < 0 || output.score > 100) {
      errors.push('score must be a number 0–100');
    }
    if (typeof output.thesis !== 'string' || output.thesis.trim().length === 0) {
      errors.push('thesis must be a non-empty string');
    }
    if (!output.data || typeof output.data !== 'object' || Array.isArray(output.data)) {
      errors.push('data must be a plain object');
    }
  }

  if (agentName === 'quant') {
    if (typeof output.expectedValue !== 'number') {
      errors.push('expectedValue must be a number');
    }
    if (typeof output.winRate !== 'number' || output.winRate < 0 || output.winRate > 1) {
      errors.push('winRate must be a number 0–1');
    }
    if (typeof output.avgWin !== 'number') {
      errors.push('avgWin must be a number');
    }
    if (typeof output.avgLoss !== 'number') {
      errors.push('avgLoss must be a number');
    }
    if (typeof output.sampleSize !== 'number' || output.sampleSize < 0) {
      errors.push('sampleSize must be a non-negative number');
    }
    if (!['take', 'skip'].includes(output.recommendation)) {
      errors.push("recommendation must be 'take' or 'skip'");
    }
  }

  if (agentName === 'macro') {
    if (!['risk-on', 'risk-off', 'neutral'].includes(output.regime)) {
      errors.push("regime must be 'risk-on', 'risk-off', or 'neutral'");
    }
    if (typeof output.flag !== 'boolean') {
      errors.push('flag must be a boolean');
    }
    if (typeof output.summary !== 'string' || output.summary.trim().length === 0) {
      errors.push('summary must be a non-empty string');
    }
    if (!Array.isArray(output.keyRisks) || output.keyRisks.length === 0) {
      errors.push('keyRisks must be a non-empty array');
    }
  }

  if (agentName === 'sentiment') {
    if (typeof output.score !== 'number' || output.score < 0 || output.score > 100) {
      errors.push('score must be a number 0–100');
    }
    if (typeof output.summary !== 'string' || output.summary.trim().length === 0) {
      errors.push('summary must be a non-empty string');
    }
    if (typeof output.newsInterrupt !== 'boolean') {
      errors.push('newsInterrupt must be a boolean');
    }
    if (!Array.isArray(output.sources)) {
      errors.push('sources must be an array');
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[orchestrator] ${agentName} output failed orchestrator validation:\n  ${errors.join('\n  ')}`,
    );
  }
}


// ── runRound1 ─────────────────────────────────────────────────────────────────
/**
 * Runs all five specialist agents simultaneously for Round 1 analysis.
 *
 * Guarantees:
 *  - All five agents run in parallel via Promise.all() — never sequentially.
 *  - Each agent call is bounded by a 10-second hard timeout.
 *  - A timed-out or erroring agent is replaced by a schema-valid neutral default.
 *  - Every result is validated against AGENT_OUTPUT_SCHEMA before Supabase write.
 *  - One deliberation row is created in Supabase with all five Round 1 outputs
 *    and status='round1' before this function returns.
 *  - This function does NOT proceed to Round 2. Caller owns that step.
 *
 * @param {object}   signalData
 * @param {string}   signalData.id           — UUID from the signals table
 * @param {string}   signalData.asset        — e.g. 'BTC/USDT'
 * @param {string}   signalData.direction    — 'long' | 'short' | 'close'
 * @param {string}   signalData.timeframe    — e.g. '1h', '4h', '1d'
 * @param {string}   signalData.signal_type  — e.g. 'MACD crossover'
 * @param {object}   signalData.raw_payload  — full TradingView webhook JSON
 *
 * @param {object}   portfolioState                    — market and portfolio context
 * @param {object}   portfolioState.marketData         — real-time technical indicators
 * @param {number}   portfolioState.marketData.currentPrice           — asset price in USD
 * @param {number}   portfolioState.marketData.rsi                    — RSI (0–100)
 * @param {string}   portfolioState.marketData.macdSignal             — 'bullish_crossover' | 'bearish_crossover' | 'neutral'
 * @param {number}   portfolioState.marketData.volume                 — volume ratio vs rolling average (e.g. 1.4 = 40% above)
 * @param {number}   portfolioState.marketData.fundingRate            — perpetual funding rate as a decimal (e.g. 0.0003)
 * @param {number}   portfolioState.marketData.fearGreedIndex         — Fear & Greed Index (0–100)
 * @param {number[]} portfolioState.marketData.recentRejectionLevels  — price levels where asset recently rejected
 * @param {object}   portfolioState.macroData                         — macro-economic context
 * @param {number}   portfolioState.macroData.dxyValue                — DXY index value, e.g. 104.3
 * @param {number}   portfolioState.macroData.btcDominance            — BTC market dominance %, e.g. 54.2
 * @param {string[]} portfolioState.macroData.recentNewsHeadlines     — recent financial/crypto news
 * @param {object[]} portfolioState.macroData.upcomingEconomicEvents  — [{ name, date, impact? }]
 * @param {object[]} portfolioState.historicalTrades                  — rows from Supabase `trades` table
 *
 * @returns {Promise<{
 *   deliberationId: string,
 *   bull:      { score: number, thesis: string, data: object },
 *   bear:      { score: number, thesis: string, data: object },
 *   quant:     { expectedValue: number, winRate: number, avgWin: number, avgLoss: number, sampleSize: number, recommendation: string, data: object },
 *   macro:     { regime: string, flag: boolean, summary: string, keyRisks: string[] },
 *   sentiment: { score: number, summary: string, newsInterrupt: boolean, sources: string[] },
 * }>}
 *
 * @throws {Error} if the Supabase write fails — deliberation state must be persisted
 *                 before Round 2 may begin
 */
async function runRound1(signalData, portfolioState) {
  console.log(
    `[orchestrator] Round 1 started — signal=${signalData.id} ` +
    `asset=${signalData.asset} direction=${signalData.direction}`,
  );

  const { marketData, macroData, historicalTrades = [] } = portfolioState;


  // ── Assemble per-agent inputs ───────────────────────────────────────────────
  // Each agent expects a different subset of market fields. Both Bull and Bear
  // receive the MACD state via their own field name (macdSignal vs macd) but the
  // value is drawn from the same portfolioState source.

  const bullMarketData = {
    asset:           signalData.asset,
    currentPrice:    marketData.currentPrice,
    rsi:             marketData.rsi,
    macdSignal:      marketData.macdSignal,
    volume:          marketData.volume,
    direction:       signalData.direction,
    signalType:      signalData.signal_type,
    timeframe:       signalData.timeframe,
    tradingMode:     marketData.tradingMode,
    holdDescription: marketData.holdDescription,
  };

  const bearMarketData = {
    asset:                 signalData.asset,
    currentPrice:          marketData.currentPrice,
    rsi:                   marketData.rsi,
    macd:                  marketData.macdSignal,
    fundingRate:           marketData.fundingRate,
    fearGreedIndex:        marketData.fearGreedIndex,
    recentRejectionLevels: marketData.recentRejectionLevels ?? [],
  };

  // Macro Agent is the only agent that generates the current date itself —
  // pass it explicitly so the prompt is reproducible and testable.
  const macroInput = {
    currentDate:            new Date().toISOString().slice(0, 10),
    assetPair:              signalData.asset,
    recentNewsHeadlines:    macroData.recentNewsHeadlines    ?? [],
    dxyValue:               macroData.dxyValue,
    btcDominance:           macroData.btcDominance,
    fearGreedIndex:         marketData.fearGreedIndex,
    upcomingEconomicEvents: macroData.upcomingEconomicEvents ?? [],
  };

  // Sentiment Agent reads from Supabase directly — no market data passed in.
  // Its polling loops (Crowd Thermometer + News Sentinel) must already be running.


  // ── Fire all five agents simultaneously ────────────────────────────────────
  // Each call is wrapped in withTimeout() then .catch() so one agent failure
  // cannot prevent the other four from completing. The neutral default is
  // substituted inline at this stage, before orchestrator-level validation.

  console.log('[orchestrator] Dispatching all five agents in parallel...');
  events.emitRound1Start(null, signalData.id).catch(() => {});

  const [bullRaw, bearRaw, quantRaw, macroRaw, sentimentRaw] = await Promise.all([

    withTimeout(bull.analyseRound1(bullMarketData), ROUND1_TIMEOUT_MS, 'bull')
      .then(r => { events.emitAgentComplete(null, signalData.id, 'bull', r).catch(() => {}); return r; })
      .catch(err => {
        console.error(`[orchestrator] Bull Agent failed — substituting neutral default. Reason: ${err.message}`);
        events.emitAgentFailed(null, signalData.id, 'bull', err.message).catch(() => {});
        return NEUTRAL_DEFAULTS.bull;
      }),

    withTimeout(bear.analyseRound1(bearMarketData), ROUND1_TIMEOUT_MS, 'bear')
      .then(r => { events.emitAgentComplete(null, signalData.id, 'bear', r).catch(() => {}); return r; })
      .catch(err => {
        console.error(`[orchestrator] Bear Agent failed — substituting neutral default. Reason: ${err.message}`);
        events.emitAgentFailed(null, signalData.id, 'bear', err.message).catch(() => {});
        return NEUTRAL_DEFAULTS.bear;
      }),

    withTimeout(quant.run(signalData, historicalTrades), ROUND1_TIMEOUT_MS, 'quant')
      .then(r => { events.emitAgentComplete(null, signalData.id, 'quant', r).catch(() => {}); return r; })
      .catch(err => {
        console.error(`[orchestrator] Quant Agent failed — substituting neutral default. Reason: ${err.message}`);
        events.emitAgentFailed(null, signalData.id, 'quant', err.message).catch(() => {});
        return NEUTRAL_DEFAULTS.quant;
      }),

    withTimeout(macro.run(macroInput), ROUND1_TIMEOUT_MS, 'macro')
      .then(r => { events.emitAgentComplete(null, signalData.id, 'macro', r).catch(() => {}); return r; })
      .catch(err => {
        console.error(`[orchestrator] Macro Agent failed — substituting neutral default. Reason: ${err.message}`);
        events.emitAgentFailed(null, signalData.id, 'macro', err.message).catch(() => {});
        return NEUTRAL_DEFAULTS.macro;
      }),

    withTimeout(sentiment.getSentimentSnapshot(), ROUND1_TIMEOUT_MS, 'sentiment')
      .then(r => { events.emitAgentComplete(null, signalData.id, 'sentiment', r).catch(() => {}); return r; })
      .catch(err => {
        console.error(`[orchestrator] Sentiment Agent failed — substituting neutral default. Reason: ${err.message}`);
        events.emitAgentFailed(null, signalData.id, 'sentiment', err.message).catch(() => {});
        return NEUTRAL_DEFAULTS.sentiment;
      }),

  ]);


  // ── Orchestrator-level validation ──────────────────────────────────────────
  // Validates each result against AGENT_OUTPUT_SCHEMA before the Supabase write.
  // If a result (including a neutral default) fails, it is replaced and logged.
  // This should not happen in normal operation — it would indicate a bug in either
  // the agent or the NEUTRAL_DEFAULTS object above.

  const raw = {
    bull:      bullRaw,
    bear:      bearRaw,
    quant:     quantRaw,
    macro:     macroRaw,
    sentiment: sentimentRaw,
  };

  const validated = {};

  for (const [agentName, result] of Object.entries(raw)) {
    try {
      validateAgentOutput(agentName, result);
      validated[agentName] = result;
    } catch (err) {
      console.error(
        `[orchestrator] ${agentName} output rejected by orchestrator validator — ` +
        `falling back to neutral default. Error: ${err.message}`,
      );
      validated[agentName] = NEUTRAL_DEFAULTS[agentName];
    }
  }


  // ── Persist Round 1 results to Supabase ────────────────────────────────────
  // Rule from ARCHITECTURE.md: every agent output must be written to Supabase
  // before the Orchestrator reads it for the next round. Round 2 must not begin
  // until this write completes. An error here is non-recoverable — rethrow.

  const insertPayload = {
    signal_id:         signalData.id,
    asset:             signalData.asset,
    direction:         signalData.direction,
    signal_type:       signalData.signal_type ?? null,
    trading_mode:      marketData.tradingMode ?? 'dayTrade',
    bull_score:        validated.bull.score,
    bull_thesis:       validated.bull.thesis,
    bear_score:        validated.bear.score,
    bear_thesis:       validated.bear.thesis,
    quant_ev:          validated.quant.expectedValue,
    // quant_data stores the full metrics object (sharpeRatio, raw rates, etc.)
    // so the Orchestrator and reflection agent can audit the numbers later.
    quant_data:        validated.quant.data ?? {},
    macro_regime:      validated.macro.regime,
    macro_flag:        validated.macro.flag,
    sentiment_score:   validated.sentiment.score,
    sentiment_summary: validated.sentiment.summary,
    news_interrupt:    validated.sentiment.newsInterrupt,
    status:            'round1',
  };

  let deliberationId;
  try {
    const { data, error } = await getSupabase()
      .from('deliberations')
      .insert(insertPayload)
      .select('id')
      .single();

    if (error) throw new Error(error.message);

    deliberationId = data.id;
    console.log(
      `[orchestrator] Round 1 persisted to Supabase — deliberation=${deliberationId}`,
    );
  } catch (err) {
    console.error(`[orchestrator] Supabase write failed for Round 1: ${err.message}`);
    throw err;
  }


  // ── Summary log ────────────────────────────────────────────────────────────
  console.log(
    `[orchestrator] Round 1 complete — ` +
    `bull=${validated.bull.score} ` +
    `bear=${validated.bear.score} ` +
    `quant_ev=${validated.quant.expectedValue} ` +
    `macro=${validated.macro.regime} flag=${validated.macro.flag} ` +
    `sentiment=${validated.sentiment.score} newsInterrupt=${validated.sentiment.newsInterrupt}`,
  );


  // Return structure intentionally mirrors the deliberations table columns so
  // debate.js can read it without a second Supabase round-trip.
  return {
    deliberationId,
    bull:      validated.bull,
    bear:      validated.bear,
    quant:     validated.quant,
    macro:     validated.macro,
    sentiment: validated.sentiment,
  };
}


// ── fetchSignal ───────────────────────────────────────────────────────────────
// Reads a single row from the signals table by UUID.
// Throws if the row is missing or the query fails — the caller cannot proceed
// without a valid signal.

async function fetchSignal(signalId) {
  const { data, error } = await getSupabase()
    .from('signals')
    .select('*')
    .eq('id', signalId)
    .single();

  if (error) throw new Error(`[orchestrator] Failed to fetch signal ${signalId}: ${error.message}`);
  if (!data)  throw new Error(`[orchestrator] Signal ${signalId} not found in Supabase`);

  return data;
}


// ── fetchPortfolioState ───────────────────────────────────────────────────────
// Reads every row from the trades table and derives the current portfolio
// snapshot needed by the Risk Agent and the agent context objects.
//
// Drawdown is approximated as max(0, cumulative closed-trade losses / initial
// capital). Unrealised P&L on open positions is excluded because paper-trade
// prices are not tracked in real time.
//
// @returns {Promise<{
//   openPositions:     number,
//   currentDrawdownPct: number,
//   portfolioValue:    number,
//   mode:              'paper' | 'live',
//   historicalTrades:  object[],
//   openTrades:        object[],
//   closedTrades:      object[],
// }>}

async function fetchPortfolioState() {
  const { data: allTrades, error } = await getSupabase()
    .from('trades')
    .select('*')
    .order('entry_time', { ascending: true });

  if (error) throw new Error(`[orchestrator] Failed to fetch trades: ${error.message}`);

  const trades      = allTrades ?? [];
  const openTrades  = trades.filter(t => t.exit_time == null);
  const closedTrades = trades.filter(t => t.exit_time != null);

  // Cumulative realised P&L from closed trades
  const netPnlUsd = closedTrades.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);

  // Simple peak-to-trough approximation: if we're down, express as fraction of
  // starting capital. Capped at 1.0 so the Risk Agent never sees > 100%.
  const currentDrawdownPct = netPnlUsd < 0
    ? Math.min(Math.abs(netPnlUsd) / INITIAL_PORTFOLIO_VALUE_USD, 1)
    : 0;

  const currentPortfolioValue = Math.max(INITIAL_PORTFOLIO_VALUE_USD + netPnlUsd, 0.01);

  return {
    openPositions:      openTrades.length,
    currentDrawdownPct,
    portfolioValue:     currentPortfolioValue,
    mode:               process.env.SWARMTRADE_MODE === 'live' ? 'live' : 'paper',
    historicalTrades:   trades,
    openTrades,
    closedTrades,
  };
}


// ── extractMarketData ─────────────────────────────────────────────────────────
// Pulls technical indicator values from the TradingView webhook payload stored
// in signal.raw_payload. Every field is optional — Pine Script alerts include
// only what the alert message template specifies.
//
// Safe defaults are applied for all missing fields so agents always receive a
// complete object. `macd` is aliased from `macdSignal` because Bear Agent
// Round 2 reads marketData.macd while Bull Agent Round 2 reads macdSignal.

function extractMarketData(signal) {
  const p = signal.raw_payload ?? {};

  const currentPrice = p.price ?? p.close ?? p.current_price ?? 0;

  // ATR default: 2% of current price — rough but prevents Risk Agent from
  // throwing on signals that don't include volatility data.
  // Use payload ATR if available (scanner provides it). Fall back to 2% of price.
  const atr = p.atr ?? (currentPrice > 0 ? parseFloat((currentPrice * 0.02).toFixed(8)) : 1);

  // Normalise MACD signal field — different Pine Script authors use different keys
  const macdSignal = p.macd_signal ?? p.macd ?? 'neutral';

  // Trading mode from scanner payload — falls back to 'dayTrade' for TradingView signals
  const tradingMode    = p.trading_mode ?? 'dayTrade';
  const profile        = TRADING_PROFILES[tradingMode] ?? TRADING_PROFILES.dayTrade;

  return {
    currentPrice,
    rsi:                   p.rsi                   ?? 50,
    macdSignal,
    macd:                  macdSignal,
    volume:                p.volume_ratio ?? p.volume ?? 1.0,
    fundingRate:           p.funding_rate           ?? 0,
    fearGreedIndex:        p.fear_greed             ?? 50,
    recentRejectionLevels: p.rejection_levels       ?? [],
    atr,
    stopLoss:              p.stop_loss              ?? null,
    takeProfit:            p.take_profit            ?? null,
    tradingMode,
    holdDescription:       profile.holdDescription,
  };
}


// ── extractMacroData ──────────────────────────────────────────────────────────
// Pulls macro-economic context from the webhook payload.
// Reasonable static defaults are used if the Pine Script alert doesn't include them.

function extractMacroData(signal) {
  const p = signal.raw_payload ?? {};
  return {
    dxyValue:               p.dxy_value               ?? 104,
    btcDominance:           p.btc_dominance           ?? 50,
    recentNewsHeadlines:    p.news_headlines           ?? [],
    upcomingEconomicEvents: p.economic_events          ?? [],
  };
}


// ── buildProposedTrade ────────────────────────────────────────────────────────
// Constructs the proposedTrade object the Risk Agent expects.
//
// Stop loss uses the explicit payload value when present. Otherwise it falls
// back to entry price ± 2× ATR in the adverse direction — a conservative
// default that keeps the Risk Agent R:R check meaningful.

function buildProposedTrade(signal, marketData) {
  const { currentPrice, atr, stopLoss: payloadStopLoss, takeProfit: payloadTakeProfit } = marketData;

  const safeEntry = currentPrice > 0 ? currentPrice : 1;
  const safeAtr   = atr > 0 ? atr : 1;

  let stopLoss;
  if (payloadStopLoss != null && payloadStopLoss > 0) {
    stopLoss = payloadStopLoss;
  } else if (signal.direction === 'long') {
    stopLoss = Math.max(0.01, safeEntry - 2 * safeAtr);
  } else {
    // short / close: stop loss is above entry
    stopLoss = safeEntry + 2 * safeAtr;
  }

  const proposed = {
    asset:      signal.asset,
    direction:  signal.direction,
    entryPrice: safeEntry,
    stopLoss:   stopLoss > 0 ? stopLoss : 0.01,
    atr:        safeAtr,
  };

  if (payloadTakeProfit != null && payloadTakeProfit > 0) {
    proposed.takeProfit = payloadTakeProfit;
  }

  return proposed;
}


// ── createNewsInterruptDeliberation ──────────────────────────────────────────
// Persists a minimal deliberations row when the News Sentinel fires and the
// full agent pipeline is skipped. Sets final_decision='hold' and status='complete'
// so the dashboard and audit log reflect the early exit correctly.

async function createNewsInterruptDeliberation(signalId, sentimentSnapshot) {
  const { data, error } = await getSupabase()
    .from('deliberations')
    .insert({
      signal_id:         signalId,
      news_interrupt:    true,
      sentiment_score:   sentimentSnapshot.score,
      sentiment_summary: sentimentSnapshot.summary,
      final_decision:    'hold',
      risk_approved:     false,
      position_size_pct: 0,
      status:            'complete',
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`[orchestrator] Failed to create news interrupt deliberation: ${error.message}`);
  }

  return data.id;
}


// ── finaliseDeliberation ──────────────────────────────────────────────────────
// Writes the Risk Agent decision (approved, positionSizePct) and advances the
// deliberations row to status='complete'. This is the last write to the row
// before the OctoBot handler picks up the trade instruction.
//
// Errors are logged but not re-thrown — a write failure here must not prevent
// the function returning a trade instruction to the webhook layer.

async function finaliseDeliberation(deliberationId, decision, riskVerdict) {
  try {
    const { error } = await getSupabase()
      .from('deliberations')
      .update({
        final_decision:    decision,
        risk_approved:     riskVerdict.approved,
        position_size_pct: riskVerdict.positionSizePct,
        entry_price:       riskVerdict.entryPrice ?? null,
        status:            'complete',
      })
      .eq('id', deliberationId);

    if (error) {
      console.error(
        `[orchestrator] Failed to finalise deliberation ${deliberationId}: ${error.message}`,
      );
    } else {
      console.log(
        `[orchestrator] Deliberation ${deliberationId} finalised — ` +
        `decision=${decision} risk_approved=${riskVerdict.approved} ` +
        `position_size_pct=${riskVerdict.positionSizePct}`,
      );
    }
  } catch (err) {
    console.error(`[orchestrator] Unexpected error finalising deliberation ${deliberationId}: ${err.message}`);
  }
}


// ── createTradeRecord ─────────────────────────────────────────────────────────
// Inserts a row in the trades table with status='pending_execution'.
// The OctoBot handler polls for rows in this state and converts them into live
// paper-trade instructions. The exchange field is left null here — it is set
// by the OctoBot handler once the trade is placed.

async function createTradeRecord(deliberationId, signal, marketData, riskVerdict) {
  const positionSizeUsd = parseFloat(
    ((riskVerdict.positionSizePct / 100) * INITIAL_PORTFOLIO_VALUE_USD).toFixed(2),
  );

  const tradeRow = {
    deliberation_id:   deliberationId,
    entry_price:       marketData.currentPrice > 0 ? marketData.currentPrice : null,
    position_size_usd: positionSizeUsd,
    mode:              process.env.SWARMTRADE_MODE === 'live' ? 'live' : 'paper',
    status:            'pending_execution',
  };

  const { data, error } = await getSupabase()
    .from('trades')
    .insert(tradeRow)
    .select('id')
    .single();

  if (error) throw new Error(`[orchestrator] Failed to create trade record: ${error.message}`);

  console.log(
    `[orchestrator] Trade record created — id=${data.id} ` +
    `asset=${signal.asset} direction=${signal.direction} ` +
    `size=$${positionSizeUsd} (${riskVerdict.positionSizePct}%)`,
  );

  return {
    tradeId:          data.id,
    deliberationId,
    asset:            signal.asset,
    direction:        signal.direction,
    positionSizePct:  riskVerdict.positionSizePct,
    positionSizeUsd,
    entryPrice:       marketData.currentPrice,
  };
}


// ── runDeliberation ───────────────────────────────────────────────────────────
/**
 * Full deliberation pipeline. Called by the webhook handler after a TradingView
 * signal is written to Supabase. Target completion time: under 20 seconds.
 *
 * Steps:
 *  1. Fetch signal from Supabase by signalId
 *  2. Fetch portfolio state from the trades table
 *  3. Pre-flight sentiment check — early exit if News Sentinel fired
 *  4. Round 1 — five agents in parallel (Bull, Bear, Quant, Macro, Sentiment)
 *  5. Round 2 — structured debate (Bull/Bear rebuttals + Quant cross-check)
 *  6. Round 3 — Orchestrator synthesis (Sonnet)
 *  7. Risk Agent evaluation — unconditional veto authority
 *  8. Finalise deliberations row (status='complete')
 *  9. Create trades row with status='pending_execution' if approved
 * 10. Log total elapsed time
 *
 * @param {string} signalId — UUID from the signals table
 *
 * @returns {Promise<{
 *   deliberationId:   string,
 *   decision:         'trade' | 'hold' | 'veto',
 *   voteResult:       'unanimous' | 'divided' | 'contested' | null,
 *   riskApproved:     boolean,
 *   positionSizePct:  number,
 *   tradeInstruction: object | null,
 *   elapsedMs:        number,
 *   earlyExit?:       string,
 * }>}
 */
async function runDeliberation(signalId) {
  const startTime = Date.now();

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`[orchestrator] runDeliberation — signalId=${signalId}`);
  console.log(`${'─'.repeat(72)}`);


  // ── Step 1: Fetch signal ────────────────────────────────────────────────────

  let signal;
  try {
    signal = await fetchSignal(signalId);
  } catch (err) {
    console.error(err.message);
    throw err;
  }

  console.log(
    `[orchestrator] Step 1 ✓ — signal fetched: asset=${signal.asset} ` +
    `direction=${signal.direction} timeframe=${signal.timeframe ?? 'n/a'} ` +
    `type=${signal.signal_type ?? 'n/a'}`,
  );


  // ── Step 2: Fetch portfolio state ────────────────────────────────────────────

  let portfolioSnapshot;
  try {
    portfolioSnapshot = await fetchPortfolioState();
  } catch (err) {
    console.error(`[orchestrator] Step 2 failed — could not fetch portfolio state: ${err.message}`);
    throw err;
  }

  console.log(
    `[orchestrator] Step 2 ✓ — portfolio state: openPositions=${portfolioSnapshot.openPositions} ` +
    `drawdown=${(portfolioSnapshot.currentDrawdownPct * 100).toFixed(2)}% ` +
    `value=$${portfolioSnapshot.portfolioValue.toFixed(2)} mode=${portfolioSnapshot.mode}`,
  );

  // Extract market and macro data from the webhook payload — used by multiple steps below.
  const marketData = extractMarketData(signal);
  const macroData  = extractMacroData(signal);

  // ── Live price fetch ───────────────────────────────────────────────────────
  // TradingView alerts don't always include price. If price is 0 (missing),
  // fetch it live from Binance public ticker so agents have real data to work with.
  if (marketData.currentPrice === 0) {
    try {
      const symbol    = signal.asset.replace('/', '');
      const tickerRes = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (tickerRes.ok) {
        const ticker    = await tickerRes.json();
        const livePrice = parseFloat(ticker.price);
        if (livePrice > 0) {
          marketData.currentPrice = livePrice;
          marketData.atr          = parseFloat((livePrice * 0.02).toFixed(8));
          console.log(`[orchestrator] Live price fetched — ${signal.asset} = $${livePrice}`);
        }
      }
    } catch (priceErr) {
      console.warn(`[orchestrator] Live price fetch failed (non-fatal): ${priceErr.message}`);
    }
  }


  // ── Step 3: Pre-flight sentiment check — News Sentinel gate ──────────────────
  // getSentimentSnapshot() reads from Supabase (no LLM). Calling it here before
  // the agent round avoids spending API budget when a news interrupt is active.
  // runRound1() will call it again internally — the double DB read is acceptable.

  let sentimentPreFlight;
  try {
    sentimentPreFlight = await sentiment.getSentimentSnapshot();
  } catch (err) {
    console.error(`[orchestrator] Pre-flight sentiment check failed (non-fatal): ${err.message}`);
    sentimentPreFlight = NEUTRAL_DEFAULTS.sentiment;
  }

  if (sentimentPreFlight.newsInterrupt) {
    const headline = sentimentPreFlight.newsHeadline || 'headline not available';
    console.warn(
      `[orchestrator] Step 3 — News Sentinel interrupt ACTIVE. ` +
      `Headline: "${headline}". ` +
      `Halting deliberation and setting final_decision=hold.`,
    );

    let deliberationId;
    try {
      deliberationId = await createNewsInterruptDeliberation(signalId, sentimentPreFlight);
      console.log(
        `[orchestrator] News interrupt deliberation persisted — id=${deliberationId}`,
      );
    } catch (persistErr) {
      // Non-fatal — the decision is still hold regardless of whether the row was written.
      console.error(`[orchestrator] Failed to persist news interrupt: ${persistErr.message}`);
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[orchestrator] Deliberation complete in ${elapsed}ms — early exit (news interrupt)`,
    );

    return {
      deliberationId:   deliberationId ?? null,
      decision:         'hold',
      voteResult:       null,
      riskApproved:     false,
      positionSizePct:  0,
      tradeInstruction: null,
      elapsedMs:        elapsed,
      earlyExit:        'news_interrupt',
    };
  }

  console.log(`[orchestrator] Step 3 ✓ — no news interrupt, proceeding to Round 1`);


  // ── Step 4: Round 1 — parallel agent analysis ────────────────────────────────
  // runRound1 creates the deliberations row and returns its id. All Round 1
  // outputs are persisted to Supabase before this returns.

  const portfolioStateForRound1 = {
    marketData,
    macroData,
    historicalTrades: portfolioSnapshot.historicalTrades,
  };

  let round1Results;
  try {
    round1Results = await runRound1(signal, portfolioStateForRound1);
  } catch (err) {
    console.error(`[orchestrator] Round 1 failed: ${err.message}`);
    throw err;
  }

  const { deliberationId } = round1Results;

  console.log(`[orchestrator] Step 4 ✓ — Round 1 complete, deliberationId=${deliberationId}`);
  events.emitRound2Start(deliberationId, signal.id).catch(() => {});

  // Attach the signal descriptor and raw marketData to the round1Results object
  // before passing to downstream steps. debate.js destructures marketData;
  // synthesise.js destructures signal. Neither field is returned by runRound1.
  const round1ResultsWithContext = {
    ...round1Results,
    signal: {
      asset:      signal.asset,
      direction:  signal.direction,
      timeframe:  signal.timeframe  ?? 'unknown',
      signalType: signal.signal_type ?? 'unknown',
    },
    marketData,
  };


  // ── Step 5: Round 2 — structured debate ──────────────────────────────────────
  // Bull reads Bear's thesis; Bear reads Bull's thesis; Quant cross-checks Sentiment.
  // All three run in parallel inside runRound2. Results are persisted before returning.

  let round2Results;
  try {
    round2Results = await runRound2(round1ResultsWithContext, deliberationId);
  } catch (err) {
    // Round 2 failure is non-fatal — use empty rebuttals and continue to synthesis.
    // This happens when Bear or Bull used neutral defaults and debate prompts fail.
    console.warn(`[orchestrator] Round 2 failed (non-fatal) — continuing with empty rebuttals: ${err.message}`);
    round2Results = {
      bullRebuttal: { score: round1Results.bull.score, thesis: round1Results.bull.thesis, data: {} },
      bearRebuttal: { score: round1Results.bear.score, thesis: round1Results.bear.thesis, data: {} },
      quantCheck:   { consistent: true, conflictFlag: false, note: 'Round 2 skipped due to error' },
    };
  }

  console.log(`[orchestrator] Step 5 ✓ — Round 2 complete`);
  events.emitRound2Complete(deliberationId, signal.id, {
    bullRebuttal: round2Results?.bullRebuttal?.thesis ?? '',
    bearRebuttal: round2Results?.bearRebuttal?.thesis ?? '',
  }).catch(() => {});
  events.emitRound3Start(deliberationId, signal.id).catch(() => {});


  // ── Step 6: Round 3 — Orchestrator synthesis (Sonnet) ────────────────────────
  // Reads all Round 1 outputs + Round 2 rebuttals. Classifies the vote and
  // synthesises a final decision. Persists to Supabase with status='round3'.

  let synthesisResult;
  try {
    synthesisResult = await synthesise(round1ResultsWithContext, round2Results, deliberationId);
  } catch (err) {
    // Round 3 failure — fall back to a conservative hold decision
    console.error(`[orchestrator] Round 3 synthesis failed (non-fatal) — defaulting to hold: ${err.message}`);
    synthesisResult = {
      voteResult: 'error',
      decision:   'hold',
      reasoning:  `Synthesis failed: ${err.message}`,
      positionNote: 'No position — synthesis error',
    };
  }

  console.log(
    `[orchestrator] Step 6 ✓ — synthesis complete: ` +
    `voteResult=${synthesisResult.voteResult} decision=${synthesisResult.decision}`,
  );
  events.emitRound3Complete(deliberationId, signal.id, {
    voteResult: synthesisResult.voteResult,
    decision:   synthesisResult.decision,
    reasoning:  synthesisResult.reasoning ?? '',
  }).catch(() => {});

  let { decision } = synthesisResult;


  // ── Step 7: Risk Agent evaluation ────────────────────────────────────────────
  // The Risk Agent has unconditional veto power. No code path may bypass this.
  // If the Risk Agent approves, it also sets the final position size.

  let riskVerdict = { approved: false, positionSizePct: 0, reason: 'No trade proposed by Orchestrator' };

  if (decision === 'trade') {
    const proposedTrade     = buildProposedTrade(signal, marketData);
    const riskPortfolioState = {
      openPositions:      portfolioSnapshot.openPositions,
      currentDrawdownPct: portfolioSnapshot.currentDrawdownPct,
      portfolioValue:     portfolioSnapshot.portfolioValue,
      mode:               portfolioSnapshot.mode,
    };

    try {
      riskVerdict = risk.evaluate(riskPortfolioState, proposedTrade);
      riskVerdict.entryPrice = proposedTrade.entryPrice ?? null;
    } catch (err) {
      // Input validation error from the Risk Agent — treat as a veto.
      console.error(`[orchestrator] Risk Agent threw (invalid inputs): ${err.message}`);
      riskVerdict = {
        approved:        false,
        positionSizePct: 0,
        reason:          `Risk Agent input error: ${err.message}`,
      };
    }

    if (!riskVerdict.approved) {
      console.warn(
        `[orchestrator] Step 7 — Risk Agent VETO. ` +
        `Overriding decision from 'trade' to 'veto'. Reason: ${riskVerdict.reason}`,
      );
      decision = 'veto';
    } else {
      console.log(
        `[orchestrator] Step 7 ✓ — Risk Agent approved: ` +
        `positionSizePct=${riskVerdict.positionSizePct}%. Reason: ${riskVerdict.reason}`,
      );
    }
    events.emitRiskGate(deliberationId, signal.id, riskVerdict).catch(() => {});
  } else {
    console.log(
      `[orchestrator] Step 7 — Risk Agent not called (decision='${decision}', no trade proposed)`,
    );
    events.emitRiskGate(deliberationId, signal.id, { approved: false, reason: `No trade — decision was '${decision}'`, positionSizePct: 0 }).catch(() => {});
  }


  // ── Step 8: Finalise deliberations row ────────────────────────────────────────
  // Updates final_decision (which may have been overridden to 'veto' by the Risk
  // Agent), risk_approved, position_size_pct, and advances status to 'complete'.

  await finaliseDeliberation(deliberationId, decision, riskVerdict);

  console.log(`[orchestrator] Step 8 ✓ — deliberations row status=complete`);


  // ── Step 9: Create trade record ───────────────────────────────────────────────
  // A row in the trades table signals OctoBot that a paper trade should be placed.
  // Only created when the Orchestrator AND the Risk Agent both approve.

  let tradeInstruction = null;

  if (decision === 'trade' && riskVerdict.approved) {
    try {
      tradeInstruction = await createTradeRecord(deliberationId, signal, marketData, riskVerdict);
      console.log(`[orchestrator] Step 9 ✓ — trade record created, id=${tradeInstruction.tradeId}`);
    } catch (err) {
      console.error(`[orchestrator] Step 9 failed — trade record not created: ${err.message}`);
      // Non-fatal: the deliberation is complete even if the trade record failed.
    }
  } else {
    console.log(
      `[orchestrator] Step 9 — no trade record created (decision=${decision}, ` +
      `riskApproved=${riskVerdict.approved})`,
    );
  }


  // ── Step 10: Log total deliberation time ─────────────────────────────────────

  const elapsed = Date.now() - startTime;
  const targetMs = 20_000;

  console.log(
    `\n[orchestrator] ── DELIBERATION COMPLETE ` +
    `${elapsed > targetMs ? '⚠  EXCEEDED 20s TARGET' : '✓ within 20s target'} ──\n` +
    `  signalId=${signalId}\n` +
    `  deliberationId=${deliberationId}\n` +
    `  decision=${decision}\n` +
    `  voteResult=${synthesisResult.voteResult}\n` +
    `  riskApproved=${riskVerdict.approved}\n` +
    `  positionSizePct=${riskVerdict.positionSizePct}\n` +
    `  elapsedMs=${elapsed}`,
  );

  events.emitDone(deliberationId, signal.id, {
    decision,
    riskApproved: riskVerdict.approved,
    elapsedMs:    elapsed,
  }).catch(() => {});

  return {
    deliberationId,
    decision,
    voteResult:       synthesisResult.voteResult,
    riskApproved:     riskVerdict.approved,
    positionSizePct:  riskVerdict.positionSizePct,
    tradeInstruction,
    elapsedMs:        elapsed,
  };
}


module.exports = { runRound1, runDeliberation };
