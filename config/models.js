/**
 * /config/models.js
 *
 * SINGLE SOURCE OF TRUTH for all Anthropic model assignments.
 *
 * Rules:
 *  - Never hardcode a model string anywhere else in the codebase
 *  - Always import from this file in agent services
 *  - Risk Agent must never import from this file (no LLM)
 *  - To upgrade or change a model, change it here only
 *
 * Model tier rationale:
 *  - SONNET  → Complex reasoning, synthesis, world knowledge (Orchestrator, Macro)
 *  - HAIKU   → Speed-optimised, parallel execution, focused tasks (Bull, Bear, Sentiment, Quant)
 *  - NONE    → Risk Agent is a deterministic rules engine. Zero LLM calls. Zero tolerance.
 */

const MODELS = {

  // ── Tier 1: Claude Sonnet ─────────────────────────────────────────────────
  // Use for agents requiring nuanced reasoning, synthesis, or broad world knowledge.

  /** Orchestrator — synthesises all agent outputs into final trade decision */
  orchestrator: 'claude-sonnet-4-5',

  /** Macro Agent — requires broad economic and geopolitical knowledge */
  macro: 'claude-sonnet-4-5',


  // ── Tier 2: Claude Haiku ──────────────────────────────────────────────────
  // Use for agents that run in parallel, are speed-sensitive, or have focused tasks.

  /** Bull Agent — momentum analysis, runs in parallel with Bear and Sentiment */
  bull: 'claude-haiku-4-5-20251001',

  /** Bear Agent — contrarian analysis, runs in parallel with Bull and Sentiment */
  bear: 'claude-haiku-4-5-20251001',

  /** Sentiment Agent — high-frequency polling, news detection, crowd thermometer */
  sentiment: 'claude-haiku-4-5-20251001',

  /** Quant Agent — deterministic calculations, Haiku used for output formatting only */
  quant: 'claude-haiku-4-5-20251001',


  // ── Tier 3: No Model ──────────────────────────────────────────────────────
  // Risk Agent is intentionally absent. It is a deterministic rules engine.
  // Any Anthropic API call in /agents/risk/ is a critical bug.

};


// ── Model metadata ────────────────────────────────────────────────────────────
// Informational only — used for logging, dashboard display, and cost tracking.

const MODEL_METADATA = {
  'claude-sonnet-4-5': {
    tier: 'sonnet',
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    maxTokens: 8192,
    notes: 'Complex reasoning. Use for Orchestrator and Macro only.',
  },
  'claude-haiku-4-5-20251001': {
    tier: 'haiku',
    costPer1kInputTokens: 0.00025,
    costPer1kOutputTokens: 0.00125,
    maxTokens: 4096,
    notes: 'Speed optimised. Use for parallel agent execution.',
  },
};


// ── Token budgets per agent ───────────────────────────────────────────────────
// Controls max_tokens in each Anthropic API call.
// Keeps costs predictable and prevents runaway responses.

const TOKEN_BUDGETS = {
  orchestrator: 2048,   // Needs room for full synthesis and reasoning
  macro:        1024,   // Regime classification + risk flag — concise
  bull:          512,   // Score + thesis — should be tight and opinionated
  bear:          512,   // Score + counter-thesis — same
  sentiment:     768,   // Score + narrative + news flag
  quant:         512,   // EV calculation + data summary
};


// ── Required output structure per agent ──────────────────────────────────────
// Documents what each agent must return. Used for validation before Supabase write.
// If an agent response doesn't match this shape, reject it and log the error.

const AGENT_OUTPUT_SCHEMA = {
  bull: {
    score:  'number (0-100)',
    thesis: 'string',
    data:   'object (supporting market data used)',
  },
  bear: {
    score:  'number (0-100)',
    thesis: 'string',
    data:   'object (supporting market data used)',
  },
  quant: {
    expectedValue:  'number',
    winRate:        'number (0-1)',
    avgWin:         'number (percentage)',
    avgLoss:        'number (percentage)',
    sampleSize:     'number (historical occurrences)',
    recommendation: 'string (take | skip)',
  },
  macro: {
    regime:         'string (risk-on | risk-off | neutral)',
    flag:           'boolean (true = reduce position sizing 50%)',
    summary:        'string',
    keyRisks:       'array of strings',
  },
  sentiment: {
    score:          'number (0-100)',
    summary:        'string',
    newsInterrupt:  'boolean (true = News Sentinel fired, review positions)',
    sources:        'array of strings (which sources contributed)',
  },
  orchestrator: {
    voteResult:     'string (unanimous | divided | contested)',
    decision:       'string (trade | hold | veto)',
    reasoning:      'string (full synthesis)',
    positionNote:   'string (sizing rationale)',
  },
};


module.exports = {
  MODELS,
  MODEL_METADATA,
  TOKEN_BUDGETS,
  AGENT_OUTPUT_SCHEMA,
};
