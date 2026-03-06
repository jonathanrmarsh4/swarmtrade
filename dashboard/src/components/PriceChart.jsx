// PriceChart — mini candlestick chart rendered inside a deliberation card.
// Fetches OHLCV data from Binance public API (no auth required).
// Shows 3 timeframes: 1h (24 candles), 4h (30 candles), 1d (30 candles).
// Panels: candlestick + S/R lines + entry price, volume bars, RSI, MACD.

import { useState, useEffect, useRef, useCallback } from 'react';

const C = {
  bg:        '#0a1628',
  surface:   '#0d1f35',
  border:    '#1e3a52',
  green:     '#26d97f',
  red:       '#f0506e',
  blue:      '#60a5fa',
  amber:     '#f59e0b',
  purple:    '#a78bfa',
  teal:      '#2dd4bf',
  text:      '#f8fafc',
  textMuted: '#4a6580',
  wick:      '#2a4a6a',
  grid:      '#0f2030',
};

// ── Binance helpers ─────────────────────────────────────────────────────────

function toSymbol(asset) {
  // 'BTC/USDT' → 'BTCUSDT', 'BTCUSDT' → 'BTCUSDT'
  return asset?.replace('/', '') ?? 'BTCUSDT';
}

async function fetchCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const raw = await res.json();
  return raw.map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Technical indicators ────────────────────────────────────────────────────

function calcRSI(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function calcMACD(candles) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;

  let ema12 = closes[0], ema26 = closes[0];
  const macdLine   = new Array(n).fill(null);
  const signalLine = new Array(n).fill(null);
  const histogram  = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    if (i >= 25) macdLine[i] = ema12 - ema26;
  }

  let sig = null;
  for (let i = 25; i < n; i++) {
    if (macdLine[i] === null) continue;
    sig = sig === null ? macdLine[i] : macdLine[i] * k9 + sig * (1 - k9);
    signalLine[i] = sig;
    histogram[i]  = macdLine[i] - sig;
  }
  return { macdLine, signalLine, histogram };
}

function calcSupportResistance(candles) {
  // Find pivots: local highs/lows with 3-candle confirmation
  const levels = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isHighPivot = candles[i].high > candles[i-1].high &&
                        candles[i].high > candles[i-2].high &&
                        candles[i].high > candles[i+1].high &&
                        candles[i].high > candles[i+2].high;
    const isLowPivot  = candles[i].low < candles[i-1].low &&
                        candles[i].low < candles[i-2].low &&
                        candles[i].low < candles[i+1].low &&
                        candles[i].low < candles[i+2].low;

    if (isHighPivot) levels.push({ price: candles[i].high, type: 'resistance', idx: i });
    if (isLowPivot)  levels.push({ price: candles[i].low,  type: 'support',    idx: i });
  }

  // Cluster nearby levels (within 0.5%)
  const merged = [];
  for (const lvl of levels) {
    const existing = merged.find(m =>
      Math.abs(m.price - lvl.price) / lvl.price < 0.005 && m.type === lvl.type
    );
    if (existing) {
      existing.price = (existing.price + lvl.price) / 2;
      existing.strength++;
    } else {
      merged.push({ ...lvl, strength: 1 });
    }
  }

  // Return top 3 of each type by strength
  const supports    = merged.filter(l => l.type === 'support').sort((a,b) => b.strength - a.strength).slice(0,3);
  const resistances = merged.filter(l => l.type === 'resistance').sort((a,b) => b.strength - a.strength).slice(0,3);
  return [...supports, ...resistances];
}

function findMACDCrossovers(macdLine, signalLine) {
  const crossovers = [];
  for (let i = 1; i < macdLine.length; i++) {
    if (macdLine[i] === null || signalLine[i] === null) continue;
    if (macdLine[i-1] === null || signalLine[i-1] === null) continue;
    const wasBelowNow = macdLine[i-1] < signalLine[i-1] && macdLine[i] > signalLine[i];
    const wasAboveNow = macdLine[i-1] > signalLine[i-1] && macdLine[i] < signalLine[i];
    if (wasBelowNow) crossovers.push({ idx: i, type: 'bullish' });
    if (wasAboveNow) crossovers.push({ idx: i, type: 'bearish' });
  }
  return crossovers;
}

