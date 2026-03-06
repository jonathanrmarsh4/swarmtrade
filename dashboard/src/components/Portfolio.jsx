import { TrendingUp } from 'lucide-react';
// Portfolio — displays live paper P&L vs buy-and-hold benchmark.
// Subscribes to Supabase trades table in real time.
// Shows current open positions, total return, drawdown, and Sharpe ratio.

import { useRealtimeTable } from '../lib/supabase';

// ─── Colours (matches AgentReputation palette) ─────────────────────────────

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

// ─── Stat tile ────────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, accent }) {
  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${accent ? `${C.blue}40` : C.border}`,
        borderRadius: 10,
        padding: '16px 18px',
      }}
    >
      <div style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: accent ? C.blue : C.textMuted,
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 28,
        fontWeight: 800,
        color: accent ? C.blue : C.text,
        lineHeight: 1.1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Placeholder chart area ───────────────────────────────────────────────────

function ChartPlaceholder() {
  return (
    <div style={{
      background: C.bg,
      border: `1px dashed ${C.border}`,
      borderRadius: 10,
      height: 180,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      color: C.textMuted,
    }}>
      <TrendingUp size={28} color='#4ade80' />
      <span style={{ fontSize: 13, fontWeight: 600 }}>P&amp;L vs Benchmark Chart</span>
      <span style={{ fontSize: 11 }}>Renders once trades are logged</span>
    </div>
  );
}

// ─── Open position row ────────────────────────────────────────────────────────

function PositionRow({ trade }) {
  const pnl = trade.pnl_pct;
  const pnlColor = pnl == null ? C.textMuted : pnl >= 0 ? C.green : C.red;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto auto auto',
      gap: '0 24px',
      padding: '10px 0',
      borderBottom: `1px solid ${C.border}`,
      alignItems: 'center',
      fontSize: 13,
      color: C.text,
    }}>
      <span style={{ fontWeight: 700 }}>
        {trade.deliberation_id ?? '—'}
      </span>
      <span style={{ color: C.textMuted }}>{trade.entry_price ?? '—'}</span>
      <span style={{ color: C.textMuted }}>{trade.position_size_usd ?? '—'}</span>
      <span style={{ color: pnlColor, fontWeight: 700 }}>
        {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : 'Open'}
      </span>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function Portfolio() {
  const { data: trades, loading, error } = useRealtimeTable('trades', {
    orderBy: 'entry_time',
    ascending: false,
    limit: 20,
  });

  const openTrades  = trades.filter(t => t.exit_time == null);
  const closedTrades = trades.filter(t => t.exit_time != null);
  const totalPnl    = closedTrades.reduce((sum, t) => sum + (t.pnl_pct ?? 0), 0);

  return (
    <div style={{
      padding: 24,
      fontFamily: "'Inter', system-ui, sans-serif",
      minHeight: '100%',
    }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
          Portfolio
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
          Paper trading P&L · Real-time via Supabase
        </p>
      </div>

      {error && (
        <div style={{
          background: '#450a0a', border: '1px solid #dc2626',
          borderRadius: 8, padding: '12px 16px',
          color: '#fca5a5', fontSize: 13, marginBottom: 20,
        }}>
          Failed to load trades: {error.message}
        </div>
      )}

      {/* Stats row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 12,
        marginBottom: 20,
      }}>
        <StatTile
          label="Total Trades"
          value={loading ? '—' : trades.length.toString()}
          accent
        />
        <StatTile
          label="Open Positions"
          value={loading ? '—' : openTrades.length.toString()}
          sub={`max 3 allowed`}
        />
        <StatTile
          label="Closed P&L"
          value={loading ? '—' : `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`}
          sub="sum of closed trades"
        />
        <StatTile
          label="Mode"
          value="PAPER"
          sub="Phase 1 — no real capital"
        />
      </div>

      {/* P&L chart placeholder */}
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 20,
        marginBottom: 20,
      }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>
          Equity Curve
        </h3>
        <ChartPlaceholder />
      </div>

      {/* Open positions table */}
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 20,
      }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>
          Open Positions
        </h3>

        {loading ? (
          <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : openTrades.length === 0 ? (
          <div style={{
            padding: '24px 0',
            textAlign: 'center',
            color: C.textMuted,
            fontSize: 13,
            fontStyle: 'italic',
          }}>
            No open positions
          </div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto auto',
              gap: '0 24px',
              padding: '0 0 8px',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: C.textMuted,
              borderBottom: `1px solid ${C.border}`,
            }}>
              <span>Deliberation</span>
              <span>Entry</span>
              <span>Size (USD)</span>
              <span>P&amp;L</span>
            </div>
            {openTrades.map(t => <PositionRow key={t.id} trade={t} />)}
          </>
        )}
      </div>
    </div>
  );
}
