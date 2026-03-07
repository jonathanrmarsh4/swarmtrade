import { BarChart, Brain, Clock, Database, FlaskConical, Microscope, Radio, Search, TrendingDown, TrendingUp, Zap, Wifi, WifiOff, Activity } from 'lucide-react';
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
      // Next 10-minute boundary (matches SCAN_INTERVAL_MS = 10 * 60 * 1000)
      const now       = Date.now();
      const interval  = 10 * 60 * 1000;
      const nextMs    = Math.ceil(now / interval) * interval;
      return Math.max(0, Math.floor((nextMs - now) / 1000));
    }

    setSeconds(calcNext());
    const timer = setInterval(() => setSeconds(calcNext()), 1000);
    return () => clearInterval(timer);
  }, []);

  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const fmt = `${m}m ${String(s).padStart(2, '0')}s`;

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
            No results yet — first scan runs on startup
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


// ── WebSocket Watchlist Monitor ───────────────────────────────────────────────
// Reads from watchlist_active table (written by scanner every 10 min).
// Subscribes to realtime updates so it reflects live state without refresh.

function RsiBar({ rsi }) {
  const pct      = Math.min(100, Math.max(0, rsi));
  const color    = rsi < 30 ? C.green : rsi > 70 ? C.red : C.blue;
  const label    = rsi < 30 ? 'OVERSOLD' : rsi > 70 ? 'OVERBOUGHT' : 'NEUTRAL';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.06em' }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{rsi}</span>
      </div>
      <div style={{ height: 4, borderRadius: 99, background: C.border, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 9, color: C.textMuted }}>0</span>
        <span style={{ fontSize: 9, color: C.green }}>30</span>
        <span style={{ fontSize: 9, color: C.red }}>70</span>
        <span style={{ fontSize: 9, color: C.textMuted }}>100</span>
      </div>
    </div>
  );
}

