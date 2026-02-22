'use strict';

// ── Bull Agent prompt builder ─────────────────────────────────────────────────
// Constructs the system prompt and user message for the Bull Agent.
// All prompt strings live here. Never inline prompts in index.js.
//
// Round 1: independent momentum analysis of the incoming signal.
// Round 2: rebuttal of the Bear Agent's thesis after reading it.

const SYSTEM_PROMPT = `You are the Bull Agent in a multi-agent cryptocurrency trading committee.

Your role is to analyse incoming trade signals from a bullish perspective. You look for momentum, strength, and reasons to enter a trade. You are optimistic but not reckless — your score must be grounded in the data provided.

You must respond with valid JSON only. No prose outside the JSON object.

Output format:
{
  "score": <integer 0-100>,
  "thesis": "<one to three sentences — your bullish case or why you cannot make one>",
  "data": {
    "keyBullSignals": ["<signal>", ...],
    "keyRisks": ["<risk you acknowledge>", ...]
  }
}

Scoring guide:
  80-100 — Strong bullish conviction. Multiple confirming signals. High-probability setup.
  60-79  — Moderate bullish lean. Signal is valid but has caveats.
  40-59  — Neutral to weak bullish. Mixed signals. Low conviction.
  20-39  — Bullish case is thin. More reasons to stay out than enter.
  0-19   — No bullish case. Do not manufacture one.

Rules:
- Never fabricate data. Only use the figures provided in the user message.
- Acknowledge the strongest bear case in keyRisks even if you disagree with it.
- Be direct and opinionated. Hedged non-answers score poorly.
- Your thesis must be falsifiable — state what would invalidate your view.`;


// ── Round 1: independent analysis ────────────────────────────────────────────
// @param {object} marketData
// @param {string} marketData.asset         — e.g. 'BTC/USDT'
// @param {number} marketData.currentPrice  — current asset price in USD
// @param {number} marketData.rsi           — RSI value (0-100)
// @param {string} marketData.macdSignal    — 'bullish_crossover' | 'bearish_crossover' | 'neutral'
// @param {number} marketData.volume        — recent volume (relative to average, e.g. 1.4 = 40% above avg)
// @param {string} marketData.direction     — signal direction from TradingView: 'long' | 'short'
// @param {string} marketData.signalType    — signal type from TradingView, e.g. 'MACD crossover'
// @param {string} marketData.timeframe     — e.g. '1h', '4h', '1d'
function buildRound1Prompt(marketData) {
  const {
    asset,
    currentPrice,
    rsi,
    macdSignal,
    volume,
    direction,
    signalType,
    timeframe,
  } = marketData;

  const volumeLabel = volume >= 1.5 ? 'significantly above average'
    : volume >= 1.1 ? 'above average'
    : volume >= 0.9 ? 'average'
    : 'below average';

  const userMessage = `Analyse this trade signal from a bullish perspective.

SIGNAL
  Asset:       ${asset}
  Direction:   ${direction}
  Signal type: ${signalType}
  Timeframe:   ${timeframe}

MARKET DATA
  Current price: $${currentPrice.toLocaleString()}
  RSI:           ${rsi} ${rsi > 70 ? '(overbought)' : rsi < 30 ? '(oversold)' : '(neutral zone)'}
  MACD signal:   ${macdSignal}
  Volume:        ${volume.toFixed(2)}× average (${volumeLabel})

Make your bullish case. If the data does not support a bullish view, say so honestly and score low.`;

  return { system: SYSTEM_PROMPT, user: userMessage };
}


// ── Round 2: rebuttal of Bear thesis ─────────────────────────────────────────
// @param {object} marketData  — same shape as Round 1
// @param {string} bearThesis  — the Bear Agent's Round 1 thesis string
function buildRound2Prompt(marketData, bearThesis) {
  const { asset, currentPrice, rsi, macdSignal, volume } = marketData;

  const userMessage = `You have seen the Bear Agent's counter-thesis. Respond to it.

BEAR AGENT'S THESIS
"${bearThesis}"

ORIGINAL MARKET DATA (unchanged)
  Asset:         ${asset}
  Current price: $${currentPrice.toLocaleString()}
  RSI:           ${rsi}
  MACD signal:   ${macdSignal}
  Volume:        ${volume.toFixed(2)}× average

Your task: directly address the bear's strongest point. You may hold, raise, or lower your score based on their argument. You must explain why in your thesis. If they raised a valid risk you had not considered, acknowledge it.`;

  return { system: SYSTEM_PROMPT, user: userMessage };
}


module.exports = { buildRound1Prompt, buildRound2Prompt };
