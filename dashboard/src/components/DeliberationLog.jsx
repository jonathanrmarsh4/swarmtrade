// DeliberationLog — displays the full committee reasoning for each trade decision.
import { CheckCircle, PauseCircle, Shield, TrendingUp, TrendingDown, MessageSquare, Brain, Wifi, ScanLine, Tv, FlaskConical, Radio } from 'lucide-react';
// Subscribes to Supabase deliberations table in real time.
// Shows all agent theses, Round 2 rebuttals, Orchestrator synthesis, and Risk Agent decision.

import { useState, useEffect, useRef } from 'react';
import { useTimezone } from '../lib/timezone';
import { useRealtimeTable } from '../lib/supabase';
import PriceChart from './PriceChart';

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


// ─── Origin badge ─────────────────────────────────────────────────────────────

function OriginBadge({ signalType }) {
  const origins = {
    websocket_trigger: { label: 'WebSocket',   color: '#2dd4bf', Icon: Wifi         },
    scanner:           { label: 'Scanner',     color: '#a78bfa', Icon: ScanLine     },
    manual:            { label: 'Manual',      color: '#f59e0b', Icon: FlaskConical },
    tradingview:       { label: 'TradingView', color: '#60a5fa', Icon: Tv           },
  };
  const tvTypes = new Set(['macd_crossover','breakout','rsi_oversold','rsi_overbought','ema_cross','ema_crossover']);
  const key = signalType?.toLowerCase() ?? '';
  let origin = origins[key];
  if (!origin && tvTypes.has(key)) origin = origins.tradingview;
  if (!origin) origin = { label: signalType ?? 'Unknown', color: '#64748b', Icon: Radio };
  const { label, color, Icon } = origin;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
      color, background: `${color}15`, border: `1px solid ${color}40`,
      borderRadius: 20, padding: '2px 8px', whiteSpace: 'nowrap',
    }}>
      <Icon size={9} />{label}
    </span>
  );
}

function DirectionPill({ direction }) {
  const map = {
    long:  { color: C.green, label: '▲ Long'  },
    short: { color: C.red,   label: '▼ Short' },
  };
  const d = map[direction?.toLowerCase()] ?? null;
  if (!d) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: d.color,
      background: `${d.color}18`, border: `1px solid ${d.color}40`,
      borderRadius: 20, padding: '2px 8px',
    }}>
      {d.label}
    </span>
  );
}

// ─── Deliberation row (collapsed) ─────────────────────────────────────────────

function DeliberationRow({ row, isExpanded, onToggle, isFocused, rowRef }) {
  const { formatTs } = useTimezone();
  const ts = formatTs(row.started_at);

  return (
    <div
      ref={rowRef}
      style={{
        background: C.surface,
        border: `1px solid ${isFocused ? C.blue : C.border}`,
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: isFocused ? `0 0 0 2px ${C.blue}40` : 'none',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
      }}
    >
      {/* Summary row — always visible */}
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '12px 16px',
          display: 'grid',
          gridTemplateColumns: 'auto auto 1fr auto auto',
          gap: '0 10px',
          alignItems: 'center',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, color: C.textMuted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {ts}
        </span>
        {/* Asset + direction + origin */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {row.asset && (
            <span style={{ fontSize: 13, fontWeight: 800, color: C.text, letterSpacing: '0.02em' }}>
              {row.asset.replace('USDT', '/USDT')}
            </span>
          )}
          {row.direction && <DirectionPill direction={row.direction} />}
          {row.signal_type && <OriginBadge signalType={row.signal_type} />}
        </div>
        {/* spacer */}
        <span />
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

          {/* Price chart — shows market context for the decision */}
          {row.asset && (
            <PriceChart
              asset={row.asset}
              entryPrice={row.entry_price ?? null}
              decision={row.final_decision}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function DeliberationLog({ focusedSignalId, onClearFocus }) {
  const [expanded, setExpanded] = useState(null);
  const focusedRef = useRef(null);
  const { data: rows, loading, error } = useRealtimeTable('deliberations', {
    orderBy: 'started_at',
    ascending: false,
    limit: 30,
  });

  // Auto-expand and scroll to the deliberation that matches the focused signal
  useEffect(() => {
    if (!focusedSignalId || !rows.length) return;
    const match = rows.find(r => r.signal_id === focusedSignalId);
    if (match) {
      setExpanded(match.id);
      // Scroll after a short delay so the DOM has painted
      setTimeout(() => {
        focusedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [focusedSignalId, rows]);

  function toggle(id) {
    if (onClearFocus) onClearFocus(); // clear highlight when user manually toggles
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
              isFocused={focusedSignalId && row.signal_id === focusedSignalId}
              rowRef={focusedSignalId && row.signal_id === focusedSignalId ? focusedRef : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
