import { useState, useEffect } from 'react';
import TestSignal from './TestSignal';
import { Settings as SettingsIcon, FlaskConical, Webhook, Shield, Clock, Globe, Check, Crosshair, Plus, X, RefreshCw } from 'lucide-react';
import { useTimezone, TIMEZONE_GROUPS, ALL_ZONES } from '../lib/timezone';
import { supabase } from '../lib/supabase';

const C = {
  bg:        '#0D1B2A',
  surface:   '#112233',
  border:    '#1e3a52',
  blue:      '#60a5fa',
  amber:     '#f59e0b',
  green:     '#4ade80',
  text:      '#f8fafc',
  textMuted: '#64748b',
  textDim:   '#334155',
};

function SectionHeader({ icon: Icon, title, description }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
        background: `${C.blue}15`, border: `1px solid ${C.blue}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={16} color={C.blue} />
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{description}</div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: `1px solid ${C.border}`,
    }}>
      <span style={{ fontSize: 12, color: C.textMuted }}>{label}</span>
      <span style={{
        fontSize: 12, fontWeight: 600, color: C.text,
        fontFamily: mono ? 'monospace' : 'inherit',
      }}>{value}</span>
    </div>
  );
}

function ConfigCard({ title, description, icon: Icon, children }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: 20,
    }}>
      <SectionHeader icon={Icon} title={title} description={description} />
      {children}
    </div>
  );
}


// ─── Timezone selector ────────────────────────────────────────────────────────

function TimezoneCard() {
  const { timezone, setTimezone, tzLabel, formatTs } = useTimezone();
  const selected = ALL_ZONES.find(z => z.value === timezone);
  const now = new Date().toISOString();

  return (
    <ConfigCard
      icon={Globe}
      title="Timezone"
      description="All timestamps across the dashboard — signals, deliberations, scanner — will display in this timezone"
    >
      {/* Current selection preview */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderRadius: 8, marginBottom: 14,
        background: `${C.blue}10`, border: `1px solid ${C.blue}30`,
      }}>
        <div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 2 }}>Current timezone</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
            {selected?.label ?? timezone}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>Right now</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, fontVariantNumeric: 'tabular-nums' }}>
            {formatTs(now, { dateStyle: 'medium', timeStyle: 'short' })} {tzLabel}
          </div>
        </div>
      </div>

      {/* Group selector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {TIMEZONE_GROUPS.map(group => (
          <div key={group.label}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: C.textMuted,
              marginBottom: 6, paddingBottom: 4,
              borderBottom: `1px solid ${C.border}`,
            }}>
              {group.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {group.zones.map(zone => {
                const isActive = timezone === zone.value;
                return (
                  <button
                    key={zone.value}
                    onClick={() => setTimezone(zone.value)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
                      background: isActive ? `${C.blue}15` : 'transparent',
                      border: `1px solid ${isActive ? C.blue + '40' : 'transparent'}`,
                      textAlign: 'left', transition: 'all 0.12s ease',
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#ffffff08'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{
                      fontSize: 12, fontWeight: isActive ? 700 : 500,
                      color: isActive ? C.text : C.textMuted,
                      fontFamily: 'monospace',
                    }}>
                      {zone.label}
                    </span>
                    {isActive && <Check size={13} color={C.blue} />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ConfigCard>
  );
}

// ─── Trading Universe editor ──────────────────────────────────────────────────

const UNIVERSE_DEFAULTS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','MATICUSDT',
];

function TradingUniverseCard() {
  const [pairs,    setPairs]    = useState(null);   // null = loading
  const [input,    setInput]    = useState('');
  const [saving,   setSaving]   = useState(false);
  const [status,   setStatus]   = useState(null);   // {type:'ok'|'err', msg}
  const [inputErr, setInputErr] = useState('');

  useEffect(() => {
    supabase
      .from('system_config')
      .select('value')
      .eq('key', 'trading_universe')
      .maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) { setPairs(UNIVERSE_DEFAULTS); return; }
        const v = Array.isArray(data.value) ? data.value : JSON.parse(data.value);
        setPairs(v);
      });
  }, []);

  const validate = (sym) => {
    const s = sym.trim().toUpperCase();
    if (!s) return 'Enter a symbol';
    if (!s.endsWith('USDT')) return 'Must end in USDT (e.g. BTCUSDT)';
    if (s.length < 5) return 'Too short';
    if (pairs?.includes(s)) return `${s} already in list`;
    return '';
  };

  const addPair = () => {
    const sym = input.trim().toUpperCase();
    const err = validate(sym);
    if (err) { setInputErr(err); return; }
    setInputErr('');
    setInput('');
    setPairs(p => [...p, sym]);
    setStatus(null);
  };

  const removePair = (sym) => {
    if (pairs.length <= 1) { setStatus({ type: 'err', msg: 'Must have at least 1 pair' }); return; }
    setPairs(p => p.filter(s => s !== sym));
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    const { error } = await supabase
      .from('system_config')
      .upsert({ key: 'trading_universe', value: pairs, updated_at: new Date().toISOString() },
               { onConflict: 'key' });
    setSaving(false);
    if (error) {
      setStatus({ type: 'err', msg: 'Save failed: ' + error.message });
    } else {
      setStatus({ type: 'ok', msg: `Saved — ${pairs.length} pairs. Takes effect on next scan.` });
    }
  };

  const reset = () => { setPairs(UNIVERSE_DEFAULTS); setStatus(null); };

  return (
    <ConfigCard
      icon={Crosshair}
      title="Trading Universe"
      description="Pairs the scanner monitors every 10 minutes. Changes take effect on the next scan cycle — no redeploy needed."
    >
      {pairs === null ? (
        <div style={{ fontSize: 12, color: C.textMuted, padding: '8px 0' }}>Loading…</div>
      ) : (
        <>
          {/* Pair chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {pairs.map(sym => (
              <div key={sym} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 10px 5px 12px', borderRadius: 20,
                background: `${C.blue}12`, border: `1px solid ${C.blue}35`,
                fontSize: 12, fontWeight: 700, color: C.text,
                fontFamily: 'monospace',
              }}>
                {sym}
                <button
                  onClick={() => removePair(sym)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: 0, display: 'flex', alignItems: 'center',
                    color: C.textMuted, lineHeight: 1,
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                  onMouseLeave={e => e.currentTarget.style.color = C.textMuted}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>

          {/* Add input */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <input
              value={input}
              onChange={e => { setInput(e.target.value.toUpperCase()); setInputErr(''); }}
              onKeyDown={e => e.key === 'Enter' && addPair()}
              placeholder="e.g. SOLUSDT"
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 8,
                background: C.bg, border: `1px solid ${inputErr ? '#ef4444' : C.border}`,
                color: C.text, fontSize: 12, fontFamily: 'monospace',
                outline: 'none',
              }}
            />
            <button onClick={addPair} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
              background: `${C.blue}18`, border: `1px solid ${C.blue}40`,
              color: C.blue, fontSize: 12, fontWeight: 700,
            }}>
              <Plus size={13} /> Add
            </button>
          </div>
          {inputErr && (
            <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 10 }}>{inputErr}</div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <button onClick={save} disabled={saving} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 18px', borderRadius: 8, cursor: saving ? 'default' : 'pointer',
              background: saving ? C.border : C.blue,
              border: 'none', color: '#0D1B2A', fontSize: 12, fontWeight: 800,
              opacity: saving ? 0.6 : 1,
            }}>
              {saving ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={reset} style={{
              padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
              background: 'transparent', border: `1px solid ${C.border}`,
              color: C.textMuted, fontSize: 12,
            }}>
              Reset to defaults
            </button>
            <span style={{ fontSize: 11, color: C.textMuted }}>{pairs.length} pair{pairs.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Status message */}
          {status && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12,
              background: status.type === 'ok' ? `${C.green}15` : '#ef444415',
              border: `1px solid ${status.type === 'ok' ? C.green + '40' : '#ef444440'}`,
              color: status.type === 'ok' ? C.green : '#ef4444',
            }}>
              {status.msg}
            </div>
          )}
        </>
      )}
    </ConfigCard>
  );
}


// ─── Settings page ───────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div style={{ padding: '24px', maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Page title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 4 }}>
        <SettingsIcon size={18} color={C.blue} />
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>Settings & Configuration</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: C.textMuted }}>System config, manual controls, and diagnostics</p>
        </div>
      </div>

      {/* Timezone selector — first card */}
      <TimezoneCard />

      {/* Trading Universe editor */}
      <TradingUniverseCard />

      {/* Test Signal — moved here from Portfolio */}
      <ConfigCard
        icon={FlaskConical}
        title="Manual Signal Testing"
        description="Fire a test signal directly into the swarm — bypasses TradingView, same deliberation pipeline"
      >
        <TestSignal embedded />
      </ConfigCard>

      {/* Webhook info */}
      <ConfigCard
        icon={Webhook}
        title="TradingView Webhook"
        description="Configure your Pine Script alerts to send signals to this endpoint"
      >
        <InfoRow label="Endpoint"  value="POST /webhook/tradingview" mono />
        <InfoRow label="Backend"   value="swarmtrade-production.up.railway.app" mono />
        <InfoRow label="Secret"    value="TRADINGVIEW_WEBHOOK_SECRET (Railway env var)" mono />
        <InfoRow label="Timeframe" value="Sent as query param or in JSON body" />
        <div style={{
          marginTop: 14, padding: '12px 14px',
          background: C.bg, borderRadius: 8, border: `1px solid ${C.border}`,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em', marginBottom: 8 }}>
            PINE SCRIPT ALERT MESSAGE TEMPLATE
          </div>
          <pre style={{ margin: 0, fontSize: 11, color: C.blue, fontFamily: 'monospace', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{`{
  "secret": "YOUR_SECRET_HERE",
  "asset": "{{ticker}}",
  "direction": "long",
  "timeframe": "{{interval}}",
  "signal_type": "macd_crossover",
  "rsi": {{plot_0}},
  "volume_ratio": {{plot_1}}
}`}</pre>
        </div>
      </ConfigCard>

      {/* Scanner config */}
      <ConfigCard
        icon={Clock}
        title="Scanner Configuration"
        description="Live WebSocket monitor settings — read-only, edit in market-scanner.js"
      >
        <InfoRow label="Scan interval"       value="Every 10 minutes" />
        <InfoRow label="Watchlist size"       value="Top 5 pairs" />
        <InfoRow label="WebSocket streams"    value="Max 5 concurrent (Binance 1m klines)" />
        <InfoRow label="Escalation trigger"   value="2 distinct conditions within 5-min window" />
        <InfoRow label="Conditions monitored" value="RSI threshold · Volume spike · Price breakout" />
        <InfoRow label="Escalation cooldown"  value="30 minutes per pair" />
        <InfoRow label="Min score to watch"   value="Score ≥ 1 on 1h candle screen" />
      </ConfigCard>

      {/* Risk rules */}
      <ConfigCard
        icon={Shield}
        title="Risk Gate Rules"
        description="Deterministic hard limits — no LLM involved, edit in agents/risk/rules.js"
      >
        <InfoRow label="Max portfolio risk per trade" value="2%" />
        <InfoRow label="Max concurrent positions"     value="3" />
        <InfoRow label="Drawdown stop (paper)"        value="5%" />
        <InfoRow label="Min risk:reward ratio"        value="1.5×" />
        <InfoRow label="Max position size"            value="10% of portfolio" />
        <InfoRow label="Mode"                         value="PAPER TRADING" />
      </ConfigCard>

    </div>
  );
}
