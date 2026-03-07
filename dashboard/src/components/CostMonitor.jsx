import { useState, useEffect, useCallback } from 'react';
import { DollarSign, Zap, TrendingUp, AlertTriangle, RefreshCw, Shield, Activity } from 'lucide-react';

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? 'https://swarmtrade-production.up.railway.app';

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
};

const AGENT_COLORS = {
  orchestrator:      C.blue,
  macro:             C.purple,
  bull:              C.green,
  bear:              C.red,
  quant:             C.amber,
  sentiment:         '#38bdf8',
  'crowd-thermometer': '#38bdf8',
  'news-sentinel':   '#0ea5e9',
  reflection:        '#c084fc',
  analyst:           '#fb923c',
};

function fmt$(v)   { return `$${(v ?? 0).toFixed(4)}`; }
function fmtK(v)   { return v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v ?? 0); }

function StatCard({ label, value, sub, color, icon: Icon }) {
  return (
    <div style={{
      background: C.bg, border: `1px solid ${color ? `${color}40` : C.border}`,
      borderRadius: 10, padding: '14px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {Icon && <Icon size={12} color={color ?? C.textMuted} />}
        <span style={{ fontSize: 9, fontWeight: 700, color: color ?? C.textMuted,
          letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 900, color: color ?? C.text, fontFamily: 'monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function BudgetMeter({ spent, cap }) {
  const pct = cap > 0 ? Math.min((spent / cap) * 100, 100) : 0;
  const color = pct >= 90 ? C.red : pct >= 75 ? C.amber : C.green;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C.textMuted }}>Today's spend</span>
        <span style={{ fontSize: 12, fontWeight: 800, color, fontFamily: 'monospace' }}>
          {fmt$(spent)} / {fmt$(cap)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div style={{ height: 8, background: C.surface2, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: `linear-gradient(90deg, ${color}88, ${color})`,
          borderRadius: 4, transition: 'width 0.4s ease',
        }} />
      </div>
      {pct >= 80 && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 11, color: C.amber }}>
          <AlertTriangle size={11} /> Approaching daily cap
        </div>
      )}
    </div>
  );
}

