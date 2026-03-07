// SignalHistory — displays all signals received by the webhook.
// Each row is clickable and navigates to the associated deliberation.
import { useState } from 'react';
import { TrendingUp, TrendingDown, X, Radio, FlaskConical, Webhook,
         Wifi, ScanLine, Tv, ArrowRight, GitBranch } from 'lucide-react';
import { useRealtimeTable, supabase } from '../lib/supabase';
import { useTimezone } from '../lib/timezone';

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

function DirectionBadge({ direction }) {
  const map = {
    long:  { color: C.green, label: '▲ Long'  },
    short: { color: C.red,   label: '▼ Short' },
    close: { color: C.amber, label: 'Close'   },
  };
  const d = map[direction?.toLowerCase()] ?? { color: C.textMuted, label: direction ?? '—' };
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color: d.color,
      background: `${d.color}18`, border: `1px solid ${d.color}50`,
      borderRadius: 20, padding: '2px 9px',
    }}>
      {d.label}
    </span>
  );
}

function OriginBadge({ signalType }) {
  const origins = {
    websocket_trigger: { label: 'WebSocket',   color: '#2dd4bf', Icon: Wifi         },
    scanner:           { label: 'Scanner',     color: '#a78bfa', Icon: ScanLine     },
    manual:            { label: 'Manual',      color: '#f59e0b', Icon: FlaskConical },
    tradingview:       { label: 'TradingView', color: '#60a5fa', Icon: Tv           },
  };
  const tvTypes = new Set(['macd_crossover', 'breakout', 'rsi_oversold', 'rsi_overbought', 'ema_cross', 'ema_crossover']);
  const key = signalType?.toLowerCase() ?? '';
  let origin = origins[key];
  if (!origin && tvTypes.has(key)) origin = origins.tradingview;
  if (!origin) origin = { label: signalType ?? 'Unknown', color: '#64748b', Icon: Radio };
  const { label, color, Icon } = origin;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      color, background: `${color}15`, border: `1px solid ${color}40`,
      borderRadius: 20, padding: '3px 9px', whiteSpace: 'nowrap',
    }}>
      <Icon size={10} />{label}
    </span>
  );
}

function SignalRow({ signal, onNavigate }) {
  const [hovering, setHovering] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const { formatTs } = useTimezone();
  const ts = formatTs(signal.received_at);

  async function handleClick() {
    setLoading(true);
    try {
      // Look up the deliberation linked to this signal
      const { data, error } = await supabase
        .from('deliberations')
        .select('id')
        .eq('signal_id', signal.id)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      if (!error && data) {
        onNavigate(signal.id);
      } else {
        // Signal exists but no deliberation yet (e.g. still processing)
        onNavigate(signal.id);
      }
    } catch {
      onNavigate(signal.id);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      onClick={handleClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr auto auto auto 28px',
        gap: '0 14px',
        padding: '11px 16px',
        borderBottom: `1px solid ${C.border}`,
        alignItems: 'center',
        fontSize: 13,
        color: C.text,
        cursor: 'pointer',
        background: hovering ? '#0f2236' : 'transparent',
        transition: 'background 0.12s ease',
      }}
    >
      <span style={{ fontSize: 11, color: C.textMuted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {ts}
      </span>
      <span style={{ fontWeight: 800, letterSpacing: '0.02em' }}>
        {signal.asset ?? '—'}
      </span>
      <OriginBadge signalType={signal.signal_type} />
      <DirectionBadge direction={signal.direction} />
      <span style={{
        fontSize: 11, color: C.textMuted,
        background: C.bg, border: `1px solid ${C.border}`,
        borderRadius: 6, padding: '1px 7px',
      }}>
        {signal.timeframe ?? '—'}
      </span>
      {/* Navigate arrow */}
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: hovering ? C.blue : C.textMuted,
        transition: 'color 0.12s ease',
        opacity: loading ? 0.4 : 1,
      }}>
        <ArrowRight size={14} />
      </span>
    </div>
  );
}

export default function SignalHistory({ onNavigate }) {
  const { data: signals, loading, error } = useRealtimeTable('signals', {
    orderBy: 'received_at', ascending: false, limit: 50,
  });

  return (
    <div style={{ padding: 24, fontFamily: "'Inter', system-ui, sans-serif", minHeight: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Signal History</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
          All signals · Latest 50 · Real-time · Click any row to view its deliberation
        </p>
      </div>

      {error && (
        <div style={{
          background: '#450a0a', border: '1px solid #dc2626',
          borderRadius: 8, padding: '12px 16px',
          color: '#fca5a5', fontSize: 13, marginBottom: 20,
        }}>
          Failed to load signals: {error.message}
        </div>
      )}

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr auto auto auto 28px',
          gap: '0 14px',
          padding: '10px 16px',
          borderBottom: `1px solid ${C.border}`,
          fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: C.textMuted, background: C.bg,
        }}>
          <span>Time</span>
          <span>Asset</span>
          <span>Origin</span>
          <span>Direction</span>
          <span>TF</span>
          <span style={{ display: 'flex', alignItems: 'center' }}><GitBranch size={10} /></span>
        </div>

        {loading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
            Loading signals…
          </div>
        ) : signals.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: C.textMuted }}>
            <Radio size={32} color={C.textMuted} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>Awaiting first signal</div>
            <div style={{ fontSize: 13 }}>Signals appear here as soon as your TradingView webhook fires.</div>
          </div>
        ) : (
          signals.map(s => <SignalRow key={s.id} signal={s} onNavigate={onNavigate} />)
        )}
      </div>

      {signals.length > 0 && !loading && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.textMuted, textAlign: 'right' }}>
          Showing {signals.length} most recent · Click any row to view deliberation
        </div>
      )}
    </div>
  );
}