// ── Canvas chart renderer ───────────────────────────────────────────────────

function useChartData(asset, interval, limit) {
  const [state, setState] = useState({ candles: null, loading: true, error: null });

  useEffect(() => {
    if (!asset) return;
    setState({ candles: null, loading: true, error: null });
    const symbol = toSymbol(asset);
    fetchCandles(symbol, interval, limit)
      .then(candles => setState({ candles, loading: false, error: null }))
      .catch(err   => setState({ candles: null, loading: false, error: err.message }));
  }, [asset, interval, limit]);

  return state;
}

// ── SVG chart (no canvas, works in all envs) ────────────────────────────────

function lerp(v, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function CandlestickPanel({ candles, srLevels, entryPrice, width, height, padX = 8 }) {
  const n     = candles.length;
  const candleW = Math.max(2, Math.floor((width - padX * 2) / n) - 1);
  const step    = (width - padX * 2) / n;

  const allHigh = Math.max(...candles.map(c => c.high));
  const allLow  = Math.min(...candles.map(c => c.low));
  const padY    = (allHigh - allLow) * 0.08;
  const yMax    = allHigh + padY;
  const yMin    = allLow  - padY;

  const yScale = v => lerp(v, yMin, yMax, height - 4, 4);
  const xScale = i => padX + i * step + step / 2;

  // Grid lines
  const gridPrices = [];
  const range = yMax - yMin;
  const step_ = range / 4;
  for (let i = 0; i <= 4; i++) gridPrices.push(yMin + i * step_);

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {/* Grid */}
      {gridPrices.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={width} y1={yScale(p)} y2={yScale(p)}
            stroke={C.grid} strokeWidth={1} />
          <text x={width - 2} y={yScale(p) - 3} textAnchor="end"
            fontSize={8} fill={C.textMuted} fontFamily="monospace">
            {p > 1000 ? p.toLocaleString('en', { maximumFractionDigits: 0 })
                      : p.toFixed(4)}
          </text>
        </g>
      ))}

      {/* S/R lines */}
      {srLevels.map((lvl, i) => {
        const y = yScale(lvl.price);
        if (y < 0 || y > height) return null;
        const color = lvl.type === 'support' ? C.green : C.red;
        return (
          <g key={i}>
            <line x1={0} x2={width} y1={y} y2={y}
              stroke={color} strokeWidth={lvl.strength > 1 ? 1.5 : 1}
              strokeDasharray={lvl.strength > 1 ? '4,3' : '2,4'} opacity={0.5} />
            <text x={4} y={y - 3} fontSize={8} fill={color} opacity={0.8} fontFamily="monospace">
              {lvl.type === 'support' ? 'S' : 'R'}{lvl.strength > 1 ? '★' : ''}
            </text>
          </g>
        );
      })}

      {/* Entry price line */}
      {entryPrice && (() => {
        const y = yScale(entryPrice);
        if (y < 0 || y > height) return null;
        return (
          <g>
            <line x1={0} x2={width} y1={y} y2={y}
              stroke={C.amber} strokeWidth={1.5} strokeDasharray="5,3" opacity={0.9} />
            <rect x={width - 52} y={y - 9} width={50} height={12} rx={3}
              fill={C.amber} opacity={0.9} />
            <text x={width - 27} y={y + 0.5} textAnchor="middle"
              fontSize={8} fill="#000" fontWeight="bold" fontFamily="monospace">
              ENTRY ${entryPrice.toLocaleString('en', { maximumFractionDigits: 0 })}
            </text>
          </g>
        );
      })()}

      {/* Candles */}
      {candles.map((c, i) => {
        const x    = xScale(i);
        const isUp = c.close >= c.open;
        const col  = isUp ? C.green : C.red;
        const bodyTop    = yScale(Math.max(c.open, c.close));
        const bodyBottom = yScale(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBottom - bodyTop);

        return (
          <g key={i}>
            {/* Wick */}
            <line x1={x} x2={x} y1={yScale(c.high)} y2={yScale(c.low)}
              stroke={col} strokeWidth={1} opacity={0.6} />
            {/* Body */}
            <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH}
              fill={isUp ? col : col} opacity={isUp ? 0.85 : 0.75}
              rx={candleW > 4 ? 1 : 0} />
          </g>
        );
      })}
    </svg>
  );
}

