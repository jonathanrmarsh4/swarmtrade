// WarRoom — live streaming deliberation view.
// Subscribes to deliberation_events via Supabase Realtime and renders
// each event as it arrives, giving the user a front-row seat to the
// agent committee deliberating in real time.

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:         '#080f1a',
  surface:    '#0d1829',
  surface2:   '#112236',
  border:     '#1a3045',
  borderGlow: '#1e4060',
  green:      '#00ff88',
  greenDim:   '#00c86d',
  red:        '#ff4466',
  redDim:     '#cc2244',
  blue:       '#4db8ff',
  amber:      '#ffb340',
  purple:     '#b388ff',
  teal:       '#00e5cc',
  gray:       '#4a6080',
  text:       '#e8f4ff',
  textMuted:  '#4a7090',
  textFaint:  '#243040',
};

// ── Event type config ─────────────────────────────────────────────────────────
const EVENT_CONFIG = {
  signal_received:   { label: 'Signal Received',     icon: '⚡', color: C.blue,   dim: false },
  round1_start:      { label: 'Round 1 — Analysis',  icon: '🔬', color: C.amber,  dim: false },
  agent_complete:    { label: 'Agent Complete',       icon: '✓',  color: C.green,  dim: false },
  agent_failed:      { label: 'Agent Failed',         icon: '✗',  color: C.red,    dim: false },
  round2_start:      { label: 'Round 2 — Debate',     icon: '⚔️',  color: C.amber,  dim: false },
  round2_complete:   { label: 'Debate Complete',      icon: '💬', color: C.teal,   dim: false },
  round3_start:      { label: 'Round 3 — Synthesis',  icon: '🧠', color: C.purple, dim: false },
  round3_complete:   { label: 'Decision Made',        icon: '⚖️',  color: C.blue,   dim: false },
  risk_gate:         { label: 'Risk Gate',            icon: '🛡',  color: C.purple, dim: false },
  deliberation_done: { label: 'Complete',             icon: '🏁', color: C.green,  dim: false },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit' });
}

function directionColor(direction) {
  return direction === 'long' ? C.green : direction === 'short' ? C.red : C.blue;
}

// ── Event card renderers ──────────────────────────────────────────────────────

function SignalReceivedCard({ payload }) {
  const color = directionColor(payload.direction);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 900, color, letterSpacing: '-0.02em' }}>
          {payload.asset}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 800, color,
          background: `${color}18`, border: `1px solid ${color}40`,
          borderRadius: 20, padding: '2px 10px', letterSpacing: '0.1em',
        }}>
          {payload.direction?.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: C.textMuted }}>
          {payload.timeframe} · {payload.signal_type}
        </span>
      </div>
    </div>
  );
}

function Round1StartCard({ payload }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {(payload.agents ?? []).map(a => (
        <span key={a} style={{
          fontSize: 11, color: C.textMuted,
          background: C.surface2, border: `1px solid ${C.border}`,
          borderRadius: 20, padding: '2px 9px',
        }}>
          {a}
        </span>
      ))}
    </div>
  );
}

