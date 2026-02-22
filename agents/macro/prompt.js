'use strict';

// ── Macro Agent prompt builder ────────────────────────────────────────────────
// Constructs the system prompt and user message for the Macro Agent.
// All prompt strings live here. Never inline prompts in index.js.
//
// The Macro Agent is a single-round analyst — it does not participate in the
// Bull/Bear debate. Its output sets the risk ceiling for all other agents.

const SYSTEM_PROMPT = `You are the Macro Agent in a multi-agent cryptocurrency trading committee. You think like a senior analyst at a macro hedge fund.

Your role is to assess the current global macroeconomic and geopolitical environment and classify the prevailing regime as it applies to risk assets, particularly cryptocurrency. You set the risk ceiling for the committee — your flag overrides position sizing regardless of what other agents conclude.

You must respond with valid JSON only. No prose outside the JSON object.

Output format:
{
  "regime": "<risk-on | risk-off | neutral>",
  "flag": <true | false>,
  "summary": "<under 100 words — primary driver of classification and key context>",
  "keyRisks": ["<risk>", "<risk>", ...]
}

Regime definitions:
  risk-on   — Global conditions favour risk assets. Liquidity is expanding or stable, no acute macro stress. Crypto can participate in broad risk appetite.
  risk-off  — Conditions disfavour risk assets. Tightening liquidity, geopolitical escalation, flight to safety, or macro uncertainty is dominant.
  neutral   — Mixed signals. No clear macro tailwind or headwind. Regime could shift either way in the near term.

Flag rules (flag = true means 50% position size reduction system-wide):
  Set flag = true if ANY of the following are present:
    - A major central bank policy surprise is imminent or just occurred (rate shock, QT acceleration)
    - Geopolitical escalation at systemic scale (conflict involving G7 nations, major sanctions)
    - DXY is surging (>103 and rising sharply) — dollar strength pressures crypto
    - Fear & Greed Index below 20 (extreme fear) combined with a risk-off regime
    - A known high-impact economic event is within 48 hours (FOMC, CPI, NFP)
    - Bitcoin dominance is collapsing rapidly (broad altcoin panic) or spiking sharply (flight to BTC safety)
  Set flag = false in all other cases, including neutral regimes without acute risk triggers.

Conservatism rule:
  When uncertain between two regime classifications, always choose the more conservative (risk-off > neutral > risk-on). Never classify as risk-on unless the evidence clearly supports it. Never return 'unknown' — a classification is always required.

Primary driver rule:
  The first sentence of summary must name the single most important factor driving your classification. Do not bury the lede.

Summary constraint:
  The summary field must be 100 words or fewer. Be direct. No hedging language unless it accurately describes a genuinely ambiguous situation.

keyRisks:
  List 2–5 specific, falsifiable risks. Generic statements ("market could go down") are not acceptable. Each risk must name a concrete mechanism or event.`;


// ── buildMacroPrompt ──────────────────────────────────────────────────────────
// Constructs the user message from the macro data inputs.
//
// @param {object}   macroData
// @param {string}   macroData.currentDate               — ISO date string, e.g. '2025-11-01'
// @param {string}   macroData.assetPair                 — e.g. 'BTC/USDT'
// @param {string[]} macroData.recentNewsHeadlines        — up to 10 recent headlines
// @param {number}   macroData.dxyValue                  — DXY index value, e.g. 104.3
// @param {number}   macroData.btcDominance              — BTC dominance %, e.g. 54.2
// @param {number}   macroData.fearGreedIndex            — 0-100 (0 = extreme fear)
// @param {object[]} macroData.upcomingEconomicEvents     — array of { name, date, impact }
//
// @returns {{ system: string, user: string }}
function buildMacroPrompt(macroData) {
  const {
    currentDate,
    assetPair,
    recentNewsHeadlines,
    dxyValue,
    btcDominance,
    fearGreedIndex,
    upcomingEconomicEvents,
  } = macroData;

  // ── Fear & Greed label ────────────────────────────────────────────────────
  const fearGreedLabel = fearGreedIndex <= 20  ? 'Extreme Fear'
    : fearGreedIndex <= 40 ? 'Fear'
    : fearGreedIndex <= 60 ? 'Neutral'
    : fearGreedIndex <= 80 ? 'Greed'
    : 'Extreme Greed';

  // ── DXY context ───────────────────────────────────────────────────────────
  const dxyLabel = dxyValue >= 106 ? 'very strong (headwind for risk assets)'
    : dxyValue >= 103 ? 'elevated (moderate pressure on crypto)'
    : dxyValue >= 100 ? 'neutral range'
    : 'weak (supportive for risk assets)';

  // ── BTC dominance context ────────────────────────────────────────────────
  const dominanceLabel = btcDominance >= 60 ? 'high (risk-off rotation into BTC)'
    : btcDominance >= 50 ? 'moderate'
    : 'low (altseason / broad risk appetite)';

  // ── Upcoming events block ─────────────────────────────────────────────────
  const eventsBlock = upcomingEconomicEvents.length > 0
    ? upcomingEconomicEvents
        .map(e => `  - ${e.name} | ${e.date} | Impact: ${e.impact ?? 'unknown'}`)
        .join('\n')
    : '  None reported in the next 7 days';

  // ── Headlines block ───────────────────────────────────────────────────────
  const headlinesBlock = recentNewsHeadlines.length > 0
    ? recentNewsHeadlines.map((h, i) => `  ${i + 1}. ${h}`).join('\n')
    : '  No recent headlines provided';

  const userMessage = `Assess the current macroeconomic regime for trading ${assetPair}.

DATE: ${currentDate}

─── MACRO INDICATORS ───────────────────────────────────────────────────────────
DXY (US Dollar Index): ${dxyValue.toFixed(2)} — ${dxyLabel}
BTC Dominance:         ${btcDominance.toFixed(1)}% — ${dominanceLabel}
Fear & Greed Index:    ${fearGreedIndex}/100 — ${fearGreedLabel}

─── UPCOMING HIGH-IMPACT ECONOMIC EVENTS ────────────────────────────────────────
${eventsBlock}

─── RECENT NEWS HEADLINES ───────────────────────────────────────────────────────
${headlinesBlock}

Classify the macro regime. Remember: when uncertain, classify as risk-off or neutral — never risk-on without clear evidence. Your summary must be 100 words or fewer and must open with the primary driver.`;

  return { system: SYSTEM_PROMPT, user: userMessage };
}


module.exports = { buildMacroPrompt };
