'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Deliberation Event Emitter
//
// Writes one row to deliberation_events for every meaningful step in the
// pipeline. The dashboard War Room tab subscribes via Supabase Realtime and
// streams events onto the screen as they arrive — giving users a live view
// of the committee deliberating in real time.
//
// Event types:
//   signal_received    — deliberation started, signal details
//   round1_start       — all agents dispatched in parallel
//   agent_complete     — one agent finished (fires 5× in Round 1)
//   agent_failed       — one agent failed/timed out
//   round2_start       — debate phase beginning
//   round2_complete    — debate finished, rebuttals in
//   round3_start       — orchestrator synthesising
//   round3_complete    — decision made
//   risk_gate          — risk agent verdict
//   deliberation_done  — final outcome
//
// All writes are fire-and-forget (non-blocking). A failure here must never
// crash the deliberation pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

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

// Agent display metadata
const AGENT_META = {
  bull:      { emoji: '🟢', label: 'Bull Agent',      color: 'green'  },
  bear:      { emoji: '🔴', label: 'Bear Agent',      color: 'red'    },
  quant:     { emoji: '📊', label: 'Quant Agent',     color: 'blue'   },
  macro:     { emoji: '🌍', label: 'Macro Agent',     color: 'teal'   },
  sentiment: { emoji: '💬', label: 'Sentiment Agent', color: 'amber'  },
  risk:      { emoji: '🛡',  label: 'Risk Gate',       color: 'purple' },
  orchestrator: { emoji: '🧠', label: 'Orchestrator', color: 'blue'   },
};

let _sequenceCounter = 0;

async function emit(deliberationId, signalId, type, payload = {}) {
  if (!deliberationId && !signalId) return;

  _sequenceCounter++;

  try {
    await getSupabase().from('deliberation_events').insert({
      deliberation_id: deliberationId ?? null,
      signal_id:       signalId       ?? null,
      event_type:      type,
      sequence:        _sequenceCounter,
      payload,
      created_at:      new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal — never crash the deliberation over an event write failure
    console.warn(`[events] Failed to emit ${type}: ${err.message}`);
  }
}

// ── Convenience emitters ──────────────────────────────────────────────────────

function emitSignalReceived(signalId, signal) {
  return emit(null, signalId, 'signal_received', {
    asset:       signal.asset,
    direction:   signal.direction,
    timeframe:   signal.timeframe  ?? '1h',
    signal_type: signal.signal_type ?? 'unknown',
    message:     `Signal received — ${signal.asset} ${signal.direction?.toUpperCase()}`,
  });
}

function emitRound1Start(deliberationId, signalId) {
  return emit(deliberationId, signalId, 'round1_start', {
    message: 'Round 1 started — all agents analysing in parallel',
    agents:  ['bull', 'bear', 'quant', 'macro', 'sentiment'],
  });
}

function emitAgentComplete(deliberationId, signalId, agentName, result) {
  const meta = AGENT_META[agentName] ?? { emoji: '🤖', label: agentName, color: 'gray' };

  // Build a human-readable summary per agent type
  let summary = '';
  let score   = null;

  if (agentName === 'bull' || agentName === 'bear') {
    score   = result.score;
    summary = result.thesis ?? '';
  } else if (agentName === 'quant') {
    summary = `EV: ${result.expectedValue?.toFixed?.(3) ?? '—'} · Win rate: ${result.winRate != null ? (result.winRate * 100).toFixed(0) + '%' : '—'} · Recommendation: ${result.recommendation ?? '—'}`;
  } else if (agentName === 'macro') {
    summary = `Regime: ${result.regime} · ${result.summary ?? ''}`;
  } else if (agentName === 'sentiment') {
    score   = result.score;
    summary = result.summary ?? '';
  }

  return emit(deliberationId, signalId, 'agent_complete', {
    agent:   agentName,
    emoji:   meta.emoji,
    label:   meta.label,
    color:   meta.color,
    score,
    summary: summary.slice(0, 300), // truncate for display
    message: `${meta.emoji} ${meta.label} complete${score != null ? ` — score ${score}` : ''}`,
  });
}

function emitAgentFailed(deliberationId, signalId, agentName, reason) {
  const meta = AGENT_META[agentName] ?? { emoji: '🤖', label: agentName, color: 'gray' };
  return emit(deliberationId, signalId, 'agent_failed', {
    agent:   agentName,
    emoji:   meta.emoji,
    label:   meta.label,
    color:   meta.color,
    reason:  reason?.slice(0, 200) ?? 'Unknown error',
    message: `${meta.emoji} ${meta.label} failed — using neutral default`,
  });
}

function emitRound2Start(deliberationId, signalId) {
  return emit(deliberationId, signalId, 'round2_start', {
    message: 'Round 2 — Bull vs Bear debate beginning',
  });
}

function emitRound2Complete(deliberationId, signalId, { bullRebuttal, bearRebuttal }) {
  return emit(deliberationId, signalId, 'round2_complete', {
    bull_rebuttal: bullRebuttal?.slice(0, 300) ?? '',
    bear_rebuttal: bearRebuttal?.slice(0, 300) ?? '',
    message:       'Round 2 complete — rebuttals received',
  });
}

function emitRound3Start(deliberationId, signalId) {
  return emit(deliberationId, signalId, 'round3_start', {
    message: '🧠 Orchestrator synthesising all inputs…',
  });
}

function emitRound3Complete(deliberationId, signalId, { voteResult, decision, reasoning }) {
  return emit(deliberationId, signalId, 'round3_complete', {
    vote_result: voteResult,
    decision,
    reasoning:   reasoning?.slice(0, 500) ?? '',
    message:     `Synthesis complete — vote: ${voteResult} → ${decision?.toUpperCase()}`,
  });
}

function emitRiskGate(deliberationId, signalId, { approved, reason, positionSizePct }) {
  return emit(deliberationId, signalId, 'risk_gate', {
    approved,
    reason:           reason ?? '',
    position_size_pct: positionSizePct ?? 0,
    message: approved
      ? `🛡 Risk Gate — APPROVED ✓ (${positionSizePct}% position)`
      : `🛡 Risk Gate — VETOED ✗ — ${reason}`,
  });
}

function emitDone(deliberationId, signalId, { decision, riskApproved, elapsedMs }) {
  const outcome = riskApproved ? '🟢 TRADE APPROVED' : decision === 'hold' ? '⏸ HOLD' : '🔴 VETOED';
  return emit(deliberationId, signalId, 'deliberation_done', {
    decision,
    risk_approved: riskApproved,
    elapsed_ms:    elapsedMs,
    message:       `Deliberation complete — ${outcome} (${(elapsedMs / 1000).toFixed(1)}s)`,
  });
}

module.exports = {
  emitSignalReceived,
  emitRound1Start,
  emitAgentComplete,
  emitAgentFailed,
  emitRound2Start,
  emitRound2Complete,
  emitRound3Start,
  emitRound3Complete,
  emitRiskGate,
  emitDone,
};
