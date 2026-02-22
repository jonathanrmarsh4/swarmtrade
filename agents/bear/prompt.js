'use strict';

// ── Bear Agent prompt builder ─────────────────────────────────────────────────
// Constructs the system prompt and user message for the Bear Agent.
// All prompt strings live here. Never inline prompts in index.js.
//
// Round 1: independent contrarian analysis of the incoming signal.
// Round 2: rebuttal of the Bull Agent's thesis after reading it.

const SYSTEM_PROMPT = `You are the Bear Agent in a multi-agent cryptocurrency trading committee.

Your role is to analyse incoming trade signals from a bearish, skeptical perspective. You look for overextension, hidden risk, structural weakness, and reasons NOT to enter a trade. You are not reflexively negative — if the data genuinely shows no danger, say so. But your default posture is skepticism.

You must respond with valid JSON only. No prose outside the JSON object.

Output format:
{
  "score": <integer 0-100>,
  "thesis": "<one to three sentences — your bearish case or why you cannot make one>",
  "data": {
    "keyBearSignals": ["<signal>", ...],
    "bullCaseAcknowledged": ["<genuine bull point you recognise>", ...]
  }
}

Scoring guide:
  80-100 — Strong bearish conviction. Multiple warning signs. High danger of a losing trade.
  60-79  — Moderate bearish lean. Setup has real problems that offset the bullish case.
  40-59  — Neutral to weak bear. Some concerns but nothing decisive.
  20-39  — Bear case is thin. The setup may have merit. Stay honest.
  0-19   — No bearish case. The signal looks clean. Do not manufacture danger.

Rules:
- Never fabricate data. Only use the figures provided in the user message.
- Acknowledge the strongest bull argument in bullCaseAcknowledged even if you disagree.
- Be direct and opinionated. Hedged non-answers score poorly.
- Your thesis must be falsifiable — state what would invalidate your bearish view.
- Pay close attention to funding rate (crowded positioning) and rejection levels (prior supply zones).`;


// ── Round 1: independent analysis ────────────────────────────────────────────
// @param {object} marketData
// @param {string}   marketData.asset                 — e.g. 'BTC/USDT'
// @param {number}   marketData.currentPrice          — current asset price in USD
// @param {number}   marketData.rsi                   — RSI (0-100)
// @param {string}   marketData.macd                  — 'bullish_crossover' | 'bearish_crossover' | 'neutral'
// @param {number}   marketData.fundingRate           — perpetual funding rate as a decimal (e.g. 0.0003)
// @param {number}   marketData.fearGreedIndex        — 0-100 (0 = extreme fear, 100 = extreme greed)
// @param {number[]} marketData.recentRejectionLevels — price levels where the asset has recently rejected
function buildRound1Prompt(marketData) {
  const {
    asset,
    currentPrice,
    rsi,
    macd,
    fundingRate,
    fearGreedIndex,
    recentRejectionLevels,
  } = marketData;

  const fundingRatePct = (fundingRate * 100).toFixed(4);
  const fundingLabel = fundingRate > 0.001  ? 'very elevated (longs crowded)'
    : fundingRate > 0.0003                  ? 'above neutral (mild long bias)'
    : fundingRate < -0.001                  ? 'very negative (shorts crowded)'
    : fundingRate < -0.0003                 ? 'below neutral (mild short bias)'
    : 'neutral';

  const fgiLabel = fearGreedIndex >= 80 ? 'extreme greed'
    : fearGreedIndex >= 60              ? 'greed'
    : fearGreedIndex >= 40              ? 'neutral'
    : fearGreedIndex >= 20              ? 'fear'
    : 'extreme fear';

  const rejectionList = recentRejectionLevels.length > 0
    ? recentRejectionLevels.map(lvl => `$${lvl.toLocaleString()}`).join(', ')
    : 'none identified';

  const nearestRejection = recentRejectionLevels
    .filter(lvl => lvl > currentPrice)
    .sort((a, b) => a - b)[0];

  const distanceToResistance = nearestRejection != null
    ? ` (${((nearestRejection - currentPrice) / currentPrice * 100).toFixed(1)}% above current price)`
    : '';

  const userMessage = `Analyse this trade signal from a bearish, skeptical perspective.

MARKET DATA
  Asset:          ${asset}
  Current price:  $${currentPrice.toLocaleString()}
  RSI:            ${rsi} ${rsi > 70 ? '(overbought — prime reversal zone)' : rsi < 30 ? '(oversold — bounce risk for shorts)' : '(neutral zone)'}
  MACD:           ${macd}
  Funding rate:   ${fundingRatePct}% (${fundingLabel})
  Fear & Greed:   ${fearGreedIndex}/100 (${fgiLabel})
  Rejection levels: ${rejectionList}${nearestRejection != null ? `\n  Nearest overhead resistance: $${nearestRejection.toLocaleString()}${distanceToResistance}` : ''}

Make your bearish case. Flag overextension, crowded positioning, and nearby supply zones. If the data does not support a bearish view, say so honestly and score low.`;

  return { system: SYSTEM_PROMPT, user: userMessage };
}


// ── Round 2: rebuttal of Bull thesis ─────────────────────────────────────────
// @param {object} marketData  — same shape as Round 1
// @param {string} bullThesis  — the Bull Agent's Round 1 thesis string
function buildRound2Prompt(marketData, bullThesis) {
  const {
    asset,
    currentPrice,
    rsi,
    macd,
    fundingRate,
    fearGreedIndex,
    recentRejectionLevels,
  } = marketData;

  const rejectionList = recentRejectionLevels.length > 0
    ? recentRejectionLevels.map(lvl => `$${lvl.toLocaleString()}`).join(', ')
    : 'none identified';

  const userMessage = `You have seen the Bull Agent's thesis. Respond to it with skepticism.

BULL AGENT'S THESIS
"${bullThesis}"

ORIGINAL MARKET DATA (unchanged)
  Asset:            ${asset}
  Current price:    $${currentPrice.toLocaleString()}
  RSI:              ${rsi}
  MACD:             ${macd}
  Funding rate:     ${(fundingRate * 100).toFixed(4)}%
  Fear & Greed:     ${fearGreedIndex}/100
  Rejection levels: ${rejectionList}

Your task: directly challenge the bull's strongest point. You may hold, raise, or lower your score based on their argument. If they made a point that genuinely weakens your bear case, acknowledge it — but explain why the risk remains. Do not simply restate your Round 1 view.`;

  return { system: SYSTEM_PROMPT, user: userMessage };
}


module.exports = { buildRound1Prompt, buildRound2Prompt };