function AgentBreakdown({ byAgent }) {
  if (!byAgent?.length) return null;
  const maxCost = Math.max(...byAgent.map(a => a.costUsd));
  return (
    <div>
      {byAgent.map(a => {
        const color = AGENT_COLORS[a.agent] ?? C.textMuted;
        const barPct = maxCost > 0 ? (a.costUsd / maxCost) * 100 : 0;
        return (
          <div key={a.agent} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{a.agent}</span>
                <span style={{ fontSize: 10, color: C.textMuted }}>{a.calls} calls</span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontFamily: 'monospace', fontSize: 11 }}>
                <span style={{ color: C.textMuted }}>
                  ↑{fmtK(a.inputTokens)} ↓{fmtK(a.outputTokens)}
                </span>
                <span style={{ color, fontWeight: 700 }}>{fmt$(a.costUsd)}</span>
              </div>
            </div>
            <div style={{ height: 3, background: C.surface2, borderRadius: 2 }}>
              <div style={{ height: '100%', width: `${barPct}%`, background: color, borderRadius: 2 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DailyChart({ byDay }) {
  if (!byDay?.length) return null;
  const maxCost = Math.max(...byDay.map(d => d.costUsd), 0.001);
  const days = [...byDay].reverse().slice(-7);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 }}>
      {days.map(d => {
        const h = Math.max(4, (d.costUsd / maxCost) * 70);
        const isToday = d.date === new Date().toISOString().slice(0, 10);
        return (
          <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 3 }}>
            <div style={{ fontSize: 9, color: C.textMuted, fontFamily: 'monospace' }}>
              {fmt$(d.costUsd)}
            </div>
            <div style={{
              width: '100%', height: h,
              background: isToday ? C.blue : `${C.blue}55`,
              borderRadius: '3px 3px 0 0',
              border: isToday ? `1px solid ${C.blue}` : 'none',
            }} />
            <div style={{ fontSize: 9, color: isToday ? C.blue : C.textMuted }}>
              {d.date.slice(5)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function CostMonitor() {
  const [summary, setSummary] = useState(null);
  const [limits, setLimits]   = useState({ dailyCapUsd: 1.00, hardStop: false, warningThresholdPct: 0.8 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [days, setDays]       = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND}/api/costs?days=${days}`);
      const data = await r.json();
      setSummary(data);
    } catch (e) {
      console.error('Failed to load costs:', e);
    }
    setLoading(false);
  }, [days]);

  // Load saved cost limits from system_config on mount
  useEffect(() => {
    fetch(`${BACKEND}/api/config/cost_limits`)
      .then(r => r.json())
      .then(data => {
        if (data?.value) {
          setLimits(l => ({ ...l, ...data.value }));
        }
      })
      .catch(e => console.error('Failed to load cost limits:', e));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const saveLimits = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${BACKEND}/api/config/cost_limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: limits }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSaveMsg({ type: 'ok', msg: 'Saved — applies to next deliberation' });
    } catch (e) {
      setSaveMsg({ type: 'err', msg: e.message });
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const today = summary?.today;
  const capUsd = limits.dailyCapUsd;

  return (
    <div style={{ padding: 24, fontFamily: "'Inter', system-ui, sans-serif", maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text, display: 'flex',
            alignItems: 'center', gap: 8 }}>
            <DollarSign size={20} color={C.green} /> Cost Monitor
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.textMuted }}>
            LLM token usage · API costs · Budget controls
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
              border: `1px solid ${days === d ? C.blue : C.border}`,
              background: days === d ? `${C.blue}20` : 'none',
              color: days === d ? C.blue : C.textMuted,
            }}>{d}d</button>
          ))}
          <button onClick={load} style={{
            padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${C.border}`, background: 'none', color: C.textMuted,
            display: 'flex', alignItems: 'center',
          }}>
            <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      {/* Today summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <StatCard label="Today's Cost"   value={fmt$(today?.costUsd)}     color={C.green}  icon={DollarSign} />
        <StatCard label="Today's Calls"  value={today?.calls ?? 0}         color={C.blue}   icon={Activity}   sub="API calls today" />
        <StatCard label="Input Tokens"   value={fmtK(today?.inputTokens)}  color={C.purple} icon={Zap}        sub="tokens sent" />
        <StatCard label="Output Tokens"  value={fmtK(today?.outputTokens)} color={C.amber}  icon={TrendingUp}  sub="tokens received" />
      </div>

      {/* Budget meter */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>
          Daily Budget
        </h3>
        <BudgetMeter spent={today?.costUsd ?? 0} cap={capUsd} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        {/* Spending chart */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>
            Daily Spend ({days}d)
          </h3>
          {loading ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
          ) : (
            <DailyChart byDay={summary?.byDay} />
          )}
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between',
            fontSize: 11, color: C.textMuted }}>
            <span>{summary?.totals?.calls ?? 0} total calls</span>
            <span style={{ color: C.green, fontWeight: 700 }}>{fmt$(summary?.totals?.costUsd)} total</span>
          </div>
        </div>

        {/* Agent breakdown */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 800, color: C.text }}>
            Cost by Agent
          </h3>
          {loading ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
          ) : (
            <AgentBreakdown byAgent={summary?.byAgent} />
          )}
        </div>
      </div>

      {/* Model breakdown */}
      {summary?.byModel?.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
          padding: 20, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 800, color: C.text }}>Model Usage</h3>
          <div style={{ display: 'flex', gap: 12 }}>
            {summary.byModel.map(m => (
              <div key={m.model} style={{
                flex: 1, background: C.bg, borderRadius: 8, padding: '10px 14px',
                border: `1px solid ${C.border}`,
              }}>
                <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4,
                  fontFamily: 'monospace' }}>{m.model}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{m.calls} calls</div>
                <div style={{ fontSize: 12, color: C.green, fontFamily: 'monospace',
                  marginTop: 2 }}>{fmt$(m.costUsd)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budget controls */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 800, color: C.text,
          display: 'flex', alignItems: 'center', gap: 6 }}>
          <Shield size={14} color={C.amber} /> Budget Controls
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', marginBottom: 6 }}>Daily Cap (USD)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: C.textMuted, fontSize: 14 }}>$</span>
              <input
                type="number" value={limits.dailyCapUsd} min={0.10} max={50} step={0.25}
                onChange={e => setLimits(l => ({ ...l, dailyCapUsd: parseFloat(e.target.value) || 1 }))}
                style={{
                  width: 80, background: C.bg, border: `1px solid ${C.border}`,
                  borderRadius: 6, padding: '6px 10px', color: C.text,
                  fontSize: 14, fontFamily: 'monospace',
                }}
              />
              <span style={{ fontSize: 11, color: C.textMuted }}>per day</span>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: C.textMuted }}>
              At current rate: ~{fmt$(today?.costUsd ?? 0)} today
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', marginBottom: 6 }}>Hard Stop</div>
            <button onClick={() => setLimits(l => ({ ...l, hardStop: !l.hardStop }))}
              style={{
                padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                border: `1px solid ${limits.hardStop ? C.red : C.border}`,
                background: limits.hardStop ? `${C.red}20` : C.bg,
                color: limits.hardStop ? C.red : C.textMuted,
              }}>
              {limits.hardStop ? '🔴 Hard Stop ON — blocks deliberations' : '🟡 Soft Warning only'}
            </button>
            <div style={{ marginTop: 6, fontSize: 11, color: C.textMuted }}>
              {limits.hardStop
                ? 'New deliberations blocked when cap reached'
                : 'Logs warning but allows deliberations past cap'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {saveMsg ? (
            <span style={{ fontSize: 12, color: saveMsg.type === 'ok' ? C.green : C.red }}>
              {saveMsg.msg}
            </span>
          ) : <span />}
          <button onClick={saveLimits} disabled={saving} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none',
            background: C.blue, color: '#000', fontSize: 12, fontWeight: 800,
            cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
          }}>
            {saving ? 'Saving…' : 'Save Limits'}
          </button>
        </div>
      </div>
    </div>
  );
}