function VolumePanel({ candles, width, height, padX = 8 }) {
  const n     = candles.length;
  const step  = (width - padX * 2) / n;
  const candleW = Math.max(2, Math.floor(step) - 1);
  const maxVol = Math.max(...candles.map(c => c.volume));

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <text x={4} y={10} fontSize={8} fill={C.textMuted} fontFamily="monospace">VOL</text>
      {candles.map((c, i) => {
        const x  = padX + i * step + step / 2;
        const h  = lerp(c.volume, 0, maxVol, 0, height - 14);
        const isUp = c.close >= c.open;
        return (
          <rect key={i}
            x={x - candleW / 2} y={height - h}
            width={candleW} height={h}
            fill={isUp ? C.green : C.red} opacity={0.45} />
        );
      })}
    </svg>
  );
}

function RSIPanel({ rsiValues, width, height, padX = 8 }) {
  const valid = rsiValues.filter(v => v !== null);
  if (valid.length < 2) return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <text x={4} y={12} fontSize={8} fill={C.textMuted} fontFamily="monospace">RSI (14)</text>
      <text x={width/2} y={height/2} textAnchor="middle" fontSize={9} fill={C.textMuted}>—</text>
    </svg>
  );

  const n    = rsiValues.length;
  const step = (width - padX * 2) / n;

  // Zone fills
  const yOB = lerp(70, 0, 100, height - 4, 4);
  const yOS = lerp(30, 0, 100, height - 4, 4);
  const y50 = lerp(50, 0, 100, height - 4, 4);

  // Build polyline points
  const points = rsiValues
    .map((v, i) => v !== null ? `${padX + i * step + step/2},${lerp(v, 0, 100, height - 4, 4)}` : null)
    .filter(Boolean)
    .join(' ');

  // Last RSI value
  const lastRSI = valid[valid.length - 1];
  const lastIdx = rsiValues.reduce((acc, v, i) => v !== null ? i : acc, 0);
  const lastX   = padX + lastIdx * step + step / 2;
  const lastY   = lerp(lastRSI, 0, 100, height - 4, 4);
  const rsiColor = lastRSI > 65 ? C.red : lastRSI < 35 ? C.green : C.blue;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* Zones */}
      <rect x={0} y={4} width={width} height={yOB - 4} fill={C.red} opacity={0.04} />
      <rect x={0} y={yOS} width={width} height={height - 4 - yOS} fill={C.green} opacity={0.04} />

      {/* Zone lines */}
      <line x1={0} x2={width} y1={yOB} y2={yOB} stroke={C.red}  strokeWidth={0.5} strokeDasharray="3,3" opacity={0.4} />
      <line x1={0} x2={width} y1={y50} y2={y50} stroke={C.textMuted} strokeWidth={0.5} strokeDasharray="2,4" opacity={0.3} />
      <line x1={0} x2={width} y1={yOS} y2={yOS} stroke={C.green} strokeWidth={0.5} strokeDasharray="3,3" opacity={0.4} />

      {/* Labels */}
      <text x={4} y={10} fontSize={8} fill={C.textMuted} fontFamily="monospace">RSI (14)</text>
      <text x={width - 3} y={yOB - 2} textAnchor="end" fontSize={7} fill={C.red} opacity={0.6} fontFamily="monospace">70</text>
      <text x={width - 3} y={yOS - 2} textAnchor="end" fontSize={7} fill={C.green} opacity={0.6} fontFamily="monospace">30</text>

      {/* Line */}
      <polyline points={points} fill="none" stroke={rsiColor} strokeWidth={1.5} opacity={0.9} />

      {/* Current value dot + label */}
      <circle cx={lastX} cy={lastY} r={3} fill={rsiColor} />
      <rect x={lastX + 5} y={lastY - 9} width={28} height={12} rx={3} fill={rsiColor} opacity={0.85} />
      <text x={lastX + 19} y={lastY + 0.5} textAnchor="middle" fontSize={8} fill="#000" fontWeight="bold" fontFamily="monospace">
        {lastRSI.toFixed(1)}
      </text>
    </svg>
  );
}

