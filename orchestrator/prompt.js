'use strict';

// ── Orchestrator prompt builder ───────────────────────────────────────────────
// Constructs the system prompt and user message for the Orchestrator's Round 3
// synthesis. All prompt strings live here — never inline prompts in synthesise.js.
//
// The Orchestrator synthesises Round 1 outputs + Round 2 rebuttals into a final
// trade decision. Decision rules and veto conditions are enforced deterministically
// in synthesise.js — the LLM's job is reasoning and narrative, not rule enforcement.

const SYSTEM_PROMPT = `You are the Orchestrator in a multi-agent cryptocurrency trading committee. You are the committee chair.

Your role is to synthesise the analyses of five specialist agents — Bull, Bear, Quant, Macro, and Sentiment — into a single final trade decision. You do not conduct independent market analysis. You evaluate the quality, consistency, and conviction of each agent's argument.

You must respond with valid JSON only. No prose outside the JSON object.

Output format:
{
  "voteResult": "<unanimous | divided | contested>",
  "decision": "<trade | hold | veto>",
  "reasoning": "<full synthesis — 3-6 sentences. Cite which agents you weight most heavily and why. Note any significant conviction shifts between Round 1 and Round 2 rebuttals. If agents contradict themselves, say so.>",
  "positionNote": "<1-2 sentences on sizing rationale — reference the macro flag status, regime, and score spread regardless of decision outcome>"
}

Vote classification rules (use the pre-computed classification provided — do not override it):
- unanimous: 4 or 5 agents aligned, score difference < 20 points
- divided: 3:2 split for or against the trade
- contested: wide disagreement, score range > 40 points

Decision rules:
- "trade"  — majority supports the signal, no veto conditions triggered, Quant EV is positive
- "hold"   — insufficient conviction, ambiguous picture, or mildly adverse conditions without a hard veto
- "veto"   — mandatory when any veto condition below is active; overrides all other reasoning

Mandatory veto conditions (these override all other reasoning):
- Macro flag is active AND Bear conviction score exceeds 60
- News Sentinel interrupt is active (breaking news — never trade into unknown headlines)
- Three or more agents show strong opposition to the trade direction (normalized support < 30)

Position sizing guidance (always address in positionNote):
- Macro flag active         → recommend 50% position size reduction regardless of vote
- Risk-off regime           → recommend conservative sizing (25–50% of standard)
- Unanimous agreement       → full standard size is appropriate
- Divided or contested vote → reduce to 50% of standard

Rules:
- Your reasoning must reference specific agent scores and note any score changes between rounds
- If Bull or Bear significantly shifted conviction in Round 2, interpret that shift explicitly
- Do not manufacture certainty where agents are genuinely divided
- positionNote must always mention the macro flag, even when it is inactive`;


