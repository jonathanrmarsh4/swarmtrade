import { TrendingUp, TrendingDown, BarChart2, Globe, Activity, Shield } from 'lucide-react';
// AgentReputation — displays weekly accuracy scores per agent.
// Reads from Supabase agent_reputation table via useRealtimeTable.
// Updated nightly by the Reflection Agent in /scripts/reflection-agent.js.

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import { useRealtimeTable } from '../lib/supabase';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_TRADES = 10;

const AGENTS = [
  { key: 'bull',      label: 'Bull',      Icon: TrendingUp   },
  { key: 'bear',      label: 'Bear',      Icon: TrendingDown },
  { key: 'quant',     label: 'Quant',     Icon: BarChart2    },
  { key: 'macro',     label: 'Macro',     Icon: Globe        },
  { key: 'sentiment', label: 'Sentiment', Icon: Activity     },
  { key: 'risk',      label: 'Risk Gate', Icon: Shield       },
];

// Dark trading dashboard palette
const C = {
  bg:         '#0f172a',
  surface:    '#1e293b',
  border:     '#334155',
  borderFaint:'#1e293b',
  green:      '#4ade80',
  greenDim:   '#166534',
  amber:      '#f59e0b',
  amberDim:   '#78350f',
  red:        '#f87171',
  blue:       '#60a5fa',
  blueDim:    '#1e3a5f',
  text:       '#f8fafc',
  textMuted:  '#94a3b8',
  textFaint:  '#475569',
};

// ─── Data helpers ─────────────────────────────────────────────────────────────

/** Group all agent_reputation rows by agent key, sorted oldest→newest. */
function groupByAgent(rows) {
  const grouped = {};
  for (const agent of AGENTS) {
    grouped[agent.key] = rows
      .filter(r => r.agent_name === agent.key)
      .sort((a, b) => new Date(a.week_ending) - new Date(b.week_ending));
  }
  return grouped;
}

/** Format a 0–1 fraction as a percentage string with one decimal place. */
function pct(value) {
  if (value == null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function TrendBadge({ data }) {
  if (data.length < 2) return null;
  const last = data[data.length - 1].overall_accuracy;
  const prev = data[data.length - 2].overall_accuracy;
  const delta = ((last - prev) * 100);

  if (Math.abs(delta) < 0.5) {
    return (
      <span style={{ color: C.textMuted, fontSize: 11, fontWeight: 600 }}>
        → Stable
      </span>
    );
  }
  if (delta > 0) {
    return (
      <span style={{ color: C.green, fontSize: 11, fontWeight: 600 }}>
        ↑ +{delta.toFixed(1)}pp
      </span>
    );
  }
  return (
    <span style={{ color: C.red, fontSize: 11, fontWeight: 600 }}>
      ↓ {delta.toFixed(1)}pp
    </span>
  );
}

function WeeklySparkline({ data }) {
  if (data.length < 2) {
    return (
      <div style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: C.textFaint,
        fontSize: 11,
        fontStyle: 'italic',
      }}>
        not enough history
      </div>
    );
  }

  const chartData = data.map(row => ({
    week: row.week_ending,
    acc:  Number((row.overall_accuracy * 100).toFixed(1)),
  }));

  return (
    <ResponsiveContainer width="100%" height={44}>
      <LineChart data={chartData} margin={{ top: 6, right: 4, bottom: 2, left: 4 }}>
        <Line
          type="monotone"
          dataKey="acc"
          stroke={C.blue}
          strokeWidth={2}
          dot={{ r: 2, fill: C.blue, strokeWidth: 0 }}
          activeDot={{ r: 3, fill: C.blue }}
          isAnimationActive={false}
        />
        <Tooltip
          cursor={false}
          contentStyle={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            fontSize: 11,
            color: C.text,
            padding: '4px 8px',
          }}
          formatter={(v) => [`${v}%`, 'Accuracy']}
          labelFormatter={(label) => `w/e ${label}`}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MetricTile({ label, value, size = 'md', accent = false }) {
  const valueSize = size === 'lg' ? 30 : 19;
  return (
    <div style={{
      background: C.bg,
      borderRadius: 8,
      padding: size === 'lg' ? '14px 16px' : '10px 12px',
      border: accent ? `1px solid ${C.blue}30` : `1px solid ${C.borderFaint}`,
    }}>
      <div style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: accent ? C.blue : C.textMuted,
        marginBottom: size === 'lg' ? 6 : 4,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: valueSize,
        fontWeight: 800,
        color: accent ? C.blue : C.text,
        lineHeight: 1.1,
      }}>
        {value}
      </div>
    </div>
  );
}

