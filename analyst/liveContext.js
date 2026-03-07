'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// fetchLiveContext — Layer 2 dynamic context injection
// Runs all Supabase queries in parallel before every chat call.
// Returns a structured object consumed by buildSystemPrompt().
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

let _sb = null;
function getSupabase() {
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return _sb;
}

async function fetchLiveContext() {
  const sb = getSupabase();

  const [
    delibResult,
    sentimentResult,
    newsResult,
    positionsResult,
    reflectionResult,
    auditResult,
    tradeCountResult,
  ] = await Promise.allSettled([
    // Latest 10 deliberations
    sb.from('deliberations')
      .select('asset, direction, final_decision, status, macro_regime, sentiment_score, bull_score, bear_score, quant_ev, orchestrator_reasoning, created_at')
      .order('created_at', { ascending: false })
      .limit(10),

    // Latest sentiment
    sb.from('sentiment_cache')
      .select('fear_greed_value, fear_greed_label, score, summary, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Unacknowledged news alerts
    sb.from('news_sentinel_log')
      .select('headline, summary, asset, urgency, created_at')
      .eq('is_market_moving', true)
      .order('created_at', { ascending: false })
      .limit(5),

    // Open positions
    sb.from('trades')
      .select('asset, direction, entry_price, position_size_usd, entry_time')
      .is('exit_time', null),

    // Latest weekly reflection
    sb.from('reflections')
      .select('best_agent, worst_agent, systematic_biases, recommendation, week_ending')
      .order('week_ending', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Latest config audit entry
    sb.from('config_audit_log')
      .select('setting_key, old_value, new_value, changed_at, changed_by, reason')
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Count closed trades for Quant bootstrap status
    sb.from('trades')
      .select('id', { count: 'exact', head: true })
      .not('exit_time', 'is', null),
  ]);

  // Safely extract values — Promise.allSettled means no query can crash the chat
  const safe = (result, fallback = null) =>
    result.status === 'fulfilled' ? (result.value?.data ?? fallback) : fallback;

  return {
    deliberations:    safe(delibResult, []),
    sentiment:        safe(sentimentResult),
    news:             safe(newsResult, []),
    positions:        safe(positionsResult, []),
    reflection:       safe(reflectionResult),
    lastConfigChange: safe(auditResult),
    quantTradeCount:  reflectionResult.status === 'fulfilled'
                        ? (tradeCountResult.value?.count ?? 0)
                        : 0,
  };
}

module.exports = { fetchLiveContext };
