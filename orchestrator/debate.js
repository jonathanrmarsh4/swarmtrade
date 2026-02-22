'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Round 2 debate — structured rebuttal exchange.
//
// Three tasks run in parallel via Promise.all():
//
//   Task 1 — Bull rebuttal
//     Bull Agent reads its own Round 1 thesis + Bear Agent's Round 1 thesis.
//     Returns an updated score and rebuttal thesis reflecting the counter-case.
//
//   Task 2 — Bear rebuttal
//     Bear Agent reads its own Round 1 thesis + Bull Agent's Round 1 thesis.
//     Returns an updated score and rebuttal thesis reflecting the counter-case.
//
//   Task 3 — Quant cross-check
//     Quant Agent receives the Sentiment score and asks: is this crowd-mood
//     reading consistent with the statistical edge from Round 1?
//     Returns a conflict flag and explanatory note for the Orchestrator.
//
// Architecture rules enforced here:
//   - Both Bull and Bear must have non-empty Round 1 theses before this runs
//   - All three results are written to Supabase before this function returns
//   - Models come from config/models.js via agent modules — never inline here
//   - Supabase is the single source of truth; no results leave this function
//     unless they are already persisted
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const { analyseRound2: bullRound2 }    = require('../agents/bull/index.js');
const { analyseRound2: bearRound2 }    = require('../agents/bear/index.js');
const { crossCheckSentiment }          = require('../agents/quant/index.js');

// Supabase client — service key required for server-side writes
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);