function InsufficientDataPlaceholder({ sampled }) {
  return (
    <div style={{
      padding: '18px 14px',
      background: C.bg,
      borderRadius: 8,
      border: `1px dashed ${C.border}`,
      textAlign: 'center',
    }}>
      <BarChart2 size={22} color={C.textMuted} style={{ marginBottom: 8 }} />
      <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.6 }}>
        Insufficient data —
        <br />
        minimum {MIN_TRADES} trades required
      </div>
      {sampled != null && (
        <div style={{
          marginTop: 10,
          fontSize: 11,
          fontWeight: 700,
          color: C.blue,
          background: `${C.blue}15`,
          borderRadius: 20,
          padding: '3px 10px',
          display: 'inline-block',
        }}>
          {sampled} / {MIN_TRADES} trades sampled
        </div>
      )}
    </div>
  );
}

function WeightBadge({ weight }) {
  if (weight == null) {
    return (
      <span style={{
        fontSize: 13, fontWeight: 700, color: C.textMuted,
        border: `1px solid ${C.border}`,
        borderRadius: 20, padding: '2px 10px',
      }}>
        —
      </span>
    );
  }

  const isAbove = weight > 1.0;
  const isBelow = weight < 1.0;
  const color = isAbove ? C.green : isBelow ? C.amber : C.textMuted;

  return (
    <span style={{
      fontSize: 13,
      fontWeight: 700,
      color,
      background: `${color}18`,
      border: `1px solid ${color}60`,
      borderRadius: 20,
      padding: '3px 10px',
      letterSpacing: '0.02em',
    }}>
      {weight.toFixed(2)}×
    </span>
  );
}