function MACDPanel({ macd, crossovers, candles, width, height, padX = 8 }) {
  const { macdLine, signalLine, histogram } = macd;
  const n    = macdLine.length;
  const step = (width - padX * 2) / n;

  const validHist = histogram.filter(v => v !== null);
  if (validHist.length < 2) return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <text x={4} y={12} fontSize={8} fill={C.textMuted} fontFamily="monospace">MACD (12,26,9)</text>
      <text x={width/2} y={height/2} textAnchor="middle" fontSize={9} fill={C.textMuted}>Insufficient data</text>
    </svg>
  );

  const allVals = [...macdLine, ...signalLine].filter(v => v !== null);
  const vMin = Math.min(...allVals);
  const vMax = Math.max(...allVals);
  const yScale = v => lerp(v, vMin, vMax, height - 8, 12);
  const yZero  = yScale(0);

  // MACD line points
  const macdPts = macdLine
    .map((v, i) => v !== null ? `${padX + i * step + step/2},${yScale(v)}` : null)
    .filter(Boolean).join(' ');

  // Signal line points
  const sigPts = signalLine
    .map((v, i) => v !== null ? `${padX + i * step + step/2},${yScale(v)}` : null)
    .filter(Boolean).join(' ');

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <text x={4} y={10} fontSize={8} fill={C.textMuted} fontFamily="monospace">MACD (12,26,9)</text>

      {/* Zero line */}
      <line x1={0} x2={width} y1={yZero} y2={yZero}
        stroke={C.textMuted} strokeWidth={0.5} strokeDasharray="2,4" opacity={0.4} />

      {/* Histogram */}
      {histogram.map((v, i) => {
        if (v === null) return null;
        const x  = padX + i * step + step / 2;
        const bW = Math.max(1, step - 2);
        const y  = v >= 0 ? yScale(v) : yZero;
        const h  = Math.abs(yScale(v) - yZero);
        return (
          <rect key={i} x={x - bW/2} y={y} width={bW} height={Math.max(1, h)}
            fill={v >= 0 ? C.green : C.red} opacity={0.35} />
        );
      })}

      {/* MACD + Signal lines */}
      <polyline points={macdPts}  fill="none" stroke={C.blue}   strokeWidth={1.5} />
      <polyline points={sigPts}   fill="none" stroke={C.amber}  strokeWidth={1}   strokeDasharray="3,2" />

      {/* Crossover markers */}
      {crossovers.map((cx, i) => {
        const x = padX + cx.idx * step + step / 2;
        const y = yScale(macdLine[cx.idx]);
        const col = cx.type === 'bullish' ? C.green : C.red;
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={4} fill={col} opacity={0.9} />
            <text x={x} y={y - 7} textAnchor="middle" fontSize={8} fill={col} fontWeight="bold" fontFamily="monospace">
              {cx.type === 'bullish' ? '▲' : '▼'}
            </text>
          </g>
        );
      })}

      {/* Legend */}
      <circle cx={width - 70} cy={7} r={3} fill={C.blue} />
      <text x={width - 65} y={10} fontSize={7} fill={C.blue} fontFamily="monospace">MACD</text>
      <line x1={width - 42} x2={width - 30} y1={7} y2={7} stroke={C.amber} strokeWidth={1} strokeDasharray="3,2" />
      <text x={width - 27} y={10} fontSize={7} fill={C.amber} fontFamily="monospace">Signal</text>
    </svg>
  );
}

// ── Timeframe tab button ────────────────────────────────────────────────────

function TFButton({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px',
      borderRadius: 6,
      border: `1px solid ${active ? C.blue : C.border}`,
      background: active ? `${C.blue}22` : 'transparent',
      color: active ? C.blue : C.textMuted,
      fontSize: 11, fontWeight: 700, cursor: 'pointer',
      transition: 'all 0.15s ease',
    }}>
      {label}
    </button>
  );
}

// ── Main export ─────────────────────────────────────────────────────────────

const TIMEFRAMES = [
  { label: '1h',  interval: '1h',  limit: 24  },
  { label: '4h',  interval: '4h',  limit: 30  },
  { label: '1D',  interval: '1d',  limit: 30  },
];