function AgentCompleteCard({ payload }) {
  const scoreColor = payload.score >= 60 ? C.green : payload.score <= 40 ? C.red : C.amber;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18 }}>{payload.emoji}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{payload.label}</span>
        {payload.score != null && (
          <span style={{
            fontSize: 18, fontWeight: 900, color: scoreColor,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {payload.score}
          </span>
        )}
      </div>
      {payload.summary && (
        <p style={{
          margin: 0, fontSize: 12, color: C.textMuted,
          lineHeight: 1.6, borderLeft: `2px solid ${C.border}`,
          paddingLeft: 10, fontStyle: 'italic',
        }}>
          "{payload.summary}"
        </p>
      )}
      {/* Score bar */}
      {payload.score != null && (
        <div style={{ height: 3, background: C.surface2, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${payload.score}%`,
            background: scoreColor,
            borderRadius: 2,
            transition: 'width 0.8s ease',
            boxShadow: `0 0 6px ${scoreColor}60`,
          }} />
        </div>
      )}
    </div>
  );
}

function AgentFailedCard({ payload }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 16 }}>{payload.emoji}</span>
      <span style={{ fontSize: 13, color: C.red }}>{payload.label} — using neutral default</span>
    </div>
  );
}

function DebateCard({ payload, type }) {
  if (type === 'round2_start') {
    return (
      <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>
        Bull and Bear reading each other's Round 1 analyses…
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {payload.bull_rebuttal && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.green, letterSpacing: '0.1em', marginBottom: 4 }}>
            🟢 BULL REBUTTAL
          </div>
          <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>
            "{payload.bull_rebuttal}"
          </p>
        </div>
      )}
      {payload.bear_rebuttal && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.red, letterSpacing: '0.1em', marginBottom: 4 }}>
            🔴 BEAR REBUTTAL
          </div>
          <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>
            "{payload.bear_rebuttal}"
          </p>
        </div>
      )}
    </div>
  );
}

function SynthesisCard({ payload, type }) {
  if (type === 'round3_start') {
    return (
      <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>
        Weighing all agent inputs and debate…
      </p>
    );
  }
  const decisionColor = payload.decision === 'trade' ? C.green
                      : payload.decision === 'hold'  ? C.amber
                      : C.red;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          fontSize: 13, fontWeight: 900, color: decisionColor,
          background: `${decisionColor}18`, border: `1px solid ${decisionColor}40`,
          borderRadius: 20, padding: '3px 12px', letterSpacing: '0.08em',
        }}>
          {payload.decision?.toUpperCase()} — {payload.vote_result}
        </span>
      </div>
      {payload.reasoning && (
        <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>
          "{payload.reasoning}"
        </p>
      )}
    </div>
  );
}

function RiskGateCard({ payload }) {
  const color = payload.approved ? C.green : C.red;
  const label = payload.approved ? '✓ APPROVED' : '✗ VETOED';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 16 }}>🛡</span>
        <span style={{
          fontSize: 14, fontWeight: 900, color,
          background: `${color}18`, border: `1px solid ${color}60`,
          borderRadius: 20, padding: '4px 14px', letterSpacing: '0.08em',
          boxShadow: `0 0 12px ${color}30`,
        }}>
          {label}
        </span>
        {payload.approved && payload.position_size_pct > 0 && (
          <span style={{ fontSize: 12, color: C.textMuted }}>
            Position: {payload.position_size_pct}%
          </span>
        )}
      </div>
      {payload.reason && (
        <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>
          "{payload.reason}"
        </p>
      )}
    </div>
  );
}

function DoneCard({ payload }) {
  const approved = payload.risk_approved;
  const color = approved ? C.green : payload.decision === 'hold' ? C.amber : C.red;
  const outcome = approved ? '🟢 TRADE APPROVED' : payload.decision === 'hold' ? '⏸ HOLD' : '🔴 VETOED';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{
        fontSize: 15, fontWeight: 900, color,
        textShadow: `0 0 20px ${color}60`,
      }}>
        {outcome}
      </span>
      <span style={{ fontSize: 11, color: C.textMuted }}>
        {payload.elapsed_ms ? `${(payload.elapsed_ms / 1000).toFixed(1)}s` : ''}
      </span>
    </div>
  );
}

// ── Event Card ────────────────────────────────────────────────────────────────

function EventCard({ event, isNew }) {
  const config = EVENT_CONFIG[event.event_type] ?? { label: event.event_type, icon: '•', color: C.gray };
  const payload = event.payload ?? {};

  return (
    <div style={{
      display: 'flex', gap: 14,
      padding: '14px 0',
      borderBottom: `1px solid ${C.border}`,
      animation: isNew ? 'slideIn 0.4s ease' : 'none',
      opacity: 1,
    }}>
      {/* Timeline spine */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 32, flexShrink: 0 }}>
        <div style={{
          width: 28, height: 28,
          borderRadius: '50%',
          background: `${config.color}15`,
          border: `1px solid ${config.color}50`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13,
          boxShadow: isNew ? `0 0 12px ${config.color}40` : 'none',
        }}>
          {config.icon}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: config.color }}>
            {config.label}
          </span>
          <span style={{ fontSize: 10, color: C.textMuted }}>
            {timeAgo(event.created_at)}
          </span>
        </div>

        {event.event_type === 'signal_received'   && <SignalReceivedCard payload={payload} />}
        {event.event_type === 'round1_start'      && <Round1StartCard payload={payload} />}
        {event.event_type === 'agent_complete'    && <AgentCompleteCard payload={payload} />}
        {event.event_type === 'agent_failed'      && <AgentFailedCard payload={payload} />}
        {(event.event_type === 'round2_start' || event.event_type === 'round2_complete') && <DebateCard payload={payload} type={event.event_type} />}
        {(event.event_type === 'round3_start' || event.event_type === 'round3_complete') && <SynthesisCard payload={payload} type={event.event_type} />}
        {event.event_type === 'risk_gate'         && <RiskGateCard payload={payload} />}
        {event.event_type === 'deliberation_done' && <DoneCard payload={payload} />}
      </div>
    </div>
  );
}

// ── Idle state ────────────────────────────────────────────────────────────────

function IdleState() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const i = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 600);
    return () => clearInterval(i);
  }, []);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '60px 20px', gap: 20,
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: '50%',
        border: `2px solid ${C.borderGlow}`,
        borderTopColor: C.blue,
        animation: 'spin 2s linear infinite',
        boxShadow: `0 0 20px ${C.blue}20`,
      }} />
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 14, color: C.text, fontWeight: 600 }}>
          Waiting for next signal{dots}
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: C.textMuted }}>
          Fire a test signal or wait for TradingView to trigger
        </p>
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}

// ── Live indicator ────────────────────────────────────────────────────────────

function LiveIndicator({ active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: active ? C.green : C.textMuted,
        boxShadow: active ? `0 0 8px ${C.green}` : 'none',
        animation: active ? 'pulse 1.5s ease infinite' : 'none',
        display: 'inline-block',
      }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: active ? C.green : C.textMuted }}>
        {active ? 'LIVE' : 'IDLE'}
      </span>
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function WarRoom() {
  const [events,    setEvents]    = useState([]);
  const [newIds,    setNewIds]    = useState(new Set());
  const [isActive,  setIsActive]  = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    // Load last 50 events on mount
    async function loadRecent() {
      const { data } = await supabase
        .from('deliberation_events')
        .select('*')
        .order('sequence', { ascending: true })
        .limit(50);
      if (data?.length) {
        setEvents(data);
      }
    }
    loadRecent();

    // Subscribe to new events in real time
    const channel = supabase
      .channel('war_room_events')
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'deliberation_events',
      }, (payload) => {
        const newEvent = payload.new;
        setEvents(prev => {
          // Avoid duplicates
          if (prev.find(e => e.id === newEvent.id)) return prev;
          return [...prev, newEvent].sort((a, b) => a.sequence - b.sequence);
        });
        setNewIds(prev => new Set([...prev, newEvent.id]));
        setIsActive(true);

        // Clear "new" highlight after animation
        setTimeout(() => {
          setNewIds(prev => { const s = new Set(prev); s.delete(newEvent.id); return s; });
        }, 2000);

        // Mark idle when deliberation done
        if (newEvent.event_type === 'deliberation_done') {
          setTimeout(() => setIsActive(false), 5000);
        }
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events.length]);

  // Group events by signal for visual separation
  const grouped = [];
  let currentGroup = null;
  for (const event of events) {
    const key = event.signal_id ?? event.deliberation_id ?? 'unknown';
    if (!currentGroup || currentGroup.key !== key) {
      currentGroup = { key, events: [] };
      grouped.push(currentGroup);
    }
    currentGroup.events.push(event);
  }

  return (
    <div style={{
      background: C.bg,
      minHeight: '100%',
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    }}>
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse   { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes glow    { 0%,100% { box-shadow: 0 0 8px ${C.green}40; } 50% { box-shadow: 0 0 20px ${C.green}80; } }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 24px 16px',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, color: C.text, letterSpacing: '-0.02em' }}>
            ⚡ War Room
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: C.textMuted }}>
            Live agent deliberation stream · Updates in real-time as signals are processed
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <LiveIndicator active={isActive} />
          <button
            onClick={() => setEvents([])}
            style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              borderRadius: 6, color: C.textMuted, fontSize: 11,
              padding: '5px 10px', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Event stream */}
      <div style={{ padding: '0 24px', maxWidth: 800 }}>
        {grouped.length === 0 ? (
          <IdleState />
        ) : (
          grouped.map((group, gi) => (
            <div key={group.key} style={{ marginTop: gi > 0 ? 24 : 16 }}>
              {/* Group separator */}
              {gi > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  marginBottom: 16,
                }}>
                  <div style={{ flex: 1, height: 1, background: C.border }} />
                  <span style={{ fontSize: 10, color: C.textFaint, letterSpacing: '0.1em' }}>
                    NEW SIGNAL
                  </span>
                  <div style={{ flex: 1, height: 1, background: C.border }} />
                </div>
              )}
              {group.events.map(event => (
                <EventCard
                  key={event.id}
                  event={event}
                  isNew={newIds.has(event.id)}
                />
              ))}
            </div>
          ))
        )}
        <div ref={bottomRef} style={{ height: 40 }} />
      </div>
    </div>
  );
}
