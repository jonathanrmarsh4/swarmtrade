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
 *
 * Dynamic overrides:
 *  - User can override per-agent models via the Settings dashboard
 *  - Overrides are stored in Supabase system_config under key 'agent_model_config'
 *  - Call loadModelOverrides() once at startup (called automatically on first import)
 *  - MODELS object is mutated in place so all agents pick up changes without restart
 */

// ── Default (recommended) model assignments ───────────────────────────────────

const RECOMMENDED_MODELS = {
  orchestrator: 'claude-sonnet-4-5',
  macro:        'claude-sonnet-4-5',
  bull:         'claude-haiku-4-5-20251001',
  bear:         'claude-haiku-4-5-20251001',
  sentiment:    'claude-haiku-4-5-20251001',
  quant:        'claude-haiku-4-5-20251001',
};

// MODELS is the live object all agents import — starts as defaults, overrides applied on top
const MODELS = { ...RECOMMENDED_MODELS };

// ── Dynamic override loader ────────────────────────────────────────────────────
// Loads user-configured model selections from Supabase and applies them to MODELS.
// Safe to call multiple times — always falls back to RECOMMENDED_MODELS on error.

let _overridesLoaded = false;

async function loadModelOverrides() {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await sb
      .from('system_config')
      .select('value')
      .eq('key', 'agent_model_config')
      .maybeSingle();

    if (error || !data?.value) {
      // No overrides saved yet — use defaults silently
      return;
    }

    const overrides = data.value;
    const validAgents = Object.keys(RECOMMENDED_MODELS);
    const validModels = Object.keys(MODEL_METADATA);

    let applied = 0;
    for (const agent of validAgents) {
      if (overrides[agent] && validModels.includes(overrides[agent])) {
        MODELS[agent] = overrides[agent];
        applied++;
      }
    }

    if (applied > 0) {
      console.log(`[models] Applied ${applied} model override(s) from Supabase`);
      Object.entries(MODELS).forEach(([agent, model]) => {
        const isDefault = model === RECOMMENDED_MODELS[agent];
        console.log(`  ${agent}: ${model}${isDefault ? ' (default)' : ' ← OVERRIDE'}`);
      });
    }
  } catch (err) {
    console.warn('[models] Could not load model overrides — using defaults:', err.message);
    // Reset to defaults on error to be safe
    Object.assign(MODELS, RECOMMENDED_MODELS);
  } finally {
    _overridesLoaded = true;
  }
}

// Auto-load on first import (non-blocking — agents won't wait for this)
// For startup correctness, call await loadModelOverrides() explicitly in index.js
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  loadModelOverrides();
}


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
  RECOMMENDED_MODELS,
  MODEL_METADATA,
  TOKEN_BUDGETS,
  AGENT_OUTPUT_SCHEMA,
  loadModelOverrides,
};
