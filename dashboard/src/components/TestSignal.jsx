// TestSignal — manual signal firing panel for testing without TradingView.
// Sends the same JSON payload that a real TradingView alert would send.
// Only visible in PAPER mode — cannot be used in live trading.

import { useState } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://swarmtrade-production.up.railway.app';
const WEBHOOK_SECRET = import.meta.env.VITE_WEBHOOK_SECRET || '';

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT'];
const TIMEFRAMES = ['1', '5', '15', '60', '240', 'D'];
const SIGNAL_TYPES = ['macd_crossover', 'breakout', 'rsi_oversold', 'rsi_overbought', 'ema_cross', 'manual'];

const C = {
  bg:        '#0D1B2A',
  surface:   '#112233',
  border:    '#1e3a52',
  green:     '#4ade80',
  red:       '#f87171',
  blue:      '#60a5fa',
  amber:     '#f59e0b',
  text:      '#f8fafc',
  textMuted: '#64748b',
};

function Select({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textMuted }}>
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 7,
          color: C.text,
          fontSize: 13,
          fontWeight: 600,
          padding: '8px 10px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function FireButton({ direction, onClick, loading }) {
  const isLong  = direction === 'long';
  const color   = isLong ? C.green : C.red;
  const label   = isLong ? '🟢 Fire Long' : '🔴 Fire Short';

  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        flex: 1,
        padding: '12px 0',
        background: loading ? C.surface : `${color}18`,
        border: `1px solid ${loading ? C.border : color}`,
        borderRadius: 8,
        color: loading ? C.textMuted : color,
        fontSize: 13,
        fontWeight: 800,
        cursor: loading ? 'not-allowed' : 'pointer',
        letterSpacing: '0.03em',
        transition: 'all 0.15s ease',
      }}
    >
      {loading ? '⏳ Sending…' : label}
    </button>
  );
}

export default function TestSignal() {
  const [asset,      setAsset]      = useState('BTCUSDT');
  const [timeframe,  setTimeframe]  = useState('60');
  const [signalType, setSignalType] = useState('macd_crossover');
  const [loading,    setLoading]    = useState(null); // 'long' | 'short' | null
  const [lastResult, setLastResult] = useState(null); // { ok, message, direction }

  async function fire(direction) {
    setLoading(direction);
    setLastResult(null);

    try {
      const res = await fetch(`${BACKEND_URL}/webhook/tradingview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret:      WEBHOOK_SECRET,
          asset,
          direction,
          timeframe,
          signal_type: signalType,
          // price omitted — backend will fetch live from Binance
        }),
      });

      const data = await res.json();

      if (res.ok && data.received) {
        setLastResult({
          ok:        true,
          direction,
          message:   `Signal accepted — id: ${data.signal_id?.slice(0, 8)}…`,
        });
      } else {
        setLastResult({
          ok:      false,
          direction,
          message: data.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      setLastResult({
        ok:      false,
        direction,
        message: `Network error: ${err.message}`,
      });
    } finally {
      setLoading(null);
    }
  }

  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: C.text }}>
            🧪 Test Signal
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: C.textMuted }}>
            Fire a manual signal to trigger the swarm — no terminal needed
          </p>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700,
          color: C.amber,
          background: `${C.amber}18`,
          border: `1px solid ${C.amber}40`,
          borderRadius: 20,
          padding: '3px 10px',
          letterSpacing: '0.08em',
        }}>
          PAPER ONLY
        </span>
      </div>

      {/* Controls */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Select label="Asset"       value={asset}      onChange={setAsset}      options={ASSETS} />
        <Select label="Timeframe"   value={timeframe}  onChange={setTimeframe}  options={TIMEFRAMES} />
        <Select label="Signal Type" value={signalType} onChange={setSignalType} options={SIGNAL_TYPES} />
      </div>

      {/* Fire buttons */}
      <div style={{ display: 'flex', gap: 10 }}>
        <FireButton direction="long"  onClick={() => fire('long')}  loading={loading === 'long'} />
        <FireButton direction="short" onClick={() => fire('short')} loading={loading === 'short'} />
      </div>

      {/* Result */}
      {lastResult && (
        <div style={{
          padding: '10px 14px',
          background: C.bg,
          border: `1px solid ${lastResult.ok
            ? (lastResult.direction === 'long' ? C.green : C.red)
            : C.red}40`,
          borderRadius: 8,
          fontSize: 12,
          color: lastResult.ok ? C.text : C.red,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span>{lastResult.ok ? '✓' : '✗'}</span>
          <span>{lastResult.message}</span>
          {lastResult.ok && (
            <span style={{ marginLeft: 'auto', color: C.textMuted, fontSize: 11 }}>
              Check Deliberations tab for results
            </span>
          )}
        </div>
      )}
    </div>
  );
}