export default function PriceChart({ asset, entryPrice, decision }) {
  const [tfIdx, setTfIdx] = useState(0);
  const tf = TIMEFRAMES[tfIdx];
  const { candles, loading, error } = useChartData(asset, tf.interval, tf.limit);
  const containerRef = useRef(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      setWidth(entries[0].contentRect.width);
    });
    obs.observe(containerRef.current);
    setWidth(containerRef.current.getBoundingClientRect().width);
    return () => obs.disconnect();
  }, []);

  const srLevels   = candles ? calcSupportResistance(candles) : [];
  const rsiValues  = candles ? calcRSI(candles) : [];
  const macd       = candles ? calcMACD(candles) : { macdLine: [], signalLine: [], histogram: [] };
  const crossovers = candles ? findMACDCrossovers(macd.macdLine, macd.signalLine) : [];

  // Show entry price only if trade was approved
  const showEntry = decision === 'trade' && entryPrice;

  return (
    <div ref={containerRef} style={{
      marginTop: 16,
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: C.text, fontFamily: 'monospace' }}>
            {asset ?? '—'}
          </span>
          {showEntry && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: C.amber,
              background: `${C.amber}18`, border: `1px solid ${C.amber}40`,
              borderRadius: 20, padding: '1px 7px',
            }}>
              Entry ${entryPrice?.toLocaleString('en', { maximumFractionDigits: 0 })}
            </span>
          )}
          {candles && (
            <span style={{ fontSize: 10, color: C.textMuted }}>
              {candles.length} candles · Last: ${candles[candles.length-1]?.close?.toLocaleString('en', { maximumFractionDigits: 2 }) ?? '—'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {TIMEFRAMES.map((t, i) => (
            <TFButton key={t.label} label={t.label} active={tfIdx === i} onClick={() => setTfIdx(i)} />
          ))}
        </div>
      </div>

      {/* Body */}
      {loading && (
        <div style={{
          height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: C.textMuted, fontSize: 13,
        }}>
          <span style={{ animation: 'pulse 1s infinite' }}>Loading chart…</span>
        </div>
      )}

      {error && (
        <div style={{
          height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: C.red, fontSize: 12,
        }}>
          Chart unavailable: {error}
        </div>
      )}

      {candles && !loading && (
        <div style={{ padding: '8px 0 4px' }}>
          {/* Candlestick */}
          <div style={{ padding: '0 0 0 0', borderBottom: `1px solid ${C.border}` }}>
            <CandlestickPanel
              candles={candles}
              srLevels={srLevels}
              entryPrice={showEntry ? entryPrice : null}
              width={width}
              height={160}
            />
          </div>
          {/* Volume */}
          <div style={{ padding: '2px 0', borderBottom: `1px solid ${C.border}` }}>
            <VolumePanel candles={candles} width={width} height={44} />
          </div>
          {/* RSI */}
          <div style={{ padding: '2px 0', borderBottom: `1px solid ${C.border}` }}>
            <RSIPanel rsiValues={rsiValues} width={width} height={60} />
          </div>
          {/* MACD */}
          <div style={{ padding: '2px 0' }}>
            <MACDPanel macd={macd} crossovers={crossovers} candles={candles} width={width} height={60} />
          </div>

          {/* Legend */}
          <div style={{
            display: 'flex', gap: 14, padding: '8px 12px 6px',
            borderTop: `1px solid ${C.border}`, flexWrap: 'wrap',
          }}>
            {[
              { dot: true,  color: C.green,     label: 'Support'     },
              { dot: true,  color: C.red,        label: 'Resistance'  },
              { dot: false, color: C.amber,      label: '— Entry'     },
              { dot: false, color: C.green,      label: '▲ MACD Bullish cross' },
              { dot: false, color: C.red,        label: '▼ MACD Bearish cross' },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {item.dot
                  ? <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.color }} />
                  : <span style={{ fontSize: 10, color: item.color }}>{item.label.split(' ')[0]}</span>
                }
                <span style={{ fontSize: 9, color: C.textMuted, fontFamily: 'monospace' }}>
                  {item.dot ? item.label : item.label.slice(item.label.indexOf(' ') + 1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
