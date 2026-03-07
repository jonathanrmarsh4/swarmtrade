import { useState, useEffect } from 'react';
import TestSignal from './TestSignal';
import { Settings as SettingsIcon, FlaskConical, Webhook, Shield, Clock, Globe, Check, Crosshair, Plus, X, RefreshCw, TrendingUp, Target, Activity, ChevronDown, ChevronUp, ScanLine } from 'lucide-react';
import { useTimezone, TIMEZONE_GROUPS, ALL_ZONES } from '../lib/timezone';
import { supabase } from '../lib/supabase';

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? 'https://swarmtrade-production.up.railway.app';

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
  red:       '#f87171',
  purple:    '#a78bfa',
  surface2:  '#0f1e30',
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
  const now = new Date().toISOString();

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px',
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 10,
    }}>
      <Globe size={14} color={C.textMuted} style={{ flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: C.textMuted, whiteSpace: 'nowrap' }}>Timezone</span>
      <select
        value={timezone}
        onChange={e => setTimezone(e.target.value)}
        style={{
          flex: 1, background: C.bg, border: `1px solid ${C.border}`,
          borderRadius: 6, color: C.text, fontSize: 12,
          padding: '5px 8px', cursor: 'pointer', outline: 'none',
        }}
      >
        {TIMEZONE_GROUPS.map(group => (
          <optgroup key={group.label} label={group.label}>
            {group.zones.map(zone => (
              <option key={zone.value} value={zone.value}>{zone.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <span style={{ fontSize: 11, color: C.blue, fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {formatTs(now, { timeStyle: 'short' })} {tzLabel}
      </span>
    </div>
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


// ─────────────────────────────────────────────────────────────────────────────
// SL/TP Configuration Card
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_META = {
  intraday: { label: 'Intraday',   color: '#f59e0b', description: 'Hold hours' },
  dayTrade: { label: 'Day Trade',  color: '#60a5fa', description: 'Hold <24h'  },
  swing:    { label: 'Swing',      color: '#a78bfa', description: 'Hold 2–4 days' },
  position: { label: 'Position',   color: '#4ade80', description: 'Hold up to 7 days' },
};

const DEFAULT_CONFIG = {
  global: {
    strategy: 'atr', stopMult: 1.5, tpMult: 3.0,
    stopPct: 0.025, tpPct: 0.060, srBuffer: 0.005, minRR: 1.5,
  },
  profiles: {
    intraday: { strategy: 'atr', stopMult: 1.2, tpMult: 2.4 },
    dayTrade: { strategy: 'atr', stopMult: 1.5, tpMult: 3.0 },
    swing:    { strategy: 'atr', stopMult: 2.0, tpMult: 5.0 },
    position: { strategy: 'atr', stopMult: 2.5, tpMult: 7.5 },
  },
};

function numInput(val, onChange, min, max, step = 0.1) {
  return (
    <input
      type="number" value={val} min={min} max={max} step={step}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      style={{
        width: 70, background: C.bg, border: `1px solid ${C.border}`,
        borderRadius: 6, padding: '4px 8px', color: C.text,
        fontSize: 12, fontFamily: 'monospace', textAlign: 'right',
      }}
    />
  );
}

function StrategySelect({ value, onChange }) {
  const opts = [
    { value: 'atr',        label: 'ATR-based',   desc: 'Adapts to volatility' },
    { value: 'percentage', label: 'Percentage',  desc: 'Fixed % from entry' },
    { value: 'sr',         label: 'Support/Resistance', desc: 'Uses S/R levels' },
  ];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {opts.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)}
          style={{
            flex: 1, padding: '7px 8px', borderRadius: 7, cursor: 'pointer',
            border: `1px solid ${value === o.value ? C.blue : C.border}`,
            background: value === o.value ? `${C.blue}18` : C.bg,
            color: value === o.value ? C.blue : C.textMuted,
            fontSize: 11, fontWeight: value === o.value ? 700 : 400,
            transition: 'all 0.15s', textAlign: 'center',
          }}>
          <div>{o.label}</div>
          <div style={{ fontSize: 9, marginTop: 2, opacity: 0.7 }}>{o.desc}</div>
        </button>
      ))}
    </div>
  );
}

function RRBadge({ stop, tp, entry = 100 }) {
  if (!stop || !tp) return null;
  const risk   = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? (reward / risk).toFixed(2) : 0;
  const color = rr >= 2 ? C.green : rr >= 1.5 ? C.amber : C.red;
  return (
    <span style={{
      fontSize: 11, fontWeight: 800, color,
      background: `${color}18`, border: `1px solid ${color}40`,
      borderRadius: 4, padding: '2px 6px', fontFamily: 'monospace',
    }}>
      {rr}:1 R:R
    </span>
  );
}

function previewLevels(cfg, profile = 'dayTrade') {
  const g = cfg.global;
  const p = { ...g, ...(cfg.profiles?.[profile] ?? {}) };
  const entry = 100;
  let stop, tp;
  if (p.strategy === 'percentage') {
    stop = entry * (1 - p.stopPct);
    tp   = entry * (1 + p.tpPct);
  } else {
    // ATR preview: assume ATR = 2% of entry
    const atr = entry * 0.02;
    stop = entry - p.stopMult * atr;
    tp   = entry + p.tpMult   * atr;
  }
  return { stop, tp };
}

function ProfileRow({ profileId, profileCfg, globalCfg, onChange }) {
  const meta     = PROFILE_META[profileId];
  const merged   = { ...globalCfg, ...profileCfg };
  const [open, setOpen] = useState(false);
  const { stop, tp } = previewLevels(
    { global: globalCfg, profiles: { [profileId]: profileCfg } }, profileId
  );

  const set = (key, val) => onChange({ ...profileCfg, [key]: val });

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, overflow: 'hidden', marginBottom: 8 }}>
      {/* Header row */}
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', background: C.bg, border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', color: C.text,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
          <div>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{meta.label}</span>
            <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 8 }}>{meta.description}</span>
          </div>
          <span style={{ fontSize: 10, color: C.textMuted, fontFamily: 'monospace', marginLeft: 4 }}>
            {merged.strategy} · stop {merged.strategy === 'percentage'
              ? `${(merged.stopPct*100).toFixed(1)}%`
              : `${merged.stopMult}×ATR`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <RRBadge stop={stop} tp={tp} entry={100} />
          {open ? <ChevronUp size={14} color={C.textMuted} /> : <ChevronDown size={14} color={C.textMuted} />}
        </div>
      </button>

      {/* Expanded controls */}
      {open && (
        <div style={{ padding: '14px 16px', background: C.surface2, borderTop: `1px solid ${C.border}` }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', marginBottom: 6 }}>Strategy</div>
            <StrategySelect value={merged.strategy} onChange={v => set('strategy', v)} />
          </div>

          {merged.strategy === 'atr' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: C.red, fontWeight: 700, marginBottom: 4 }}>
                  Stop Multiplier (× ATR)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {numInput(merged.stopMult, v => set('stopMult', v), 0.5, 5, 0.1)}
                  <span style={{ fontSize: 11, color: C.textMuted }}>×ATR from entry</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.green, fontWeight: 700, marginBottom: 4 }}>
                  TP Multiplier (× ATR)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {numInput(merged.tpMult, v => set('tpMult', v), 1, 20, 0.5)}
                  <span style={{ fontSize: 11, color: C.textMuted }}>×ATR from entry</span>
                </div>
              </div>
            </div>
          )}

          {merged.strategy === 'percentage' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: C.red, fontWeight: 700, marginBottom: 4 }}>Stop Loss %</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {numInput((merged.stopPct*100).toFixed(1), v => set('stopPct', v/100), 0.5, 20, 0.5)}
                  <span style={{ fontSize: 11, color: C.textMuted }}>% from entry</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.green, fontWeight: 700, marginBottom: 4 }}>Take Profit %</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {numInput((merged.tpPct*100).toFixed(1), v => set('tpPct', v/100), 1, 50, 0.5)}
                  <span style={{ fontSize: 11, color: C.textMuted }}>% from entry</span>
                </div>
              </div>
            </div>
          )}

          {merged.strategy === 'sr' && (
            <div>
              <div style={{ fontSize: 10, color: C.amber, fontWeight: 700, marginBottom: 4 }}>S/R Buffer %</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {numInput((merged.srBuffer*100).toFixed(1), v => set('srBuffer', v/100), 0.1, 3, 0.1)}
                <span style={{ fontSize: 11, color: C.textMuted }}>% padding beyond S/R level · Falls back to ATR if S/R unavailable</span>
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: C.textMuted }}>Preview (ATR=2% of entry):</span>
            <RRBadge stop={stop} tp={tp} entry={100} />
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: C.red }}>
              stop −{Math.abs(100-stop).toFixed(2)}%
            </span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: C.green }}>
              tp +{Math.abs(tp-100).toFixed(2)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function SlTpCard() {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('system_config').select('value').eq('key', 'sl_tp_config').single()
      .then(({ data, error }) => {
        if (data?.value) setCfg(data.value);
        else setCfg(DEFAULT_CONFIG);
        setLoading(false);
      })
      .catch(() => { setCfg(DEFAULT_CONFIG); setLoading(false); });
  }, []);

  const setGlobal = (key, val) => setCfg(c => ({ ...c, global: { ...c.global, [key]: val } }));
  const setProfile = (profileId, patch) => setCfg(c => ({
    ...c, profiles: { ...c.profiles, [profileId]: { ...(c.profiles?.[profileId] ?? {}), ...patch } }
  }));

  const save = async () => {
    setStatus({ type: 'saving', msg: 'Saving…' });
    const { error } = await supabase.from('system_config')
      .upsert({ key: 'sl_tp_config', value: cfg, updated_at: new Date().toISOString() });
    if (error) setStatus({ type: 'err', msg: error.message });
    else setStatus({ type: 'ok', msg: 'Saved — applies to all new trades' });
    setTimeout(() => setStatus(null), 3000);
  };

  const reset = () => { setCfg(DEFAULT_CONFIG); setStatus({ type: 'ok', msg: 'Reset to defaults (not saved yet)' }); setTimeout(() => setStatus(null), 2000); };

  if (loading || !cfg) return null;

  return (
    <ConfigCard icon={Shield} title="Stop Loss & Take Profit"
      description="Configure how stop loss and take profit levels are calculated for each trading profile">

      {/* Global defaults */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.08em',
          textTransform: 'uppercase', marginBottom: 10 }}>
          Global Defaults
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 6, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Default Strategy
          </div>
          <StrategySelect value={cfg.global.strategy} onChange={v => setGlobal('strategy', v)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 10 }}>
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Min R:R Ratio</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {numInput(cfg.global.minRR, v => setGlobal('minRR', v), 1, 5, 0.1)}
              <span style={{ fontSize: 10, color: C.textMuted }}>minimum</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Max Portfolio Risk / Trade</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.amber, fontFamily: 'monospace' }}>2%</span>
              <span style={{ fontSize: 10, color: C.textMuted }}>(fixed — edit in risk rules)</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Max Concurrent Positions</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.amber, fontFamily: 'monospace' }}>
              3 <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 400 }}>(fixed)</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: C.border, marginBottom: 14 }} />

      {/* Per-profile overrides */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 10 }}>
        Per-Profile Overrides
        <span style={{ fontSize: 10, fontWeight: 400, color: C.textMuted, marginLeft: 6 }}>
          (click to expand each profile)
        </span>
      </div>

      {Object.keys(PROFILE_META).map(id => (
        <ProfileRow
          key={id}
          profileId={id}
          profileCfg={cfg.profiles?.[id] ?? {}}
          globalCfg={cfg.global}
          onChange={patch => setProfile(id, patch)}
        />
      ))}

      {/* Save bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <div>
          {status && (
            <span style={{ fontSize: 12, color: status.type === 'err' ? C.red : status.type === 'saving' ? C.amber : C.green }}>
              {status.msg}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={reset} style={{
            padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.border}`,
            background: 'none', color: C.textMuted, fontSize: 12, cursor: 'pointer',
          }}>
            Reset defaults
          </button>
          <button onClick={save} style={{
            padding: '7px 16px', borderRadius: 7, border: 'none',
            background: C.blue, color: '#000', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>
            Save
          </button>
        </div>
      </div>
    </ConfigCard>
  );
}


// ─── Shared helpers ───────────────────────────────────────────────────────────

function PctInput({ value, onChange, min = 0, max = 100, step = 0.1, label }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: '0.08em' }}>{label}</span>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number" min={min} max={max} step={step}
          value={(value * 100).toFixed(2)}
          onChange={e => onChange(parseFloat(e.target.value) / 100)}
          style={{
            width: 70, padding: '5px 8px', background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 6, color: C.text, fontSize: 13, fontFamily: 'monospace',
          }}
        />
        <span style={{ fontSize: 12, color: C.textMuted }}>%</span>
      </div>
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 1, label, suffix }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: '0.08em' }}>{label}</span>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number" min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          style={{
            width: 70, padding: '5px 8px', background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 6, color: C.text, fontSize: 13, fontFamily: 'monospace',
          }}
        />
        {suffix && <span style={{ fontSize: 12, color: C.textMuted }}>{suffix}</span>}
      </div>
    </div>
  );
}

const PROFILE_LABELS = { intraday: 'Intraday', dayTrade: 'Day Trade', swing: 'Swing', position: 'Position' };
const PROFILE_COLORS = { intraday: '#f59e0b', dayTrade: '#60a5fa', swing: '#a78bfa', position: '#4ade80' };

// ─── Risk Gate Rules Card ─────────────────────────────────────────────────────

const RISK_DEFAULTS = {
  maxPortfolioRiskPct: 0.02,
  maxConcurrentPositions: 3,
  maxDrawdownPaper: 0.05,
  maxDrawdownLive: 0.03,
  minRiskRewardRatio: 1.5,
  profileOverrides: {
    intraday:  { atrMultiplier: 1.5, maxPositionPct: 0.05 },
    dayTrade:  { atrMultiplier: 2.0, maxPositionPct: 0.07 },
    swing:     { atrMultiplier: 2.5, maxPositionPct: 0.08 },
    position:  { atrMultiplier: 3.0, maxPositionPct: 0.10 },
  },
};

function RiskRulesCard() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/config/risk_rules`)
      .then(r => r.json())
      .then(d => setCfg(d.value ?? RISK_DEFAULTS))
      .catch(() => setCfg(RISK_DEFAULTS));
  }, []);

  function set(path, val) {
    setCfg(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = val;
      return next;
    });
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await fetch(`${BACKEND}/api/config/risk_rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: cfg }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (!cfg) return (
    <ConfigCard icon={Shield} title="Risk Gate Rules" description="Loading…">
      <div style={{ color: C.textMuted, fontSize: 13 }}>Loading configuration…</div>
    </ConfigCard>
  );

  return (
    <ConfigCard icon={Shield} title="Risk Gate Rules"
      description="Deterministic hard limits applied before every trade — no LLM, no hallucination">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Global limits */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em', marginBottom: 12 }}>
            GLOBAL LIMITS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 14 }}>
            <PctInput label="Portfolio Risk / Trade" value={cfg.maxPortfolioRiskPct}
              onChange={v => set('maxPortfolioRiskPct', v)} min={0.1} max={10} step={0.1} />
            <PctInput label="Drawdown Stop (Paper)" value={cfg.maxDrawdownPaper}
              onChange={v => set('maxDrawdownPaper', v)} min={1} max={30} step={0.5} />
            <PctInput label="Drawdown Stop (Live)" value={cfg.maxDrawdownLive}
              onChange={v => set('maxDrawdownLive', v)} min={1} max={20} step={0.5} />
            <NumInput label="Max Concurrent Positions" value={cfg.maxConcurrentPositions}
              onChange={v => set('maxConcurrentPositions', Math.round(v))} min={1} max={10} step={1} />
            <NumInput label="Min Risk:Reward" value={cfg.minRiskRewardRatio}
              onChange={v => set('minRiskRewardRatio', v)} min={0.5} max={5} step={0.1} suffix="×" />
          </div>
        </div>

        {/* Per-profile position sizing */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em', marginBottom: 12 }}>
            POSITION SIZING BY PROFILE
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.keys(PROFILE_LABELS).map(pid => {
              const over = cfg.profileOverrides?.[pid] ?? {};
              return (
                <div key={pid} style={{
                  display: 'grid', gridTemplateColumns: '110px 1fr 1fr',
                  alignItems: 'center', gap: 14,
                  padding: '10px 14px', background: C.bg,
                  borderRadius: 8, border: `1px solid ${C.border}`,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: PROFILE_COLORS[pid] }}>
                    {PROFILE_LABELS[pid]}
                  </span>
                  <NumInput label="ATR Multiplier" value={over.atrMultiplier ?? 2.0}
                    onChange={v => set(`profileOverrides.${pid}.atrMultiplier`, v)}
                    min={0.5} max={8} step={0.1} suffix="×" />
                  <PctInput label="Max Position Size" value={over.maxPositionPct ?? 0.07}
                    onChange={v => set(`profileOverrides.${pid}.maxPositionPct`, v)}
                    min={1} max={50} step={0.5} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Save row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={save} disabled={saving} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', cursor: saving ? 'default' : 'pointer',
            background: saved ? C.green : C.blue, color: '#fff', fontWeight: 700, fontSize: 13,
            opacity: saving ? 0.7 : 1,
          }}>
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Risk Rules'}
          </button>
          {error && <span style={{ fontSize: 12, color: C.red }}>{error}</span>}
          <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 'auto' }}>
            Changes take effect on next deliberation
          </span>
        </div>
      </div>
    </ConfigCard>
  );
}

