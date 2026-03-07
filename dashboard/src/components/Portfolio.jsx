import { useState, useEffect, useRef } from 'react';
import { TrendingUp, TrendingDown, X, Activity, Target, Shield, Clock, BarChart2, ChevronRight } from 'lucide-react';
import { useRealtimeTable, supabase } from '../lib/supabase';
import { useTimezone } from '../lib/timezone';

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? 'https://swarmtrade-production.up.railway.app';
const binanceKlines = (symbol, interval, limit) =>
  `${BACKEND}/proxy/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
const binancePrice  = (symbol) =>
  `${BACKEND}/proxy/price?symbol=${symbol}`;

const C = {
  bg:        '#0D1B2A',
  surface:   '#112233',
  surface2:  '#0f1e30',
  border:    '#1e3a52',
  green:     '#4ade80',
  amber:     '#f59e0b',
  red:       '#f87171',
  blue:      '#60a5fa',
  purple:    '#a78bfa',
  text:      '#f8fafc',
  textMuted: '#64748b',
  textDim:   '#334155',
};

// ── Stat tile ─────────────────────────────────────────────────────────────────
function StatTile({ label, value, sub, accent, color }) {
  const c = color ?? (accent ? C.blue : C.text);
  return (
    <div style={{
      background: C.bg, border: `1px solid ${accent ? `${C.blue}40` : C.border}`,
      borderRadius: 10, padding: '16px 18px',
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: accent ? C.blue : C.textMuted, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: c, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Candlestick chart (live Binance data) ──────────────────────────────────────
function CandlestickChart({ asset, entryPrice, stopLoss, takeProfit, timeframe }) {
  const canvasRef = useRef(null);
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [livePrice, setLivePrice] = useState(null);

  const symbol   = asset?.replace('/', '') ?? '';
  const interval = timeframe === '15m' ? '15m'
                 : timeframe === '1h'  ? '1h'
                 : timeframe === '4h'  ? '4h'
                 : timeframe === '1d'  ? '1d' : '1h';

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    fetch(binanceKlines(symbol, interval, 80))
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data)) throw new Error('Bad response');
        setCandles(data.map(k => ({
          t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
        })));
        setLivePrice(+data[data.length - 1][4]);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [symbol, interval]);

  // Live price via backend proxy (Binance WS not available from AU IPs)
  useEffect(() => {
    if (!symbol) return;
    const poll = () => fetch(binancePrice(symbol))
      .then(r => r.json()).then(d => { if (d.price) setLivePrice(+d.price); }).catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [symbol]);

  useEffect(() => {
    if (!candles.length || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const PAD = { top: 20, bottom: 50, left: 12, right: 80 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const prices = candles.flatMap(c => [c.h, c.l]);
    // Include stop/take/entry in price range
    const allLevels = [entryPrice, stopLoss, takeProfit].filter(Boolean);
    const minP = Math.min(...prices, ...allLevels) * 0.998;
    const maxP = Math.max(...prices, ...allLevels) * 1.002;
    const scaleY = p => PAD.top + chartH - ((p - minP) / (maxP - minP)) * chartH;

    const cw = Math.max(2, chartW / candles.length - 1);
    const xOf = i => PAD.left + (i + 0.5) * (chartW / candles.length);

    // Grid lines
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + (i / 4) * chartH;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      const price = maxP - (i / 4) * (maxP - minP);
      ctx.fillStyle = C.textMuted;
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(price.toFixed(price > 1000 ? 0 : price > 1 ? 2 : 4), W - PAD.right + 4, y + 4);
    }

    // Candles
    candles.forEach((c, i) => {
      const x = xOf(i);
      const isGreen = c.c >= c.o;
      const col = isGreen ? C.green : C.red;
      ctx.strokeStyle = col;
      ctx.fillStyle   = col;
      ctx.lineWidth = 1;

      // Wick
      ctx.beginPath();
      ctx.moveTo(x, scaleY(c.h));
      ctx.lineTo(x, scaleY(c.l));
      ctx.stroke();

      // Body
      const bodyTop = scaleY(Math.max(c.o, c.c));
      const bodyBot = scaleY(Math.min(c.o, c.c));
      const bodyH   = Math.max(1, bodyBot - bodyTop);
      ctx.fillRect(x - cw / 2, bodyTop, cw, bodyH);
    });

    // Horizontal levels
    const drawLevel = (price, color, label) => {
      if (!price) return;
      const y = scaleY(price);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${label} ${price.toFixed(price > 1000 ? 0 : price > 1 ? 4 : 6)}`, W - PAD.right + 4, y + 4);
    };

    drawLevel(entryPrice, C.blue,   'ENTRY');
    drawLevel(stopLoss,   C.red,    'STOP ');
    drawLevel(takeProfit, C.green,  'TP   ');

    // Live price line
    if (livePrice) {
      const y = scaleY(livePrice);
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.amber;
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`NOW  ${livePrice.toFixed(livePrice > 1000 ? 0 : livePrice > 1 ? 4 : 6)}`, W - PAD.right + 4, y + 4);
    }

    // Volume bars at bottom
    const maxVol = Math.max(...candles.map(c => c.v));
    candles.forEach((c, i) => {
      const x = xOf(i);
      const vh = (c.v / maxVol) * 30;
      ctx.fillStyle = (c.c >= c.o ? C.green : C.red) + '55';
      ctx.fillRect(x - cw / 2, H - PAD.bottom + 5, cw, vh);
    });

    // X-axis time labels (every ~16 candles)
    ctx.fillStyle = C.textMuted;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    candles.forEach((c, i) => {
      if (i % 16 !== 0) return;
      const d = new Date(c.t);
      const label = `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      ctx.fillText(label, xOf(i), H - PAD.bottom + 38);
    });

  }, [candles, livePrice, entryPrice, stopLoss, takeProfit]);

  if (loading) return (
    <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: C.textMuted, fontSize: 13, background: C.bg, borderRadius: 8 }}>
      Loading chart…
    </div>
  );
  if (error) return (
    <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: C.red, fontSize: 12, background: C.bg, borderRadius: 8 }}>
      Chart error: {error}
    </div>
  );

  return (
    <canvas ref={canvasRef} width={760} height={280}
      style={{ width: '100%', height: 280, borderRadius: 8, display: 'block' }} />
  );
}

// ── RSI mini chart ─────────────────────────────────────────────────────────────
function RSIIndicator({ asset, timeframe }) {
  const [rsiValues, setRsiValues] = useState([]);
  const symbol   = asset?.replace('/', '') ?? '';
  const interval = timeframe ?? '1h';

  useEffect(() => {
    if (!symbol) return;
    fetch(binanceKlines(symbol, interval, 50))
      .then(r => r.json())
      .then(data => {
        const closes = data.map(k => +k[4]);
        const rsis = [];
        const period = 14;
        for (let i = period; i < closes.length; i++) {
          let gains = 0, losses = 0;
          for (let j = i - period + 1; j <= i; j++) {
            const diff = closes[j] - closes[j-1];
            if (diff > 0) gains += diff; else losses -= diff;
          }
          const rs = losses === 0 ? 100 : gains / losses;
          rsis.push(100 - 100 / (1 + rs));
        }
        setRsiValues(rsis.slice(-30));
      }).catch(() => {});
  }, [symbol, interval]);

  if (!rsiValues.length) return null;
  const current = rsiValues[rsiValues.length - 1];
  const rsiColor = current < 30 ? C.green : current > 70 ? C.red : C.blue;

  return (
    <div style={{ background: C.bg, borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em' }}>RSI ({timeframe})</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: rsiColor, fontFamily: 'monospace' }}>
          {current.toFixed(1)} {current < 30 ? '— OVERSOLD' : current > 70 ? '— OVERBOUGHT' : ''}
        </span>
      </div>
      <svg width="100%" height="40" viewBox={`0 0 ${rsiValues.length * 6} 40`} preserveAspectRatio="none">
        {/* zones */}
        <rect x="0" y="0" width="100%" height={40 * (1 - 70/100)} fill={`${C.red}20`} />
        <rect x="0" y={40 * (1 - 30/100)} width="100%" height={40 * 30/100} fill={`${C.green}20`} />
        {/* line */}
        <polyline
          points={rsiValues.map((v, i) => `${i * 6 + 3},${40 - (v / 100) * 40}`).join(' ')}
          fill="none" stroke={rsiColor} strokeWidth="1.5"
        />
        {/* current dot */}
        <circle cx={(rsiValues.length - 1) * 6 + 3} cy={40 - (current / 100) * 40}
          r="3" fill={rsiColor} />
      </svg>
    </div>
  );
}

// ── Trade detail modal ─────────────────────────────────────────────────────────
function TradeDetailPanel({ trade, onClose }) {
  const { formatTs } = useTimezone();
  const [deliberation, setDeliberation] = useState(null);
  const [livePrice, setLivePrice] = useState(null);

  // Fetch deliberation — also used to fill in asset/direction for old trades
  // that were created before migration 016 added those columns to the trades table
  useEffect(() => {
    if (!trade.deliberation_id) return;
    supabase.from('deliberations').select('*').eq('id', trade.deliberation_id).single()
      .then(({ data }) => setDeliberation(data));
  }, [trade.deliberation_id]);

  // Resolve asset: prefer trade.asset, fall back to deliberation.asset once loaded
  const resolvedAsset = trade.asset || deliberation?.asset || null;
  const symbol  = resolvedAsset?.replace('/', '') ?? '';
  const isLong  = (trade.direction || deliberation?.direction) === 'long';

  // Live price
  useEffect(() => {
    if (!symbol) return;
    fetch(binancePrice(symbol)).then(r => r.json()).then(d => { if (d.price) setLivePrice(+d.price); }).catch(() => {});
    const id = setInterval(() =>
      fetch(binancePrice(symbol)).then(r => r.json())
        .then(d => { if (d.price) setLivePrice(+d.price); }).catch(() => {}),
      3000);
    return () => clearInterval(id);
  }, [symbol]);

  const entry = trade.entry_price ?? 0;
  const pnlPct = livePrice && entry
    ? isLong ? ((livePrice - entry) / entry * 100) : ((entry - livePrice) / entry * 100)
    : null;
  const pnlColor = pnlPct == null ? C.textMuted : pnlPct >= 0 ? C.green : C.red;

  const stopDist  = trade.stop_loss   && entry ? Math.abs(((trade.stop_loss   - entry) / entry * 100)).toFixed(2) : null;
  const tpDist    = trade.take_profit && entry ? Math.abs(((trade.take_profit - entry) / entry * 100)).toFixed(2) : null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#00000088', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }} onClick={onClose}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
        width: '100%', maxWidth: 820, maxHeight: '90vh', overflowY: 'auto',
        padding: 24,
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: isLong ? `${C.green}20` : `${C.red}20`,
              border: `1px solid ${isLong ? C.green : C.red}40`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {isLong ? <TrendingUp size={20} color={C.green} /> : <TrendingDown size={20} color={C.red} />}
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 900, color: C.text, letterSpacing: '0.02em' }}>
                {resolvedAsset?.replace('USDT', '/USDT') ?? '—'}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>
                {isLong ? '▲ LONG' : '▼ SHORT'} · {trade.timeframe ?? '—'} · {trade.trading_mode ?? deliberation?.trading_mode ?? 'dayTrade'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Live P&L */}
            {pnlPct != null && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Live P&L</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: pnlColor, fontFamily: 'monospace' }}>
                  {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                </div>
              </div>
            )}
            <button onClick={onClose} style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 8,
              color: C.textMuted, cursor: 'pointer', padding: '6px 8px',
              display: 'flex', alignItems: 'center',
            }}><X size={16} /></button>
          </div>
        </div>

        {/* Chart */}
        <div style={{ marginBottom: 16 }}>
          <CandlestickChart
            asset={resolvedAsset}
            entryPrice={trade.entry_price}
            stopLoss={trade.stop_loss}
            takeProfit={trade.take_profit}
            timeframe={trade.timeframe}
          />
        </div>

        {/* RSI indicator */}
        <div style={{ marginBottom: 16 }}>
          <RSIIndicator asset={resolvedAsset} timeframe={trade.timeframe} />
        </div>

        {/* Trade levels */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16,
        }}>
          {[
            { label: 'Entry Price',  value: entry ? `$${entry.toLocaleString(undefined, {maximumFractionDigits: 6})}` : '—', color: C.blue,  Icon: Activity },
            { label: `Stop Loss${stopDist ? ` (−${stopDist}%)` : ''}`, value: trade.stop_loss ? `$${trade.stop_loss.toLocaleString(undefined, {maximumFractionDigits: 6})}` : '—', color: C.red, Icon: Shield },
            { label: `Take Profit${tpDist ? ` (+${tpDist}%)` : ''}`, value: trade.take_profit ? `$${trade.take_profit.toLocaleString(undefined, {maximumFractionDigits: 6})}` : '—', color: C.green, Icon: Target },
          ].map(({ label, value, color, Icon }) => (
            <div key={label} style={{
              background: C.bg, border: `1px solid ${color}30`, borderRadius: 10,
              padding: '12px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <Icon size={12} color={color} />
                <span style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, color, fontFamily: 'monospace' }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Trade meta */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Position Size',  value: trade.position_size_usd ? `$${trade.position_size_usd}` : '—' },
            { label: 'Live Price',     value: livePrice ? `$${livePrice.toLocaleString(undefined, {maximumFractionDigits: 6})}` : '…' },
            { label: 'Opened',         value: trade.entry_time ? formatTs(trade.entry_time, { dateStyle: 'short', timeStyle: 'short' }) : '—' },
          ].map(({ label, value }) => (
            <div key={label} style={{
              background: C.bg, borderRadius: 10, padding: '10px 14px',
              border: `1px solid ${C.border}`,
            }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em',
                textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: 'monospace' }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Agent scores from deliberation */}
        {deliberation && (
          <div style={{ background: C.bg, borderRadius: 10, padding: '14px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em',
              textTransform: 'uppercase', marginBottom: 10 }}>
              Swarm Conviction — {deliberation.final_decision?.toUpperCase()}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { name: 'Bull',      score: deliberation.bull_score,      color: C.green  },
                { name: 'Bear',      score: deliberation.bear_score,      color: C.red    },
                { name: 'Sentiment', score: deliberation.sentiment_score, color: C.purple },
              ].map(({ name, score }) => {
                if (score == null) return null;
                const barColor = score >= 60 ? C.green : score <= 40 ? C.red : C.amber;
                return (
                  <div key={name} style={{ flex: '1 1 120px', minWidth: 100 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: C.textMuted }}>{name}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: barColor, fontFamily: 'monospace' }}>{score}</span>
                    </div>
                    <div style={{ height: 4, background: C.surface2, borderRadius: 2 }}>
                      <div style={{ height: '100%', width: `${score}%`, background: barColor, borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </div>
            {deliberation.orchestrator_reasoning && (
              <div style={{ marginTop: 12, fontSize: 11, color: C.textMuted, lineHeight: 1.6,
                fontStyle: 'italic', borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                "{deliberation.orchestrator_reasoning.slice(0, 280)}{deliberation.orchestrator_reasoning.length > 280 ? '…' : ''}"
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Position row (clickable) ───────────────────────────────────────────────────
function PositionRow({ trade, onClick }) {
  const [livePrice, setLivePrice] = useState(null);
  const symbol  = trade.asset?.replace('/', '') ?? '';
  const isLong  = trade.direction === 'long';
  const entry   = trade.entry_price ?? 0;

  useEffect(() => {
    if (!symbol) return;
    fetch(binancePrice(symbol)).then(r => r.json()).then(d => { if (d.price) setLivePrice(+d.price); }).catch(() => {});
    const id = setInterval(() =>
      fetch(binancePrice(symbol)).then(r => r.json())
        .then(d => { if (d.price) setLivePrice(+d.price); }).catch(() => {}),
      5000);
    return () => clearInterval(id);
  }, [symbol]);

  const pnlPct = livePrice && entry
    ? isLong ? ((livePrice - entry) / entry * 100) : ((entry - livePrice) / entry * 100)
    : null;
  const pnlColor = pnlPct == null ? C.textMuted : pnlPct >= 0 ? C.green : C.red;

  return (
    <button onClick={onClick} style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto auto',
      gap: '0 16px', padding: '12px 10px', borderBottom: `1px solid ${C.border}`,
      alignItems: 'center', fontSize: 13, color: C.text,
      width: '100%', background: 'none', border: 'none', cursor: 'pointer',
      borderRadius: 8, textAlign: 'left', transition: 'background 0.1s',
    }}
    onMouseEnter={e => e.currentTarget.style.background = `${C.blue}08`}
    onMouseLeave={e => e.currentTarget.style.background = 'none'}
    >
      <div>
        <div style={{ fontWeight: 800, fontSize: 14 }}>
          {trade.asset?.replace('USDT', '/USDT') ?? '—'}
        </div>
        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
          {isLong ? '▲ LONG' : '▼ SHORT'} · {trade.timeframe ?? '—'}
        </div>
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 12, color: C.textMuted }}>
        <div>Entry: <span style={{ color: C.blue }}>${entry ? entry.toLocaleString(undefined, {maximumFractionDigits: 4}) : '—'}</span></div>
        <div>Now: <span style={{ color: C.amber }}>{livePrice ? `$${livePrice.toLocaleString(undefined, {maximumFractionDigits: 4})}` : '…'}</span></div>
      </div>
      <div style={{ textAlign: 'right', fontFamily: 'monospace' }}>
        <div style={{ fontSize: 10, color: C.textMuted }}>Stop</div>
        <div style={{ fontSize: 11, color: C.red }}>{trade.stop_loss ? `$${trade.stop_loss.toLocaleString(undefined, {maximumFractionDigits: 4})}` : '—'}</div>
      </div>
      <div style={{ textAlign: 'right', fontFamily: 'monospace' }}>
        <div style={{ fontSize: 10, color: C.textMuted }}>Target</div>
        <div style={{ fontSize: 11, color: C.green }}>{trade.take_profit ? `$${trade.take_profit.toLocaleString(undefined, {maximumFractionDigits: 4})}` : '—'}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 10, color: C.textMuted }}>Size</div>
        <div style={{ fontSize: 12, color: C.text }}>${trade.position_size_usd ?? '—'}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: C.textMuted }}>P&L</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: pnlColor }}>
            {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '—'}
          </div>
        </div>
        <ChevronRight size={14} color={C.textMuted} />
      </div>
    </button>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────────
export default function Portfolio() {
  const [selectedTrade, setSelectedTrade] = useState(null);
  const { data: trades, loading, error } = useRealtimeTable('trades', {
    orderBy: 'entry_time', ascending: false, limit: 20,
  });

  const openTrades   = trades.filter(t => t.exit_time == null);
  const closedTrades = trades.filter(t => t.exit_time != null);
  const totalPnl     = closedTrades.reduce((sum, t) => sum + (t.pnl_pct ?? 0), 0);

  return (
    <div style={{ padding: 24, fontFamily: "'Inter', system-ui, sans-serif", minHeight: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Portfolio</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
          Paper trading P&L · Real-time via Supabase
        </p>
      </div>

      {error && (
        <div style={{ background: '#450a0a', border: '1px solid #dc2626', borderRadius: 8,
          padding: '12px 16px', color: '#fca5a5', fontSize: 13, marginBottom: 20 }}>
          Failed to load trades: {error.message}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 12, marginBottom: 20 }}>
        <StatTile label="Total Trades"    value={loading ? '—' : trades.length.toString()} accent />
        <StatTile label="Open Positions"  value={loading ? '—' : openTrades.length.toString()} sub="max 3 allowed" />
        <StatTile label="Closed P&L"      value={loading ? '—' : `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`}
          sub="sum of closed trades" color={totalPnl >= 0 ? C.green : C.red} />
        <StatTile label="Mode" value="PAPER" sub="Phase 1 — no real capital" />
      </div>

      {/* Equity curve placeholder */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: 20, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>Equity Curve</h3>
        <div style={{ background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 10,
          height: 180, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 8, color: C.textMuted }}>
          <TrendingUp size={28} color={C.green} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>P&L vs Benchmark Chart</span>
          <span style={{ fontSize: 11 }}>Renders once trades are closed</span>
        </div>
      </div>

      {/* Open positions */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>Open Positions</h3>

        {loading ? (
          <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : openTrades.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: C.textMuted,
            fontSize: 13, fontStyle: 'italic' }}>No open positions</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto auto',
              gap: '0 16px', padding: '0 10px 8px', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textMuted,
              borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
              <span>Asset</span><span>Prices</span><span>Stop</span><span>Target</span><span>Size</span><span>P&L</span>
            </div>
            {openTrades.map(t => (
              <PositionRow key={t.id} trade={t} onClick={() => setSelectedTrade(t)} />
            ))}
            <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, fontStyle: 'italic', paddingLeft: 10 }}>
              Click any row to view chart, levels, and swarm conviction
            </div>
          </>
        )}
      </div>

      {/* Trade detail modal */}
      {selectedTrade && (
        <TradeDetailPanel trade={selectedTrade} onClose={() => setSelectedTrade(null)} />
      )}
    </div>
  );
}
