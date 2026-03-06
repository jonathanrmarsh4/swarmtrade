import { Radio, FlaskConical, Brain, Database, Search, Clock } from 'lucide-react';
import { Radio, Microscope, Brain, BarChart2, TrendingUp, TrendingDown, Search } from 'lucide-react';
// Scanner — displays market scan results and escalation status.
// Reads from scanner_runs and scanner_results tables in Supabase.
// Updates in real-time as new scans complete.

import { useState, useEffect } from 'react';
import { supabase, useRealtimeTable } from '../lib/supabase';

const C = {
  bg:         '#0D1B2A',
  surface:    '#112233',
  surface2:   '#0f2236',
  border:     '#1e3a52',
  green:      '#4ade80',
  red:        '#f87171',
  blue:       '#60a5fa',
  amber:      '#f59e0b',
  purple:     '#a78bfa',
  teal:       '#2dd4bf',
  text:       '#f8fafc',
  textMuted:  '#64748b',
  textFaint:  '#334155',
};

function ScoreBadge({ score }) {
  const color = score >= 3 ? C.green
              : score >= 2 ? C.amber
              : C.textMuted;
  return (
    <span style={{
      fontSize: 11, fontWeight: 800,
      color,
      background: `${color}18`,
      border: `1px solid ${color}40`,
      borderRadius: 20,
      padding: '2px 8px',
      minWidth: 24,
      textAlign: 'center',
      display: 'inline-block',
    }}>
      {score}/4
    </span>
  );
}

function DirectionBadge({ direction }) {
  const isLong = direction === 'long';
  const color  = isLong ? C.green : C.red;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      color,
      background: `${color}18`,
      border: `1px solid ${color}40`,
      borderRadius: 20,
      padding: '2px 7px',
    }}>
      {isLong ? <TrendingUp size={10} style={{marginRight:3}} /> : <TrendingDown size={10} style={{marginRight:3}} />}{isLong ? 'LONG' : 'SHORT'}
    </span>
  );
}

function EscalatedBadge() {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      color: C.purple,
      background: `${C.purple}18`,
      border: `1px solid ${C.purple}40`,
      borderRadius: 20,
      padding: '2px 7px',
    }}>
      SWARM
    </span>
  );
}

function SignalPills({ signals }) {
  if (!signals?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {signals.map((s, i) => (
        <span key={i} style={{
          fontSize: 10, color: C.textMuted,
          background: C.surface2,
          border: `1px solid ${C.border}`,
          borderRadius: 20, padding: '1px 7px',
        }}>
          {s}
        </span>
      ))}
    </div>
  );
}

function ScanMetaBar({ run }) {
  if (!run) return null;

  const scannedAt = new Date(run.scanned_at).toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 20,
      padding: '12px 16px',
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: C.green,
          boxShadow: `0 0 6px ${C.green}`,
          display: 'inline-block',
        }} />
        <span style={{ color: C.text, fontWeight: 600 }}>Last scan: {scannedAt} AWST</span>
      </div>
      <span style={{ color: C.textMuted }}>
        {run.total_assets} assets screened
      </span>
      <span style={{ color: C.purple, fontWeight: 700 }}>
        {run.escalated} escalated to swarm
      </span>
      <span style={{ color: C.textMuted }}>
        {(run.duration_ms / 1000).toFixed(1)}s
      </span>
    </div>
  );
}