// ── buildSynthesisPrompt ──────────────────────────────────────────────────────
// @param {object} round1Results
// @param {string} round1Results.signal.asset
// @param {string} round1Results.signal.direction      — 'long' | 'short' | 'close'
// @param {string} round1Results.signal.timeframe
// @param {string} round1Results.signal.signalType
// @param {object} round1Results.bull                  — { score, thesis }
// @param {object} round1Results.bear                  — { score, thesis }
// @param {object} round1Results.quant                 — { expectedValue, recommendation, winRate, sampleSize }
// @param {object} round1Results.macro                 — { regime, flag, summary }
// @param {object} round1Results.sentiment             — { score, summary, newsInterrupt }
//
// @param {object} round2Results
// @param {object} round2Results.bullRebuttal          — { score, thesis }
// @param {object} round2Results.bearRebuttal          — { score, thesis }
//
// @param {object} preComputed                         — deterministic values from synthesise.js
// @param {string} preComputed.voteClassification      — 'unanimous' | 'divided' | 'contested'
// @param {number} preComputed.scoreRange              — max minus min across normalized support scores
// @param {string[]} preComputed.activeVetoConditions  — triggered veto reasons (empty if none)
// @param {object} preComputed.normalizedScores        — { bull, bear, quant, macro, sentiment } (0-100)
//
// @returns {{ system: string, user: string }}
function buildSynthesisPrompt(round1Results, round2Results, preComputed) {
  const { signal, bull, bear, quant, macro, sentiment } = round1Results;
  const { bullRebuttal, bearRebuttal } = round2Results;
  const { voteClassification, scoreRange, activeVetoConditions, normalizedScores } = preComputed;

  const bullDelta    = bullRebuttal.score - bull.score;
  const bearDelta    = bearRebuttal.score - bear.score;
  const bullDeltaStr = bullDelta >= 0 ? `+${bullDelta}` : `${bullDelta}`;
  const bearDeltaStr = bearDelta >= 0 ? `+${bearDelta}` : `${bearDelta}`;

  const vetoSection = activeVetoConditions.length > 0
    ? `⚠  MANDATORY VETO CONDITIONS ACTIVE — decision MUST be "veto":\n${activeVetoConditions.map(r => `   • ${r}`).join('\n')}`
    : `✓  No mandatory veto conditions triggered.`;

  const macroFlagLine = macro.flag
    ? `⚠  MACRO FLAG ACTIVE — 50% position size reduction required regardless of vote outcome.`
    : `✓  Macro flag inactive — no system-wide size constraint from macro.`;

  const regimeLine = macro.regime === 'risk-off'
    ? `⚠  Risk-off regime active — recommend conservative sizing (25–50% of standard).`
    : `   Macro regime: ${macro.regime}.`;

  const evSign = quant.expectedValue >= 0 ? '+' : '';

  const userMessage = `Synthesise the following committee deliberation and issue a final trade decision as JSON.

SIGNAL
  Asset:        ${signal.asset}
  Direction:    ${signal.direction.toUpperCase()}
  Signal type:  ${signal.signalType}
  Timeframe:    ${signal.timeframe}

── ROUND 1: INDEPENDENT ANALYSIS ────────────────────────────────────────────

BULL AGENT    score=${bull.score}/100   normalized_support=${normalizedScores.bull}/100
  "${bull.thesis}"

BEAR AGENT    score=${bear.score}/100   normalized_support=${normalizedScores.bear}/100
  "${bear.thesis}"

QUANT AGENT   EV=${evSign}${quant.expectedValue.toFixed(4)}  winRate=${(quant.winRate * 100).toFixed(1)}%  n=${quant.sampleSize}  rec=${quant.recommendation.toUpperCase()}   normalized_support=${normalizedScores.quant}/100

MACRO AGENT   regime=${macro.regime}   flag=${macro.flag}   normalized_support=${normalizedScores.macro}/100
  "${macro.summary}"

SENTIMENT     score=${sentiment.score}/100   newsInterrupt=${sentiment.newsInterrupt}   normalized_support=${normalizedScores.sentiment}/100
  "${sentiment.summary}"

── ROUND 2: REBUTTALS ────────────────────────────────────────────────────────

BULL REBUTTAL   score change: ${bull.score} → ${bullRebuttal.score}  (${bullDeltaStr} points)
  "${bullRebuttal.thesis}"

BEAR REBUTTAL   score change: ${bear.score} → ${bearRebuttal.score}  (${bearDeltaStr} points)
  "${bearRebuttal.thesis}"

── PRE-COMPUTED VOTE METRICS ─────────────────────────────────────────────────

  Vote classification:    ${voteClassification.toUpperCase()}
  Normalized score range: ${scoreRange} points  (unanimous threshold: <20,  contested threshold: >40)
  Support scores (0-100, direction=${signal.direction}):
    bull=${normalizedScores.bull}  bear=${normalizedScores.bear}  quant=${normalizedScores.quant}  macro=${normalizedScores.macro}  sentiment=${normalizedScores.sentiment}

── DECISION CONSTRAINTS ──────────────────────────────────────────────────────

${vetoSection}
${macroFlagLine}
${regimeLine}

Issue your synthesis now.`;

  return { system: SYSTEM_PROMPT, user: userMessage };
}


module.exports = { buildSynthesisPrompt };