function WatchlistCard({ entry, wsConnected }) {
  const isLong   = entry.direction === 'long';
  const dirColor = isLong ? C.green : C.red;
  const reasons  = Array.isArray(entry.reasons) ? entry.reasons : [];

  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${wsConnected ? C.blue + '60' : C.border}`,
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Live pulse indicator */}
      {wsConnected && (
        <div style={{
          position: 'absolute', top: 10, right: 10,
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: C.blue,
            boxShadow: `0 0 6px ${C.blue}`,
            animation: 'pulse-ws 2s ease-in-out infinite',
            display: 'inline-block',
          }} />
          <span style={{ fontSize: 9, color: C.blue, fontWeight: 700, letterSpacing: '0.06em' }}>LIVE</span>
        </div>
      )}

      {/* Symbol + direction */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: C.text, fontFamily: 'monospace' }}>
          {entry.symbol}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: dirColor,
          background: `${dirColor}18`, border: `1px solid ${dirColor}40`,
          borderRadius: 20, padding: '2px 8px',
        }}>
          {isLong ? '▲ LONG' : '▼ SHORT'}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: C.amber,
          background: `${C.amber}18`, border: `1px solid ${C.amber}40`,
          borderRadius: 20, padding: '2px 8px',
        }}>
          SCORE {entry.score}
        </span>
      </div>

      {/* RSI bar */}
      {entry.rsi != null && <RsiBar rsi={entry.rsi} />}

      {/* Signals that triggered watchlist entry */}
      {reasons.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {reasons.map((r, i) => (
            <span key={i} style={{
              fontSize: 10, color: C.textMuted,
              background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '2px 7px',
            }}>{r}</span>
          ))}
        </div>
      )}

      {/* Monitoring conditions legend */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6,
        borderTop: `1px solid ${C.border}`, paddingTop: 10,
      }}>
        {[
          { label: 'RSI Cross', desc: `< ${30} or > ${70}` },
          { label: 'Vol Spike', desc: '> 2× avg' },
          { label: 'Breakout',  desc: 'S/R level' },
        ].map((c, i) => (
          <div key={i} style={{
            background: C.bg, borderRadius: 6, padding: '6px 8px',
            border: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.blue, letterSpacing: '0.06em' }}>{c.label}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{c.desc}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 10, color: C.textMuted }}>
        Price: <span style={{ color: C.text, fontWeight: 600 }}>${Number(entry.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
        <span style={{ marginLeft: 12 }}>
          Watching since: <span style={{ color: C.text }}>{new Date(entry.created_at).toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit' })} AWST</span>
        </span>
      </div>
    </div>
  );
}

function WatchlistMonitor() {
  const [entries,     setEntries]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  async function fetchWatchlist() {
    const { data } = await supabase
      .from('watchlist_active')
      .select('*')
      .order('score', { ascending: false });
    setEntries(data ?? []);
    setLastUpdated(new Date());
    setLoading(false);
  }

  useEffect(() => {
    // Inject pulse-ws keyframe if not already present
    if (!document.getElementById('ws-monitor-styles')) {
      const style = document.createElement('style');
      style.id = 'ws-monitor-styles';
      style.textContent = `
        @keyframes pulse-ws {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.85); }
        }
      `;
      document.head.appendChild(style);
    }
    fetchWatchlist();

    const channel = supabase
      .channel('watchlist_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'watchlist_active' }, () => {
        fetchWatchlist();
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  const hasEntries = entries.length > 0;

  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: '18px 20px',
      marginBottom: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: hasEntries ? `${C.blue}15` : `${C.textMuted}10`,
            border: `1px solid ${hasEntries ? C.blue + '40' : C.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {hasEntries ? <Wifi size={15} color={C.blue} /> : <WifiOff size={15} color={C.textMuted} />}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
              WebSocket Monitor
              {hasEntries && (
                <span style={{
                  marginLeft: 8, fontSize: 10, fontWeight: 700,
                  color: C.blue, background: `${C.blue}18`,
                  border: `1px solid ${C.blue}40`,
                  borderRadius: 20, padding: '2px 8px',
                }}>
                  {entries.length} ACTIVE
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>
              Live 1m kline streams · Escalates to swarm when 2 conditions fire within 5 min
            </div>
          </div>
        </div>
        {lastUpdated && (
          <div style={{ fontSize: 10, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Activity size={11} />
            Updated {lastUpdated.toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 13, padding: '12px 0' }}>Loading watchlist…</div>
      ) : !hasEntries ? (
        <div style={{
          padding: '24px', textAlign: 'center',
          background: C.bg, border: `1px dashed ${C.border}`,
          borderRadius: 8, color: C.textMuted, fontSize: 13,
        }}>
          <WifiOff size={28} color="#334155" style={{ marginBottom: 10 }} />
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No pairs on watchlist yet</div>
          <div style={{ fontSize: 12 }}>Watchlist populates after the first 10-min scan completes</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {entries.map(entry => (
            <WatchlistCard key={entry.symbol} entry={entry} wsConnected={true} />
          ))}
        </div>
      )}

      {/* Escalation rules reminder */}
      {hasEntries && (
        <div style={{
          marginTop: 14, padding: '10px 14px',
          background: C.bg, border: `1px solid ${C.border}`,
          borderRadius: 8, display: 'flex', gap: 20,
        }}>
          {[
            { label: 'Trigger window', value: '5 minutes' },
            { label: 'Conditions needed', value: 'Any 2 of 3' },
            { label: 'Cooldown per pair', value: '30 minutes' },
            { label: 'Max streams', value: '5 concurrent' },
          ].map((s, i) => (
            <div key={i}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{s.label}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginTop: 2 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
            Top 100 Binance pairs by volume · Background scan every 10 min · WebSocket monitors top 5 · Smart escalation to swarm
          </p>
        </div>
        <NextScanCountdown />
      </div>

      {/* How it works */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20,
      }}>
        {[
          { Icon: Radio,        label: 'Stage 1', desc: 'Scan top 100 pairs every 10 min' },
          { Icon: FlaskConical, label: 'Stage 2', desc: 'Build watchlist — top 5 by RSI · MACD · Volume' },
          { Icon: Zap,          label: 'Stage 3', desc: 'WebSocket monitors live — escalates on 2 signals in 5 min' },
          { Icon: Brain,        label: 'Stage 4', desc: 'Swarm deliberates at exact trigger moment' },
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

      {/* WebSocket Watchlist Monitor */}
      <WatchlistMonitor />

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
          No scans yet — first scan runs on startup, then every 10 minutes
        </div>
      )}

      {/* Asset table */}
      <AssetTable results={scanResults} />
    </div>
  );
}