function AgentCard({ agent, rows }) {
  const latest    = rows.length > 0 ? rows[rows.length - 1] : null;
  const sparkRows = rows.slice(-4);
  const hasData   = latest != null && latest.trades_sampled >= MIN_TRADES;

  return (
    <div style={{
      background: C.surface,
      border:     `1px solid ${C.border}`,
      borderRadius: 12,
      padding:    '20px',
      display:    'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      {/* Card header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <agent.Icon size={18} />
          <span style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
            {agent.label}
          </span>
        </div>
        <WeightBadge weight={latest?.current_weight ?? null} />
      </div>

      {!hasData ? (
        <InsufficientDataPlaceholder sampled={latest?.trades_sampled ?? null} />
      ) : (
        <>
          {/* Metrics grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
          }}>
            {/* Contrarian Accuracy spans both columns — most important metric */}
            <div style={{ gridColumn: '1 / -1' }}>
              <MetricTile
                label="Contrarian Accuracy"
                value={pct(latest.dissent_correct_rate)}
                size="lg"
                accent
              />
            </div>
            <MetricTile
              label="Overall Accuracy"
              value={pct(latest.overall_accuracy)}
            />
            <MetricTile
              label="Trades Sampled"
              value={latest.trades_sampled.toLocaleString()}
            />
          </div>

          {/* Sparkline section */}
          <div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 4,
            }}>
              <span style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: C.textMuted,
              }}>
                4-Week Accuracy Trend
              </span>
              <TrendBadge data={sparkRows} />
            </div>
            <WeeklySparkline data={sparkRows} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Weight comparison chart ──────────────────────────────────────────────────

function WeightTooltipContent({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, weight } = payload[0].payload;
  const isAbove = weight > 1.0;
  const isBelow = weight < 1.0;
  const color   = isAbove ? C.green : isBelow ? C.amber : C.textMuted;
  const status  = isAbove ? 'Above baseline' : isBelow ? 'Below baseline' : 'At baseline';
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 12,
      color: C.text,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{name}</div>
      <div>
        <span style={{ color }}>
          {weight.toFixed(3)}× vote weight
        </span>
      </div>
      <div style={{ color: C.textMuted, marginTop: 2, fontSize: 11 }}>{status}</div>
    </div>
  );
}

function WeightComparisonChart({ agentData }) {
  const chartData = AGENTS.map(agent => {
    const rows   = agentData[agent.key] ?? [];
    const latest = rows.length > 0 ? rows[rows.length - 1] : null;
    return {
      name:   agent.label,
      weight: latest?.current_weight ?? 1.0,
    };
  });

  const maxWeight = Math.max(...chartData.map(d => d.weight), 1.5);
  const domain    = [0, Math.ceil(maxWeight * 10) / 10 + 0.1];

  return (
    <div style={{
      background: C.surface,
      border:     `1px solid ${C.border}`,
      borderRadius: 12,
      padding:    '20px 24px 16px',
    }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: C.text }}>
          Vote Weight Comparison
        </h3>
        <p style={{ margin: '5px 0 0', fontSize: 12, color: C.textMuted }}>
          Weights start at 1.0× and shift weekly based on prediction accuracy.
          &nbsp;
          <span style={{ color: C.green }}>Green = outperforming</span>
          {' · '}
          <span style={{ color: C.amber }}>Amber = underperforming</span>
        </p>
      </div>

      <ResponsiveContainer width="100%" height={210}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 56, bottom: 8, left: 4 }}
          barSize={22}
        >
          <CartesianGrid
            horizontal={false}
            stroke={C.border}
            strokeDasharray="4 4"
            opacity={0.5}
          />
          <XAxis
            type="number"
            domain={domain}
            tick={{ fill: C.textMuted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickCount={6}
            tickFormatter={v => `${v.toFixed(1)}×`}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: C.text, fontSize: 13, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={108}
          />
          <Tooltip
            cursor={{ fill: '#ffffff05' }}
            content={<WeightTooltipContent />}
          />
          {/* Baseline reference */}
          <ReferenceLine
            x={1}
            stroke={C.textFaint}
            strokeDasharray="5 3"
            label={{
              value: 'baseline',
              position: 'insideTopRight',
              fill: C.textFaint,
              fontSize: 10,
              dy: -6,
            }}
          />
          <Bar dataKey="weight" radius={[0, 5, 5, 0]}>
            {chartData.map((entry, idx) => (
              <Cell
                key={idx}
                fill={
                  entry.weight > 1.0 ? C.green
                  : entry.weight < 1.0 ? C.amber
                  : C.textMuted
                }
                opacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function AgentReputation() {
  // Fetch all history ascending so sparklines and groupByAgent work correctly.
  const { data: rows, loading, error } = useRealtimeTable('agent_reputation', {
    orderBy:   'week_ending',
    ascending: true,
  });

  const agentData = useMemo(() => groupByAgent(rows), [rows]);

  return (
    <div style={{
      padding:    '24px',
      background: C.bg,
      minHeight:  '100%',
      fontFamily: "'Inter', 'SF Pro Display', system-ui, sans-serif",
    }}>
      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
          Agent Reputation
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: C.textMuted }}>
          Weekly accuracy scores · Updated nightly by the Reflection Agent
        </p>
      </div>

      {error && (
        <div style={{
          background: '#450a0a',
          border: `1px solid #dc2626`,
          borderRadius: 8,
          padding: '12px 16px',
          color: '#fca5a5',
          fontSize: 13,
          marginBottom: 20,
        }}>
          Failed to load reputation data: {error.message}
        </div>
      )}

      {loading ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 200,
          color: C.textMuted,
          fontSize: 14,
          gap: 10,
        }}>
          <span style={{
            display: 'inline-block',
            width: 16,
            height: 16,
            borderRadius: '50%',
            border: `2px solid ${C.border}`,
            borderTopColor: C.blue,
            animation: 'spin 0.8s linear infinite',
          }} />
          Loading reputation data…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <>
          {/* Agent performance cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(264px, 1fr))',
            gap: 16,
            marginBottom: 20,
          }}>
            {AGENTS.map(agent => (
              <AgentCard
                key={agent.key}
                agent={agent}
                rows={agentData[agent.key] ?? []}
              />
            ))}
          </div>

          {/* Weight comparison bar chart */}
          <WeightComparisonChart agentData={agentData} />
        </>
      )}
    </div>
  );
}
