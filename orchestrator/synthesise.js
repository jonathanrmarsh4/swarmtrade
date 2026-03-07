'use strict';

// ── Orchestrator — Round 3 synthesis ─────────────────────────────────────────
// Receives all Round 1 outputs and Round 2 rebuttals, synthesises them into a
// final trade decision, and updates the deliberations row in Supabase.
//
// Model: claude-sonnet-4-5 (via MODELS.orchestrator from /config/models.js)
//
// Decision flow:
//   1. Normalize all agent outputs to a shared 0-100 "support for trade" scale
//   2. Classify the vote deterministically (unanimous | divided | contested)
//   3. Check mandatory veto conditions deterministically — these are JS rules,
//      not LLM judgements; the LLM cannot override them
//   4. Call Sonnet with the full deliberation context for reasoning and narrative
//   5. Override LLM decision if veto conditions were active but LLM missed them
//   6. Validate output against AGENT_OUTPUT_SCHEMA.orchestrator
//   7. Update deliberations row in Supabase (status: round3)

const Anthropic      = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const { MODELS, TOKEN_BUDGETS, AGENT_OUTPUT_SCHEMA } = require('../config/models.js');
const { buildSynthesisPrompt } = require('./prompt.js');

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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


// ── fetchAgentWeights ─────────────────────────────────────────────────────────
// Fetches the current reputation weight for each agent from the agent_reputation
// table. Returns the most recent weight per agent (latest week_ending).
//
// If < 10 trades have been sampled for an agent (or no data exists), uses 1.0.
// Weight > 1.0 = agent has outperformed; < 1.0 = underperformed.
//
// @returns {Promise<{ bull: number, bear: number, quant: number, macro: number, sentiment: number }>}
async function fetchAgentWeights() {
  const agentNames = ['bull', 'bear', 'quant', 'macro', 'sentiment'];
  const weights = {};

  try {
    // Fetch latest reputation record per agent
    for (const agentName of agentNames) {
      const { data, error } = await getSupabase()
        .from('agent_reputation')
        .select('current_weight, trades_sampled')
        .eq('agent_name', agentName)
        .order('week_ending', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          `[orchestrator] Failed to fetch reputation for ${agentName}: ${error.message}. Using default weight 1.0.`,
        );
        weights[agentName] = 1.0;
        continue;
      }

      // Use default weight if insufficient data or no record
      if (!data || data.trades_sampled < 10) {
        weights[agentName] = 1.0;
        if (data) {
          console.log(
            `[orchestrator] ${agentName} has only ${data.trades_sampled} trades sampled — using default weight 1.0`,
          );
        }
      } else {
        weights[agentName] = data.current_weight;
        console.log(
          `[orchestrator] ${agentName} weight: ${data.current_weight} (${data.trades_sampled} trades sampled)`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[orchestrator] Unexpected error fetching agent weights: ${err.message}. Using defaults.`,
    );
    // Fallback to defaults on any unexpected error
    agentNames.forEach((name) => {
      weights[name] = 1.0;
    });
  }

  return weights;
}


// ── normalizeScores ───────────────────────────────────────────────────────────
// Converts each agent's raw output into a 0-100 "support for trade direction"
// score, where 100 = strongly supports entering the signal and 0 = strongly
// opposes it. Direction-aware: long/close and short invert several agents.
//
// Bull:      high score → bullish → supports long; opposes short
// Bear:      high score → bearish → opposes long; supports short
// Quant:     EV > 0 → favour taking the signal (70), else oppose (30)
// Macro:     regime and flag map to a caution-adjusted support score
// Sentiment: high score → bullish → supports long; opposes short
//
// 'close' is treated as a directional-bearish action (exit = bearish view wins).
//
// @param {object} r1        — round1Results
// @param {string} direction — 'long' | 'short' | 'close'
// @returns {{ bull, bear, quant, macro, sentiment }}
function normalizeScores(r1, direction) {
  // Bootstrap mode: sampleSize < 10 means no historical data, not a bad edge.
  // Neutral 50 so quant doesn't drag the vote down when it has nothing to say.
  // Once 10+ trades are closed, EV > 0 → 70 (positive edge) or EV ≤ 0 → 30 (negative edge).
  const quantScore = r1.quant.sampleSize < 10
    ? 50
    : r1.quant.expectedValue > 0 ? 70 : 30;

  // Macro base score: how supportive is the macro environment for taking a trade?
  // Risk-on favours longs; risk-off favours exits/shorts.
  let macroScore;
  if (direction === 'long') {
    macroScore = { 'risk-on': 70, 'neutral': 50, 'risk-off': 30 }[r1.macro.regime] ?? 50;
    // Macro flag = heightened systemic risk → pull support toward caution by 15 pts
    if (r1.macro.flag) macroScore = Math.max(0, macroScore - 15);
  } else {
    // short / close: risk-off environment supports exiting or shorting
    macroScore = { 'risk-off': 70, 'neutral': 50, 'risk-on': 30 }[r1.macro.regime] ?? 50;
    // Macro flag still signals caution even for short/close trades
    if (r1.macro.flag) macroScore = Math.max(0, macroScore - 10);
  }

  if (direction === 'long') {
    return {
      bull:      r1.bull.score,
      bear:      100 - r1.bear.score,
      quant:     quantScore,
      macro:     macroScore,
      sentiment: r1.sentiment.score,
    };
  }

  // short or close: directional agents invert
  return {
    bull:      100 - r1.bull.score,
    bear:      r1.bear.score,
    quant:     quantScore,
    macro:     macroScore,
    sentiment: 100 - r1.sentiment.score,
  };
}


// ── classifyVote ──────────────────────────────────────────────────────────────
// Classifies the committee vote from normalized support scores, using agent
// reputation weights to compute weighted scores.
//
// unanimous : 4 or 5 agents on the same side, score range < 20 points
// divided   : 3:2 split (3 supporting, 2 opposing, or inverse)
// contested : wide disagreement (range > 40 points) or any other pattern
//
// Weighted scores are used for classification to give more influence to agents
// with proven track records (weight > 1.0) and less to underperformers (< 1.0).
//
// @param {{ bull, bear, quant, macro, sentiment }} normalizedScores
// @param {{ bull, bear, quant, macro, sentiment }} weights
// @returns {'unanimous' | 'divided' | 'contested'}
function classifyVote(normalizedScores, weights) {
  // Compute weighted scores
  const weightedScores = {
    bull:      normalizedScores.bull * weights.bull,
    bear:      normalizedScores.bear * weights.bear,
    quant:     normalizedScores.quant * weights.quant,
    macro:     normalizedScores.macro * weights.macro,
    sentiment: normalizedScores.sentiment * weights.sentiment,
  };

  const scores    = Object.values(weightedScores);
  const min       = Math.min(...scores);
  const max       = Math.max(...scores);
  const range     = max - min;
  const forTrade  = scores.filter(s => s >= 50).length;
  const against   = 5 - forTrade;

  // Unanimous: strong alignment on one side, tight clustering
  if ((forTrade >= 4 || against >= 4) && range < 20) return 'unanimous';

  // Contested: too spread out to call a clear direction
  if (range > 40) return 'contested';

  // Divided: genuine 3:2 split
  if (forTrade === 3 || forTrade === 2) return 'divided';

  // Catch-all — unaligned but not clearly divided
  return 'contested';
}


// ── computeVetoReasons ────────────────────────────────────────────────────────
// Returns an array of human-readable veto reason strings for each triggered
// mandatory veto condition. An empty array means no veto is required.
//
// Conditions are checked in JS — they are not delegated to the LLM.
//
// @param {object} r1               — round1Results
// @param {object} normalizedScores — output of normalizeScores()
// @returns {string[]}
function computeVetoReasons(r1, normalizedScores) {
  const reasons = [];

  // Condition 1: macro flag active AND bear conviction > 60
  // Rationale: macro risk flag combined with a strongly bearish committee member
  // represents compounding risk — the expected loss exceeds acceptable bounds.
  if (r1.macro.flag && r1.bear.score > 60) {
    reasons.push(
      `Macro flag active with strong Bear conviction (Bear score ${r1.bear.score}/100 > 60) — ` +
      `combined macro and bear risk exceeds entry threshold`,
    );
  }

  // Condition 2: news interrupt active — always pause for breaking headlines
  if (r1.sentiment.newsInterrupt) {
    reasons.push(
      `News Sentinel interrupt active — breaking news detected, pausing to avoid ` +
      `trading into an unreviewed headline`,
    );
  }

  // Condition 3: 3 or more agents strongly oppose the trade direction
  // Strong opposition = normalized support < 30 (i.e. > 70 points against)
  const stronglyAgainst = Object.entries(normalizedScores)
    .filter(([, score]) => score < 30)
    .map(([name]) => name);

  if (stronglyAgainst.length >= 3) {
    reasons.push(
      `${stronglyAgainst.length} agents (${stronglyAgainst.join(', ')}) show strong opposition ` +
      `to the trade direction (normalized support < 30/100)`,
    );
  }

  return reasons;
}


// ── validateOutput ────────────────────────────────────────────────────────────
// Validates the parsed LLM response against AGENT_OUTPUT_SCHEMA.orchestrator.
// Throws a descriptive error on any violation — never silently passes bad data.
//
// @param {object} parsed — raw JSON parsed from the LLM response
// @throws {Error} if validation fails
function validateOutput(parsed) {
  void AGENT_OUTPUT_SCHEMA.orchestrator;

  const validVoteResults = new Set(['unanimous', 'divided', 'contested']);
  const validDecisions   = new Set(['trade', 'hold', 'veto']);
  const errors = [];

  if (!validVoteResults.has(parsed.voteResult)) {
    errors.push(
      `voteResult must be 'unanimous', 'divided', or 'contested' — got: ${JSON.stringify(parsed.voteResult)}`,
    );
  }
  if (!validDecisions.has(parsed.decision)) {
    errors.push(
      `decision must be 'trade', 'hold', or 'veto' — got: ${JSON.stringify(parsed.decision)}`,
    );
  }
  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim().length === 0) {
    errors.push('reasoning must be a non-empty string');
  }
  if (typeof parsed.positionNote !== 'string' || parsed.positionNote.trim().length === 0) {
    errors.push('positionNote must be a non-empty string');
  }

  if (errors.length > 0) {
    throw new Error(
      `[orchestrator] Output validation failed against AGENT_OUTPUT_SCHEMA.orchestrator:\n  ${errors.join('\n  ')}`,
    );
  }
}


// ── callLLM ───────────────────────────────────────────────────────────────────
// Sends the synthesis prompt to Anthropic and returns the parsed JSON response.
// Model and token budget are always sourced from config/models.js — never inline.
//
// @param {string} system — system prompt
// @param {string} user   — user message
// @returns {Promise<object>} — parsed JSON from the LLM
async function callLLM(system, user) {
  const response = await anthropic.messages.create({
    model:      MODELS.orchestrator,          // ← from config/models.js only
    max_tokens: TOKEN_BUDGETS.orchestrator,   // ← from config/models.js only
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw = response.content[0]?.text ?? '';

  let parsed;
  try {
    // Strip accidental markdown fences if the model wraps its JSON
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`[orchestrator] LLM returned non-JSON output:\n${raw}`);
  }

  return parsed;
}


// ── updateDeliberation ────────────────────────────────────────────────────────
// Persists the orchestrator's final decision to the deliberations row.
// Also writes `status = 'round3'` — this column requires migration
// 005_deliberation_status.sql if it does not yet exist.
//
// Errors are logged and do not propagate — a write failure must not block
// the Risk Agent receiving the proposal from synthesise().
//
// @param {string} deliberationId — UUID of the deliberations row
// @param {object} result         — validated orchestrator output
// @param {object} weightsSnapshot — agent reputation weights used in this deliberation
async function updateDeliberation(deliberationId, result, weightsSnapshot) {
  try {
    const { error } = await getSupabase()
      .from('deliberations')
      .update({
        final_decision:         result.decision,
        orchestrator_reasoning: result.reasoning,
        weights_snapshot:       weightsSnapshot,  // Store weights used for this deliberation
        // status requires migration 005_deliberation_status.sql
        status:                 'round3',
      })
      .eq('id', deliberationId);

    if (error) {
      console.error(
        `[orchestrator] Supabase update failed for deliberation ${deliberationId}: ${error.message}`,
      );
    } else {
      console.log(
        `[orchestrator] Deliberation ${deliberationId} updated — ` +
        `status=round3 decision=${result.decision} voteResult=${result.voteResult}`,
      );
    }
  } catch (err) {
    console.error(
      `[orchestrator] Unexpected error updating deliberation ${deliberationId}: ${err.message}`,
    );
  }
}


// ── synthesise ────────────────────────────────────────────────────────────────
// Round 3 entry point called by the Orchestrator after all Round 2 rebuttals
// have been written to Supabase.
//
// @param {object} round1Results
// @param {object} round1Results.signal                  — { asset, direction, timeframe, signalType }
// @param {object} round1Results.bull                    — { score, thesis, data }
// @param {object} round1Results.bear                    — { score, thesis, data }
// @param {object} round1Results.quant                   — { expectedValue, winRate, avgWin, avgLoss, sampleSize, recommendation }
// @param {object} round1Results.macro                   — { regime, flag, summary, keyRisks }
// @param {object} round1Results.sentiment               — { score, summary, newsInterrupt, sources }
//
// @param {object} round2Results
// @param {object} round2Results.bullRebuttal            — { score, thesis, data }
// @param {object} round2Results.bearRebuttal            — { score, thesis, data }
//
// @param {string} deliberationId — UUID of the deliberations row to update
//
// @returns {Promise<{
//   voteResult:   'unanimous' | 'divided' | 'contested',
//   decision:     'trade' | 'hold' | 'veto',
//   reasoning:    string,
//   positionNote: string,
// }>}
async function synthesise(round1Results, round2Results, deliberationId) {
  const { signal } = round1Results;

  console.log(
    `[orchestrator] Round 3 synthesis starting — ` +
    `deliberationId=${deliberationId} asset=${signal.asset} direction=${signal.direction}`,
  );

  // ── Step 0: Fetch agent reputation weights ───────────────────────────────────
  const weights = await fetchAgentWeights();

  console.log(
    `[orchestrator] Agent weights loaded — ` +
    `bull=${weights.bull} bear=${weights.bear} quant=${weights.quant} ` +
    `macro=${weights.macro} sentiment=${weights.sentiment}`,
  );

  // ── Step 1: Normalize all agent scores to a shared 0-100 support scale ──────
  const normalizedScores = normalizeScores(round1Results, signal.direction);

  console.log(
    `[orchestrator] Normalized support scores — ` +
    `bull=${normalizedScores.bull} bear=${normalizedScores.bear} ` +
    `quant=${normalizedScores.quant} macro=${normalizedScores.macro} sentiment=${normalizedScores.sentiment}`,
  );

  // Compute weighted scores for classification and logging
  const weightedScores = {
    bull:      normalizedScores.bull * weights.bull,
    bear:      normalizedScores.bear * weights.bear,
    quant:     normalizedScores.quant * weights.quant,
    macro:     normalizedScores.macro * weights.macro,
    sentiment: normalizedScores.sentiment * weights.sentiment,
  };

  console.log(
    `[orchestrator] Weighted support scores — ` +
    `bull=${weightedScores.bull.toFixed(1)} bear=${weightedScores.bear.toFixed(1)} ` +
    `quant=${weightedScores.quant.toFixed(1)} macro=${weightedScores.macro.toFixed(1)} sentiment=${weightedScores.sentiment.toFixed(1)}`,
  );

  // ── Step 2: Classify vote deterministically using weighted scores ─────────────
  const scoreValues      = Object.values(weightedScores);
  const scoreRange       = Math.max(...scoreValues) - Math.min(...scoreValues);
  const voteClassification = classifyVote(normalizedScores, weights);

  console.log(
    `[orchestrator] Vote classification=${voteClassification} weightedScoreRange=${scoreRange.toFixed(1)}`,
  );

  // ── Step 3: Check mandatory veto conditions ──────────────────────────────────
  const activeVetoConditions = computeVetoReasons(round1Results, normalizedScores);

  if (activeVetoConditions.length > 0) {
    console.warn(
      `[orchestrator] ${activeVetoConditions.length} mandatory veto condition(s) active — ` +
      `decision will be forced to 'veto' regardless of LLM output`,
    );
  }

  // ── Step 4: Build prompt and call Sonnet for synthesis ───────────────────────
  const preComputed = {
    voteClassification,
    scoreRange,
    activeVetoConditions,
    normalizedScores,
    weights,              // ← Pass weights to prompt builder
    weightedScores,       // ← Pass weighted scores to prompt builder
  };

  const { system, user } = buildSynthesisPrompt(round1Results, round2Results, preComputed);

  let parsed;
  try {
    parsed = await callLLM(system, user);
  } catch (err) {
    console.error(`[orchestrator] Round 3 LLM call failed: ${err.message}`);
    throw err;
  }

  // ── Step 5: Enforce deterministic overrides ───────────────────────────────────
  // Veto conditions computed in JS are authoritative — the LLM cannot override them.
  if (activeVetoConditions.length > 0 && parsed.decision !== 'veto') {
    console.warn(
      `[orchestrator] LLM returned decision='${parsed.decision}' despite active veto conditions. ` +
      `Overriding to 'veto'.`,
    );
    parsed.decision    = 'veto';
    parsed.positionNote = `No position — veto conditions active: ${activeVetoConditions.join(' | ')}`;
  }

  // Vote classification is deterministic — LLM reasoning may reference it but cannot change it.
  if (parsed.voteResult !== voteClassification) {
    console.warn(
      `[orchestrator] LLM voteResult '${parsed.voteResult}' differs from computed ` +
      `'${voteClassification}'. Using computed value.`,
    );
    parsed.voteResult = voteClassification;
  }

  // ── Step 6: Validate output against AGENT_OUTPUT_SCHEMA.orchestrator ─────────
  try {
    validateOutput(parsed);
  } catch (err) {
    console.error(err.message);
    throw err;
  }

  const result = {
    voteResult:   parsed.voteResult,
    decision:     parsed.decision,
    reasoning:    parsed.reasoning.trim(),
    positionNote: parsed.positionNote.trim(),
  };

  console.log(
    `[orchestrator] Round 3 complete — ` +
    `voteResult=${result.voteResult} decision=${result.decision}`,
  );

  // ── Step 7: Update Supabase deliberations row ─────────────────────────────────
  // Write does not block the return — errors are logged and surfaced via console
  // only. The caller (orchestrator/index.js) must not depend on this write
  // succeeding before passing result to the Risk Agent.
  await updateDeliberation(deliberationId, result, weights);

  return result;
}


module.exports = { synthesise };
