import { BarChart, Brain, Clock, Database, FlaskConical, Microscope, Radio, Search, TrendingDown, TrendingUp, Zap, Wifi, WifiOff, Activity } from 'lucide-react';
// Scanner — displays market scan results and escalation status.
// Reads from scanner_runs and scanner_results tables in Supabase.
// Updates in real-time as new scans complete.

import { useState, useEffect } from 'react';
import { supabase, useRealtimeTable } from '../lib/supabase';
import { useTimezone } from '../lib/timezone';

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

// ── Tooltip ───────────────────────────────────────────────────────────────────
// Hover tooltip. Wrap any element with <Tooltip text="..."><child/></Tooltip>
function Tooltip({ text, children, width = 220, position = 'top' }) {
  const [visible, setVisible] = useState(false);
  const posStyles = position === 'top'
    ? { bottom: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)' }
    : position === 'right'
    ? { left: 'calc(100% + 8px)', top: '50%', transform: 'translateY(-50%)' }
    : position === 'bottom'
    ? { top: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)' }
    : { right: 'calc(100% + 8px)', top: '50%', transform: 'translateY(-50%)' };

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div style={{
          position: 'absolute',
          ...posStyles,
          width,
          background: '#0a1628',
          border: '1px solid #1e3a52',
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 11,
          color: '#94a3b8',
          lineHeight: 1.55,
          zIndex: 9999,
          pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          whiteSpace: 'normal',
        }}>
          {text}
          {/* Arrow */}
          <div style={{
            position: 'absolute',
            ...(position === 'top' ? { bottom: -5, left: '50%', transform: 'translateX(-50%)' }
               : position === 'right' ? { left: -5, top: '50%', transform: 'translateY(-50%)' }
               : position === 'bottom' ? { top: -5, left: '50%', transform: 'translateX(-50%)' }
               : { right: -5, top: '50%', transform: 'translateY(-50%)' }),
            width: 8, height: 8,
            background: '#0a1628',
            border: '1px solid #1e3a52',
            borderRight: position === 'top' ? '1px solid #1e3a52' : 'none',
            borderBottom: position === 'top' ? '1px solid #1e3a52' : 'none',
            transform: position === 'top' ? 'translateX(-50%) rotate(45deg)' : 'translateY(-50%) rotate(45deg)',
          }} />
        </div>
      )}
    </span>
  );
}

