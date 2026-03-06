// DeliberationLog — displays the full committee reasoning for each trade decision.
import { CheckCircle, PauseCircle, Shield, TrendingUp, TrendingDown, MessageSquare, Brain } from 'lucide-react';
// Subscribes to Supabase deliberations table in real time.
// Shows all agent theses, Round 2 rebuttals, Orchestrator synthesis, and Risk Agent decision.

import { useState } from 'react';
import { useRealtimeTable } from '../lib/supabase';

const C = {
  bg:        '#0D1B2A',
  surface:   '#112233',
  border:    '#1e3a52',
  green:     '#4ade80',
  amber:     '#f59e0b',
  red:       '#f87171',
  blue:      '#60a5fa',
  text:      '#f8fafc',
  textMuted: '#64748b',
};

// ─── Decision badge ───────────────────────────────────────────────────────────

function DecisionBadge({ decision }) {
  const styles = {
    trade: { bg: `${C.green}18`, border: `${C.green}60`, color: C.green, label: 'Trade',  Icon: CheckCircle },
    hold:  { bg: `${C.amber}18`, border: `${C.amber}60`, color: C.amber, label: 'Hold',   Icon: PauseCircle  },
    veto:  { bg: `${C.red}18`,   border: `${C.red}60`,   color: C.red,   label: 'Veto',   Icon: Shield       },
  };
  const s = styles[decision] ?? styles.hold;
  return (
    <span style={{
      background: s.bg,
      border: `1px solid ${s.border}`,
      borderRadius: 20,
      padding: '3px 10px',
      fontSize: 11,
      fontWeight: 700,
      color: s.color,
    }}>
      {s.label}
    </span>
  );
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ label, score, color }) {
  const pct = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, fontWeight: 600, color: C.textMuted, marginBottom: 3,
      }}>
        <span>{label}</span>
        <span style={{ color }}>{score ?? '—'}</span>
      </div>
      <div style={{
        height: 5, background: C.bg, borderRadius: 3, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: color, borderRadius: 3,
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Deliberation row (collapsed) ─────────────────────────────────────────────

function DeliberationRow({ row, isExpanded, onToggle }) {
  const ts = row.started_at
    ? new Date(row.started_at).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })
    : '—';

  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      {/* Summary row — always visible */}
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '14px 16px',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto',
          gap: '0 14px',
          alignItems: 'center',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, color: C.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {ts}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          {row.signal_id ? `Signal ${row.signal_id.slice(0, 8)}…` : 'No signal'}
        </span>
        <DecisionBadge decision={row.final_decision} />
        <span style={{
          color: C.textMuted, fontSize: 14,
          transform: isExpanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.2s ease',
        }}>›</span>
      </button>

      {/* Expanded detail panel */}
      {isExpanded && (
        <div style={{
          padding: '0 16px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          borderTop: `1px solid ${C.border}`,
        }}>
          {/* Score bars */}
          <div style={{ paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ScoreBar label="Bull" score={row.bull_score} color={C.green} />
            <ScoreBar label="Bear" score={row.bear_score} color={C.red} />
            <ScoreBar label="Sentiment" score={row.sentiment_score} color={C.blue} />
          </div>

          {/* Theses */}
          {row.bull_thesis && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.green, marginBottom: 4 }}>
                Bull Thesis
              </div>
              <p style={{ margin: 0, fontSize: 12, color: C.text, lineHeight: 1.6 }}>{row.bull_thesis}</p>
            </div>
          )}
          {row.bear_thesis && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.red, marginBottom: 4 }}>
                Bear Thesis
              </div>
              <p style={{ margin: 0, fontSize: 12, color: C.text, lineHeight: 1.6 }}>{row.bear_thesis}</p>
            </div>
          )}

          {/* Orchestrator reasoning */}
          {row.orchestrator_reasoning && (
            <div style={{
              background: C.bg, border: `1px solid ${C.blue}30`,
              borderRadius: 8, padding: '12px 14px',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.blue, marginBottom: 6 }}>
                Orchestrator Synthesis
              </div>
              <p style={{ margin: 0, fontSize: 12, color: C.text, lineHeight: 1.7 }}>
                {row.orchestrator_reasoning}
              </p>
            </div>
          )}

          {/* Risk decision */}
          <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
            <div>
              <span style={{ color: C.textMuted }}>Risk: </span>
              <span style={{ fontWeight: 700, color: row.risk_approved ? C.green : C.red }}>
                {row.risk_approved == null ? '—' : row.risk_approved ? 'Approved' : 'Vetoed'}
              </span>
            </div>
            {row.position_size_pct != null && (
              <div>
                <span style={{ color: C.textMuted }}>Size: </span>
                <span style={{ fontWeight: 700, color: C.text }}>{row.position_size_pct}%</span>
              </div>
            )}
            <div>
              <span style={{ color: C.textMuted }}>Macro: </span>
              <span style={{ fontWeight: 700, color: C.text }}>{row.macro_regime ?? '—'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function DeliberationLog() {
  const [expanded, setExpanded] = useState(null);
  const { data: rows, loading, error } = useRealtimeTable('deliberations', {
    orderBy: 'started_at',
    ascending: false,
    limit: 30,
  });

  function toggle(id) {
    setExpanded(prev => (prev === id ? null : id));
  }

  return (
    <div style={{
      padding: 24,
      fontFamily: "'Inter', system-ui, sans-serif",
      minHeight: '100%',
    }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
          Deliberations
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
          Full committee reasoning · Latest 30 · Real-time
        </p>
      </div>

      {error && (
        <div style={{
          background: '#450a0a', border: '1px solid #dc2626',
          borderRadius: 8, padding: '12px 16px',
          color: '#fca5a5', fontSize: 13, marginBottom: 20,
        }}>
          Failed to load deliberations: {error.message}
        </div>
      )}

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 14, padding: '40px 0', textAlign: 'center' }}>
          Loading deliberations…
        </div>
      ) : rows.length === 0 ? (
        <div style={{
          background: C.surface,
          border: `1px dashed ${C.border}`,
          borderRadius: 12,
          padding: '48px 24px',
          textAlign: 'center',
          color: C.textMuted,
        }}>
          <Brain size={32} color={C.textMuted} style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>
            No deliberations yet
          </div>
          <div style={{ fontSize: 13 }}>
            Deliberations appear here once the first TradingView signal is received.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(row => (
            <DeliberationRow
              key={row.id}
              row={row}
              isExpanded={expanded === row.id}
              onToggle={() => toggle(row.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