// ── runRound2 ─────────────────────────────────────────────────────────────────
// Orchestrates all three Round 2 tasks in parallel, persists results to Supabase,
// and returns the full rebuttal payload for the Orchestrator to pass to Round 3.
//
// @param {object} round1Results
//   The complete Round 1 output object assembled by the Orchestrator. Must contain:
//
//   @param {object} round1Results.marketData
//     The market data snapshot used during Round 1. Passed unchanged to agent
//     Round 2 calls so they have the same price/indicator context for rebuttal.
//     Required fields (union of what Bull and Bear prompts need):
//       asset {string}, currentPrice {number}, rsi {number},
//       macdSignal {string}, volume {number},       — for Bull Round 2
//       macd {string}, fundingRate {number},
//       fearGreedIndex {number}, recentRejectionLevels {number[]}  — for Bear Round 2
//
//   @param {object} round1Results.bull
//     Bull Agent Round 1 output: { score: number, thesis: string, data: object }
//
//   @param {object} round1Results.bear
//     Bear Agent Round 1 output: { score: number, thesis: string, data: object }
//
//   @param {object} round1Results.quant
//     Quant Agent Round 1 output: { expectedValue, winRate, avgWin, avgLoss,
//                                   sampleSize, recommendation, data }
//
//   @param {object} round1Results.macro
//     Macro Agent Round 1 output: { regime, flag, summary, keyRisks }
//
//   @param {object} round1Results.sentiment
//     Sentiment Agent Round 1 output: { score, summary, newsInterrupt, sources }
//
// @param {string} deliberationId
//   UUID of the existing deliberations row created at the start of Round 1.
//
// @returns {Promise<{
//   bullRebuttal: { score: number, thesis: string, data: object },
//   bearRebuttal: { score: number, thesis: string, data: object },
//   quantCheck:   { consistent: boolean, conflictFlag: boolean, note: string },
// }>}
async function runRound2(round1Results, deliberationId) {
  const { marketData, bull, bear, quant, sentiment } = round1Results;

  // ── Pre-flight guards ─────────────────────────────────────────────────────
  // These enforce the architecture constraint that Round 1 outputs must be
  // written to Supabase before Round 2 can begin. The calling Orchestrator is
  // responsible for that write; these checks catch any violation early.

  if (!deliberationId || typeof deliberationId !== 'string') {
    throw new Error('[debate] deliberationId is required — cannot persist Round 2 results without it.');
  }

  if (!bull?.thesis || typeof bull.thesis !== 'string' || bull.thesis.trim().length === 0) {
    throw new Error(
      '[debate] Round 2 requires a non-empty bull thesis from Round 1. ' +
      'Ensure Bull Agent output was written to Supabase before calling runRound2.'
    );
  }

  if (!bear?.thesis || typeof bear.thesis !== 'string' || bear.thesis.trim().length === 0) {
    throw new Error(
      '[debate] Round 2 requires a non-empty bear thesis from Round 1. ' +
      'Ensure Bear Agent output was written to Supabase before calling runRound2.'
    );
  }

  if (typeof sentiment?.score !== 'number') {
    throw new Error(
      '[debate] Round 2 requires a numeric sentiment score from Round 1. ' +
      'Ensure Sentiment Agent output was written to Supabase before calling runRound2.'
    );
  }

  if (!marketData || typeof marketData !== 'object') {
    throw new Error('[debate] round1Results.marketData is required for agent Round 2 prompt construction.');
  }

  console.log(
    `[debate] Round 2 starting — deliberation=${deliberationId} ` +
    `bull_r1=${bull.score} bear_r1=${bear.score} sentiment=${sentiment.score} ev=${quant?.expectedValue}`
  );

  // ── Three debate tasks in parallel ───────────────────────────────────────

  const [bullRebuttal, bearRebuttal, quantCheck] = await Promise.all([

    // Task 1 — Bull reads Bear's Round 1 thesis and submits rebuttal
    (async () => {
      console.log(`[debate] Task 1 — Bull rebuttal starting (bear thesis: "${bear.thesis.slice(0, 60)}...")`);
      const result = await bullRound2(marketData, bear.thesis);
      console.log(`[debate] Task 1 — Bull rebuttal complete, updated score=${result.score}`);
      return result;
    })(),

    // Task 2 — Bear reads Bull's Round 1 thesis and submits rebuttal
    (async () => {
      console.log(`[debate] Task 2 — Bear rebuttal starting (bull thesis: "${bull.thesis.slice(0, 60)}...")`);
      const result = await bearRound2(marketData, bull.thesis);
      console.log(`[debate] Task 2 — Bear rebuttal complete, updated score=${result.score}`);
      return result;
    })(),

    // Task 3 — Quant checks if Sentiment crowd-mood is consistent with statistical edge
    (async () => {
      console.log(
        `[debate] Task 3 — Quant cross-check starting ` +
        `(sentiment=${sentiment.score}, ev=${quant?.expectedValue}, recommendation=${quant?.recommendation})`
      );
      const result = await crossCheckSentiment(quant, sentiment.score);
      console.log(
        `[debate] Task 3 — Quant cross-check complete, ` +
        `consistent=${result.consistent} conflictFlag=${result.conflictFlag}`
      );
      return result;
    })(),

  ]);

  // ── Persist Round 2 results to Supabase ──────────────────────────────────
  // bull_rebuttal and bear_rebuttal are thesis strings.
  // The Quant cross-check result is merged into quant_data JSONB alongside
  // the Round 1 statistical metrics already stored there.
  // status advances to 'round2' so the Orchestrator and dashboard can track progress.

  const updatedQuantData = {
    ...(quant?.data ?? {}),
    sentimentCrossCheck: {
      consistent:    quantCheck.consistent,
      conflictFlag:  quantCheck.conflictFlag,
      note:          quantCheck.note,
      sentimentScore: sentiment.score,
      quantEv:        quant?.expectedValue ?? null,
    },
  };

  try {
    const { error } = await supabase
      .from('deliberations')
      .update({
        bull_rebuttal: bullRebuttal.thesis,
        bear_rebuttal: bearRebuttal.thesis,
        quant_data:    updatedQuantData,
        status:        'round2',
      })
      .eq('id', deliberationId);

    if (error) {
      throw new Error(`Supabase update error: ${error.message}`);
    }

    console.log(`[debate] Round 2 results persisted to Supabase — deliberation=${deliberationId}`);

  } catch (err) {
    // Re-throw: the Orchestrator must not proceed to Round 3 if persistence fails.
    // Round 3 reads from Supabase — an unpersisted Round 2 breaks the deliberation chain.
    console.error(`[debate] FATAL — failed to persist Round 2 results: ${err.message}`);
    throw new Error(`[debate] Supabase write failed for deliberation=${deliberationId}: ${err.message}`);
  }

  // ── Return full Round 2 payload for Round 3 ───────────────────────────────
  // Includes updated scores so the Orchestrator can track conviction movement
  // from Round 1 → Round 2 without re-querying Supabase.

  return {
    bullRebuttal,   // { score, thesis, data } — Bull's updated position after reading Bear
    bearRebuttal,   // { score, thesis, data } — Bear's updated position after reading Bull
    quantCheck,     // { consistent, conflictFlag, note } — Sentiment vs EV alignment check
  };
}


module.exports = { runRound2 };
