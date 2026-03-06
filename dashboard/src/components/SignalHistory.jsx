// SignalHistory — displays all TradingView signals received by the webhook.
import { TrendingUp, TrendingDown, X, Radio } from 'lucide-react';
// Subscribes to Supabase signals table in real time.
// Shows asset, direction, timeframe, signal type, and whether a trade was triggered.

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

// ─── Direction badge ──────────────────────────────────────────────────────────

function DirectionBadge({ direction }) {
  const map = {
    long:  { color: C.green, label: '▲ Long'  },
    short: { color: C.red,   label: '▼ Short' },
    close: { color: C.amber, label: 'Close', Icon: X },
  };
  const d = map[direction?.toLowerCase()] ?? { color: C.textMuted, label: direction ?? '—' };
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 700,
      color: d.color,
      background: `${d.color}18`,
      border: `1px solid ${d.color}50`,
      borderRadius: 20,
      padding: '2px 9px',
    }}>
      {d.label}
    </span>
  );
}

// ─── Signal row ───────────────────────────────────────────────────────────────

function SignalRow({ signal }) {
  const ts = signal.received_at
    ? new Date(signal.received_at).toLocaleString('en-AU', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '—';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto auto auto',
      gap: '0 16px',
      padding: '12px 16px',
      borderBottom: `1px solid ${C.border}`,
      alignItems: 'center',
      fontSize: 13,
      color: C.text,
    }}>
      <span style={{ fontSize: 11, color: C.textMuted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {ts}
      </span>
      <div>
        <span style={{ fontWeight: 800 }}>{signal.asset ?? '—'}</span>
        {signal.signal_type && (
          <span style={{ color: C.textMuted, marginLeft: 8, fontSize: 11 }}>
            {signal.signal_type}
          </span>
        )}
      </div>
      <DirectionBadge direction={signal.direction} />
      <span style={{
        fontSize: 11,
        color: C.textMuted,
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: '1px 7px',
      }}>
        {signal.timeframe ?? '—'}
      </span>
      <span style={{ fontSize: 10, color: C.textMuted, fontFamily: 'monospace' }}>
        {signal.id?.slice(0, 8)}…
      </span>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function SignalHistory() {
  const { data: signals, loading, error } = useRealtimeTable('signals', {
    orderBy: 'received_at',
    ascending: false,
    limit: 50,
  });

  return (
    <div style={{
      padding: 24,
      fontFamily: "'Inter', system-ui, sans-serif",
      minHeight: '100%',
    }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
          Signal History
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
          All TradingView alerts received · Latest 50 · Real-time
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

      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: 'hidden',
      }}>
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto auto',
          gap: '0 16px',
          padding: '10px 16px',
          borderBottom: `1px solid ${C.border}`,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: C.textMuted,
          background: C.bg,
        }}>
          <span>Time</span>
          <span>Asset · Type</span>
          <span>Direction</span>
          <span>TF</span>
          <span>ID</span>
        </div>

        {loading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
            Loading signals…
          </div>
        ) : signals.length === 0 ? (
          <div style={{
            padding: '48px 24px',
            textAlign: 'center',
            color: C.textMuted,
          }}>
            <Radio size={32} color={C.textMuted} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>
              Awaiting first signal
            </div>
            <div style={{ fontSize: 13 }}>
              Signals appear here as soon as your TradingView webhook fires.
            </div>
          </div>
        ) : (
          signals.map(s => <SignalRow key={s.id} signal={s} />)
        )}
      </div>

      {signals.length > 0 && !loading && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.textMuted, textAlign: 'right' }}>
          Showing {signals.length} most recent signals
        </div>
      )}
    </div>
  );
}
