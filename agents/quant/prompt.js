'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Quant Agent — prompt template for Haiku output formatting.
//
// The math is already done before this prompt is called. Haiku's only job here
// is to repack the pre-computed numbers into the required JSON output shape.
// It must not invent, smooth, or adjust any figures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the Haiku formatting prompt from pre-computed metrics and signal context.
 *
 * @param {object} metrics
 * @param {number} metrics.winRate        — 0-1 decimal
 * @param {number} metrics.avgWin         — decimal percentage (e.g. 0.042 = 4.2%)
 * @param {number} metrics.avgLoss        — decimal percentage, negative (e.g. -0.021)
 * @param {number} metrics.expectedValue  — decimal percentage
 * @param {number} metrics.sharpeRatio    — per-trade Sharpe
 * @param {number} metrics.sampleSize     — count of closed trades analysed
 *
 * @param {object} signalData             — from the signals table in Supabase
 * @param {string} signalData.asset
 * @param {string} signalData.direction   — long | short | close
 * @param {string} [signalData.timeframe]
 * @param {string} [signalData.signal_type]
 *
 * @returns {string}
 */
function buildQuantPrompt(metrics, signalData) {
  const evPct       = (metrics.expectedValue * 100).toFixed(2);
  const winRatePct  = (metrics.winRate       * 100).toFixed(1);
  const avgWinPct   = (metrics.avgWin        * 100).toFixed(2);
  const avgLossPct  = (metrics.avgLoss       * 100).toFixed(2);
  const sharpe      = metrics.sharpeRatio.toFixed(2);
  const { sampleSize } = metrics;

  const asset       = signalData.asset       || 'unknown';
  const direction   = signalData.direction   || 'unknown';
  const timeframe   = signalData.timeframe   || 'unspecified';
  const signalType  = signalData.signal_type || 'unspecified';

  return `You are the Quant Agent in an AI trading committee. Your only job is to repackage pre-computed statistical metrics into the required JSON output. Do not invent, adjust, or smooth any numbers.

CALCULATED METRICS (${sampleSize} closed historical trades for this setup):
- Expected Value per trade: ${evPct}%
- Win Rate: ${winRatePct}%
- Average Win: +${avgWinPct}%
- Average Loss: ${avgLossPct}%
- Sharpe Ratio (per-trade): ${sharpe}
- Sample Size: ${sampleSize}

CURRENT SIGNAL:
- Asset:       ${asset}
- Direction:   ${direction}
- Timeframe:   ${timeframe}
- Signal Type: ${signalType}

REQUIRED OUTPUT — return exactly this JSON object and nothing else:
{
  "expectedValue": ${metrics.expectedValue},
  "winRate":       ${metrics.winRate},
  "avgWin":        ${metrics.avgWin},
  "avgLoss":       ${metrics.avgLoss},
  "sampleSize":    ${sampleSize},
  "recommendation": "${metrics.expectedValue > 0 ? 'take' : 'skip'}"
}

Rules:
1. Copy the numbers exactly as given — do not round or reformat them.
2. recommendation must be "take" when expectedValue > 0, and "skip" when expectedValue <= 0.
3. Return only the raw JSON object. No markdown fences, no explanation, no extra fields.`;
}

// ── buildSentimentCrossCheckPrompt ────────────────────────────────────────────
// Round 2 only. Asks Haiku whether the Sentiment Agent's crowd-mood score is
// consistent with the statistical edge (expected value) computed in Round 1.
//
// Haiku reasons about the relationship, then returns a structured JSON verdict.
// The calling function applies deterministic overrides to the boolean fields so
// that unambiguous conflicts (e.g. extreme greed + negative EV) are always flagged
// regardless of LLM interpretation. The note string is always kept as-is.
//
// @param {object} quantOutput
// @param {number} quantOutput.expectedValue  — decimal percentage, e.g. 0.023 = 2.3%
// @param {number} quantOutput.winRate        — 0-1
// @param {number} quantOutput.avgWin         — decimal percentage
// @param {number} quantOutput.avgLoss        — decimal percentage (negative)
// @param {number} quantOutput.sampleSize     — historical trade count
// @param {string} quantOutput.recommendation — 'take' | 'skip'
// @param {number} sentimentScore             — Sentiment Agent score 0-100
//
// @returns {string}
function buildSentimentCrossCheckPrompt(quantOutput, sentimentScore) {
  const { expectedValue, winRate, avgWin, avgLoss, sampleSize, recommendation } = quantOutput;

  const evPct      = (expectedValue * 100).toFixed(2);
  const winRatePct = (winRate       * 100).toFixed(1);
  const avgWinPct  = (avgWin        * 100).toFixed(2);
  const avgLossPct = (avgLoss       * 100).toFixed(2);

  const sentimentLabel = sentimentScore >= 80 ? 'extreme greed'
    : sentimentScore >= 60                    ? 'greed'
    : sentimentScore >= 40                    ? 'neutral'
    : sentimentScore >= 20                    ? 'fear'
    : 'extreme fear';

  const evDirection = expectedValue > 0 ? 'positive (statistical edge favours taking the trade)'
    : expectedValue < 0                 ? 'negative (statistics do not support taking the trade)'
    : 'zero (no statistical edge either way)';

  return `You are the Quant Agent in an AI trading committee. Your task is to cross-check whether the Sentiment Agent's crowd-mood reading is consistent with your statistical analysis.

STATISTICAL EDGE (computed from ${sampleSize} closed historical trades):
- Expected Value per trade: ${evPct}% (${evDirection})
- Win Rate: ${winRatePct}%
- Average Win: +${avgWinPct}%
- Average Loss: ${avgLossPct}%
- Your recommendation: ${recommendation}

SENTIMENT AGENT READING:
- Score: ${sentimentScore}/100 (${sentimentLabel})
  Scale: 0 = extreme fear, 100 = extreme greed

TASK:
Analyse whether the crowd sentiment aligns with or contradicts the statistical edge.
Consider: crowded longs (high greed) in a negative-EV setup is a danger signal.
Excessive fear in a positive-EV setup may indicate contrarian opportunity.

Return only this JSON object and nothing else:
{
  "consistent": <true if sentiment broadly aligns with the statistical edge, false if they conflict>,
  "conflictFlag": <true if the conflict is material enough to flag for the Orchestrator>,
  "note": "<one or two sentences explaining the alignment or conflict>"
}

Rules:
1. Return raw JSON only — no markdown fences, no extra fields.
2. conflictFlag must be true whenever consistent is false.
3. Your note must reference specific numbers (EV, sentiment score) — not vague generalities.`;
}


module.exports = { buildQuantPrompt, buildSentimentCrossCheckPrompt };