function NextScanCountdown() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    function calcNext() {
      const now  = new Date();
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return Math.max(0, Math.floor((next - now) / 1000));
    }

    setSeconds(calcNext());
    const interval = setInterval(() => setSeconds(calcNext()), 1000);
    return () => clearInterval(interval);
  }, []);

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const fmt = h > 0
    ? `${h}h ${m}m`
    : `${m}m ${String(s).padStart(2, '0')}s`;

  return (
    <div style={{
      fontSize: 12, color: C.textMuted,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      Next scan in <span style={{ color: C.blue, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt}</span>
    </div>
  );
}

function AssetTable({ results }) {
  const [filter, setFilter] = useState('all'); // 'all' | 'escalated'
  const [search, setSearch] = useState('');

  const filtered = results.filter(r => {
    if (filter === 'escalated' && !r.escalated) return false;
    if (search && !r.symbol.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      {/* Table header + controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {['all', 'escalated'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '5px 12px',
                borderRadius: 20,
                border: `1px solid ${filter === f ? C.blue : C.border}`,
                background: filter === f ? `${C.blue}18` : 'transparent',
                color: filter === f ? C.blue : C.textMuted,
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}
            >
              {f === 'all' ? `All (${results.length})` : `Swarm (${results.filter(r => r.escalated).length})`}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbol…"
          style={{
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 6, color: C.text, fontSize: 12,
            padding: '6px 10px', outline: 'none', width: 140,
          }}
        />
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '130px 90px 70px 70px 70px 70px 1fr',
        padding: '8px 16px',
        borderBottom: `1px solid ${C.border}`,
        fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: C.textMuted,
      }}>
        <span>Symbol</span>
        <span>Score</span>
        <span>Direction</span>
        <span>RSI</span>
        <span>Volume</span>
        <span>MACD</span>
        <span>Signals</span>
      </div>

      {/* Rows */}
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
            No results yet — scan runs every hour
          </div>
        ) : (
          filtered.map((r, i) => (
            <div
              key={r.id ?? i}
              style={{
                display: 'grid',
                gridTemplateColumns: '130px 90px 70px 70px 70px 70px 1fr',
                padding: '10px 16px',
                borderBottom: i < filtered.length - 1 ? `1px solid ${C.border}` : 'none',
                background: r.escalated ? `${C.purple}08` : 'transparent',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
                  {r.symbol.replace('USDT', '')}
                  <span style={{ color: C.textMuted, fontWeight: 400 }}>/USDT</span>
                </span>
                {r.escalated && <EscalatedBadge />}
              </div>
              <ScoreBadge score={r.score} />
              <DirectionBadge direction={r.direction} />
              <span style={{
                fontSize: 12, fontWeight: 700,
                color: r.rsi < RSI_OVERSOLD_DISPLAY ? C.green
                     : r.rsi > RSI_OVERBOUGHT_DISPLAY ? C.red
                     : C.text,
              }}>
                {r.rsi ?? '—'}
              </span>
              <span style={{
                fontSize: 12, fontWeight: 700,
                color: r.volume_ratio >= 2 ? C.amber : C.text,
              }}>
                {r.volume_ratio ? `${r.volume_ratio}×` : '—'}
              </span>
              <span style={{
                fontSize: 11,
                color: r.macd_cross === 'bullish' ? C.green
                     : r.macd_cross === 'bearish' ? C.red
                     : C.textMuted,
              }}>
                {r.macd_cross ?? '—'}
              </span>
              <SignalPills signals={r.signals} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Display constants (matching scanner thresholds)
const RSI_OVERSOLD_DISPLAY  = 35;
const RSI_OVERBOUGHT_DISPLAY = 65;

// ── Root component ────────────────────────────────────────────────────────────

export default function Scanner() {
  const [latestRun,    setLatestRun]    = useState(null);
  const [scanResults,  setScanResults]  = useState([]);
  const [loadingRun,   setLoadingRun]   = useState(true);

  // Fetch latest scan run
  useEffect(() => {
    async function fetchLatest() {
      const { data } = await supabase
        .from('scanner_runs')
        .select('*')
        .order('scanned_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setLatestRun(data);
      setLoadingRun(false);

      if (data?.id) {
        const { data: results } = await supabase
          .from('scanner_results')
          .select('*')
          .eq('scan_id', data.id)
          .order('score', { ascending: false });
        setScanResults(results ?? []);
      }
    }

    fetchLatest();

    // Subscribe to new scan runs
    const channel = supabase
      .channel('scanner_runs_realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scanner_runs' }, () => {
        fetchLatest();
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  return (
    <div style={{
      padding: '24px',
      background: C.bg,
      minHeight: '100%',
      fontFamily: "'Inter', 'SF Pro Display', system-ui, sans-serif",
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
            Market Scanner
          </h2>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
            Top 100 Binance pairs by volume · Screened every hour · Best candidates escalated to swarm
          </p>
        </div>
        <NextScanCountdown />
      </div>

      {/* How it works */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20,
      }}>
        {[
          { Icon: Radio,        label: 'Stage 1', desc: 'Fetch top 100 pairs by volume' },
          { Icon: FlaskConical, label: 'Stage 2', desc: 'Screen: RSI + Volume + Breakout + MACD' },
          { Icon: Brain,        label: 'Stage 3', desc: 'Top scorers sent to agent swarm' },
          { Icon: Database,     label: 'Stage 4', desc: 'Results saved + dashboard updated' },
        ].map((s, i) => (
          <div key={i} style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: '12px 14px',
          }}>
            <div style={{ marginBottom: 4 }}><s.Icon size={16} color='#60a5fa' /></div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.blue, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{s.label}</div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, lineHeight: 1.5 }}>{s.desc}</div>
          </div>
        ))}
      </div>

      {/* Last scan meta */}
      {loadingRun ? (
        <div style={{ color: C.textMuted, fontSize: 13, padding: '20px 0' }}>Loading scan data…</div>
      ) : latestRun ? (
        <div style={{ marginBottom: 16 }}>
          <ScanMetaBar run={latestRun} />
        </div>
      ) : (
        <div style={{
          padding: '32px', textAlign: 'center',
          background: C.surface, border: `1px dashed ${C.border}`,
          borderRadius: 10, marginBottom: 16,
          color: C.textMuted, fontSize: 13,
        }}>
          <div style={{ marginBottom: 12 }}><Search size={32} color='#4a7090' /></div>
          No scans yet — first scan runs on startup, then every hour at :00
        </div>
      )}

      {/* Asset table */}
      <AssetTable results={scanResults} />
    </div>
  );
}