// ─── Scanner Configuration Card ───────────────────────────────────────────────

const SCANNER_DEFAULTS = {
  scanIntervalMinutes: 10,
  escalationCooldownMinutes: 30,
  topNCandidates: 3,
  minScoreToEscalate: 1,
  profileOverrides: {
    intraday:  { rsiOversold: 35, rsiOverbought: 65, volumeSpikeMult: 1.5 },
    dayTrade:  { rsiOversold: 30, rsiOverbought: 70, volumeSpikeMult: 2.0 },
    swing:     { rsiOversold: 30, rsiOverbought: 70, volumeSpikeMult: 2.0 },
    position:  { rsiOversold: 25, rsiOverbought: 75, volumeSpikeMult: 3.0 },
  },
};

function ScannerConfigCard() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/config/scanner_config`)
      .then(r => r.json())
      .then(d => setCfg(d.value ?? SCANNER_DEFAULTS))
      .catch(() => setCfg(SCANNER_DEFAULTS));
  }, []);

  function set(path, val) {
    setCfg(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = val;
      return next;
    });
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await fetch(`${BACKEND}/api/config/scanner_config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: cfg }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (!cfg) return (
    <ConfigCard icon={ScanLine} title="Scanner Configuration" description="Loading…">
      <div style={{ color: C.textMuted, fontSize: 13 }}>Loading configuration…</div>
    </ConfigCard>
  );

  return (
    <ConfigCard icon={ScanLine} title="Scanner Configuration"
      description="Market scanning behaviour — thresholds, timing, and signal escalation rules">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Global scanner settings */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em', marginBottom: 12 }}>
            GLOBAL SCANNER
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
            <NumInput label="Scan Interval" value={cfg.scanIntervalMinutes}
              onChange={v => set('scanIntervalMinutes', Math.round(v))} min={1} max={60} step={1} suffix="min" />
            <NumInput label="Escalation Cooldown" value={cfg.escalationCooldownMinutes}
              onChange={v => set('escalationCooldownMinutes', Math.round(v))} min={1} max={240} step={5} suffix="min" />
            <NumInput label="Top N Candidates" value={cfg.topNCandidates}
              onChange={v => set('topNCandidates', Math.round(v))} min={1} max={10} step={1} suffix="pairs" />
            <NumInput label="Min Score to Escalate" value={cfg.minScoreToEscalate}
              onChange={v => set('minScoreToEscalate', Math.round(v))} min={1} max={5} step={1} suffix="pts" />
          </div>
        </div>

        {/* Per-profile signal thresholds */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: '0.1em', marginBottom: 12 }}>
            SIGNAL THRESHOLDS BY PROFILE
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.keys(PROFILE_LABELS).map(pid => {
              const over = cfg.profileOverrides?.[pid] ?? {};
              return (
                <div key={pid} style={{
                  display: 'grid', gridTemplateColumns: '110px 1fr 1fr 1fr',
                  alignItems: 'center', gap: 14,
                  padding: '10px 14px', background: C.bg,
                  borderRadius: 8, border: `1px solid ${C.border}`,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: PROFILE_COLORS[pid] }}>
                    {PROFILE_LABELS[pid]}
                  </span>
                  <NumInput label="RSI Oversold" value={over.rsiOversold ?? 30}
                    onChange={v => set(`profileOverrides.${pid}.rsiOversold`, Math.round(v))}
                    min={10} max={45} step={1} />
                  <NumInput label="RSI Overbought" value={over.rsiOverbought ?? 70}
                    onChange={v => set(`profileOverrides.${pid}.rsiOverbought`, Math.round(v))}
                    min={55} max={90} step={1} />
                  <NumInput label="Volume Spike" value={over.volumeSpikeMult ?? 2.0}
                    onChange={v => set(`profileOverrides.${pid}.volumeSpikeMult`, v)}
                    min={1} max={10} step={0.1} suffix="×" />
                </div>
              );
            })}
          </div>
        </div>

        {/* Save row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={save} disabled={saving} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', cursor: saving ? 'default' : 'pointer',
            background: saved ? C.green : C.blue, color: '#fff', fontWeight: 700, fontSize: 13,
            opacity: saving ? 0.7 : 1,
          }}>
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Scanner Config'}
          </button>
          {error && <span style={{ fontSize: 12, color: C.red }}>{error}</span>}
          <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 'auto' }}>
            Scanner picks up changes on next scan cycle
          </span>
        </div>
      </div>
    </ConfigCard>
  );
}

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

      {/* Stop Loss / Take Profit config */}
      <SlTpCard />

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

      <ScannerConfigCard />

      <RiskRulesCard />

    </div>
  );
}