// Helper: small ⓘ icon that shows a tooltip on hover
function InfoTip({ text, width, position }) {
  return (
    <Tooltip text={text} width={width} position={position}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, borderRadius: '50%',
        background: '#1e3a52', border: '1px solid #2a4a64',
        color: '#60a5fa', fontSize: 9, fontWeight: 800,
        cursor: 'help', marginLeft: 5, flexShrink: 0,
        lineHeight: 1,
      }}>i</span>
    </Tooltip>
  );
}



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
    <Tooltip text="This asset was sent to the AI swarm for full deliberation. All 6 agents (Bull, Bear, Macro, Quant, Sentiment, Risk) analysed it and voted on a trade decision." width={260} position="right">
      <span style={{
        fontSize: 10, fontWeight: 700,
        color: C.purple,
        background: `${C.purple}18`,
        border: `1px solid ${C.purple}40`,
        borderRadius: 20,
        padding: '2px 7px',
        cursor: 'help',
      }}>
        SWARM
      </span>
    </Tooltip>
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

  const { formatTs, tzLabel } = useTimezone();
  const scannedAt = formatTs(run.scanned_at);

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
        <span style={{ color: C.text, fontWeight: 600 }}>Last scan: {scannedAt} {tzLabel}</span>
        <InfoTip text="The background scanner runs every 10 minutes, scoring all assets in your trading universe using RSI, MACD, volume, and support/resistance levels." />
      </div>
      <Tooltip text="Total number of trading pairs analysed in this scan cycle across all 4 profiles (Intraday, Day Trade, Swing, Position)." width={200}>
        <span style={{ color: C.textMuted, cursor: 'help', borderBottom: '1px dashed #334155' }}>
          {run.total_assets} assets screened
        </span>
      </Tooltip>
      <Tooltip text="Assets that scored high enough to be sent to the AI swarm for full deliberation. The swarm's 6 agents then debate and vote on whether to open a trade." width={240}>
        <span style={{ color: C.purple, fontWeight: 700, cursor: 'help', borderBottom: `1px dashed ${C.purple}60` }}>
          {run.escalated} escalated to swarm
        </span>
      </Tooltip>
      <Tooltip text="How long the full scan cycle took to complete, including fetching candle data from Binance for all assets across all timeframes." width={200}>
        <span style={{ color: C.textMuted, cursor: 'help' }}>
          {(run.duration_ms / 1000).toFixed(1)}s
        </span>
      </Tooltip>
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
    <Tooltip text="The background scanner runs on a fixed 10-minute cycle aligned to clock boundaries (e.g. :00, :10, :20). This timer shows how long until the next full scan of all assets." width={240} position="bottom">
      <div style={{
        fontSize: 12, color: C.textMuted,
        display: 'flex', alignItems: 'center', gap: 6,
        cursor: 'help',
      }}>
        Next scan in <span style={{ color: C.blue, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt}</span>
      </div>
    </Tooltip>
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
        <Tooltip text="The trading pair. All pairs are quoted in USDT (Tether), the most liquid stablecoin on Binance." width={200} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>Symbol</span></Tooltip>
        <Tooltip text="Conviction score from 0–4. Each point represents one confirmed signal: RSI extreme, volume spike, MACD crossover, or proximity to support/resistance. Higher = stronger setup. Scores ≥1 are escalated to the watchlist." width={240} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>Score</span></Tooltip>
        <Tooltip text="Trade direction suggested by the signals. LONG = buy, expecting price to rise. SHORT = sell, expecting price to fall. Determined by which signals fired (oversold RSI → long, overbought → short)." width={240} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>Direction</span></Tooltip>
        <Tooltip text="Relative Strength Index (14-period). Measures momentum on a 0–100 scale. Below 35 = oversold (potential bounce). Above 65 = overbought (potential reversal). Mid-range = no strong signal." width={260} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>RSI</span></Tooltip>
        <Tooltip text="Volume ratio vs. 20-period average. 1× = normal. 2× = elevated. 3×+ = significant spike suggesting institutional activity or news-driven momentum. Spikes above the profile threshold add +1 to score." width={260} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>Volume</span></Tooltip>
        <Tooltip text="MACD signal line crossover. Bullish = fast line crossed above slow line (momentum turning up). Bearish = fast line crossed below (momentum turning down). Adds +1 to conviction score." width={260} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>MACD</span></Tooltip>
        <Tooltip text="The specific conditions that contributed to this asset's score — e.g. 'Near support', 'RSI oversold', 'MACD crossover'. Each signal is independently detected from candle data." width={260} position="bottom"><span style={{cursor:'help', borderBottom:'1px dashed #334155'}}>Signals</span></Tooltip>
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
        <Tooltip text={rsi < 30 ? "RSI below 30 = oversold. The asset has sold off hard and may be due for a bounce. Contrarian buy signal — often precedes a reversal." : rsi > 70 ? "RSI above 70 = overbought. Strong momentum but stretched — potential reversal or consolidation ahead. Useful for short setups." : "RSI between 30–70 = neutral momentum. No strong directional signal from RSI alone. Other indicators carry more weight in this range."} width={240}>
        <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.06em', cursor: 'help' }}>{label}</span>
      </Tooltip>
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
          { label: 'RSI Cross', desc: `< ${30} or > ${70}`, tip: 'WebSocket fires when RSI on the 1-minute candle crosses below 30 (oversold) or above 70 (overbought). This is a momentum exhaustion signal suggesting a potential reversal.' },
          { label: 'Vol Spike', desc: '> 2× avg', tip: 'WebSocket fires when the current 1-minute candle volume exceeds 2× the 10-period average. Unusual volume often precedes significant price moves and indicates institutional or news-driven activity.' },
          { label: 'Breakout',  desc: 'S/R level', tip: 'WebSocket fires when the price moves 0.5% or more in a single 1-minute candle. This detects breakouts and momentum surges that may not yet show in RSI or volume.' },
        ].map((c, i) => (
          <Tooltip key={i} text={c.tip} width={240} position="top">
          <div style={{
            background: C.bg, borderRadius: 6, padding: '6px 8px',
            border: `1px solid ${C.border}`, cursor: 'help',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.blue, letterSpacing: '0.06em' }}>{c.label}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{c.desc}</div>
          </div>
          </Tooltip>
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
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1, display: 'flex', alignItems: 'center' }}>
              Live 1m kline streams · Escalates to swarm when 2 conditions fire within 5 min
              <InfoTip text="A WebSocket is a persistent real-time connection to Binance's data feed. Unlike the 10-min scanner which polls periodically, the WebSocket receives every 1-minute candle update instantly — allowing the system to react within seconds of a signal firing." width={260} />
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
            { label: 'Trigger window', value: '5 minutes', tip: 'Once the first WebSocket condition fires (e.g. RSI cross), a 5-minute countdown starts. If a second condition fires before the window closes, the asset escalates to the swarm. This prevents false signals from single one-off spikes.' },
            { label: 'Conditions needed', value: 'Any 2 of 3', tip: 'The 3 monitored conditions are: (1) RSI crossing oversold/overbought threshold, (2) volume surge above 2× the 10-period average, (3) significant price move (0.5%+ in a single minute). Any two firing together = escalation.' },
            { label: 'Cooldown per pair', value: '30 minutes', tip: 'After an asset is escalated to the swarm, it cannot be escalated again for 30 minutes. This prevents the system from deliberating the same asset repeatedly on the same setup. The swarm already has it covered.' },
            { label: 'Max streams', value: '5 concurrent', tip: 'Binance limits the number of simultaneous WebSocket streams. The system keeps the top 5 highest-scoring assets from the last scan on live streams. The rest are monitored passively via the 10-min scan cycle.' },
          ].map((s, i) => (
            <Tooltip key={i} text={s.tip} width={260} position="top">
            <div style={{cursor: 'help'}}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{s.label}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginTop: 2 }}>{s.value}</div>
            </div>
            </Tooltip>
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
          { Icon: Radio,        label: 'Stage 1', desc: 'Scan top 100 pairs every 10 min', tip: 'Every 10 minutes, the backend fetches live price + candle data from Binance for all assets in your trading universe. Each asset is scored for RSI extremes, volume spikes, MACD crossovers, and proximity to support/resistance levels.' },
          { Icon: FlaskConical, label: 'Stage 2', desc: 'Build watchlist — top 5 by RSI · MACD · Volume', tip: 'The top 5 highest-scoring assets are added to the WebSocket watchlist. These are the assets most likely to have a tradeable setup developing. The watchlist refreshes every scan cycle.' },
          { Icon: Zap,          label: 'Stage 3', desc: 'WebSocket monitors live — escalates on 2 signals in 5 min', tip: 'A persistent WebSocket connection streams 1-minute candle data for all watchlisted assets. When 2 or more trigger conditions fire within a 5-minute window, the asset is immediately escalated to the swarm — no waiting for the next 10-min scan.' },
          { Icon: Brain,        label: 'Stage 4', desc: 'Swarm deliberates at exact trigger moment', tip: '6 specialised AI agents run in parallel: Bull (upside case), Bear (downside risks), Macro (economic context), Quant (math/sizing), Sentiment (Fear & Greed + news), and Risk (position limits). The Orchestrator weighs all votes and makes the final trade/hold/veto decision.' },
        ].map((s, i) => (
          <Tooltip key={i} text={s.tip} width={260} position="bottom">
            <div style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 8, padding: '12px 14px',
              cursor: 'help', width: '100%',
            }}>
              <div style={{ marginBottom: 4 }}><s.Icon size={16} color='#60a5fa' /></div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.blue, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{s.label}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, lineHeight: 1.5 }}>{s.desc}</div>
            </div>
          </Tooltip>
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
