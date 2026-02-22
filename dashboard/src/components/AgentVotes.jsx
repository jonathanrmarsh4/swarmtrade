// AgentVotes — displays the vote breakdown per deliberation.
// Shows each agent's confidence score, direction (bull/bear), and whether they were the dissenting voice.
// Visualises the committee consensus or division for each signal.
// Used as an embedded sub-component inside DeliberationLog.

const C = {
  bg:        '#0D1B2A',
  surface:   '#112233',
  border:    '#1e3a52',
  green:     '#4ade80',
  amber:     '#f59e0b',
  red:       '#f87171',
  blue:      '#60a5fa',
  text:      '#f8fafc',
  textMuted: '#64748b',
};

// Score as a coloured bar from 0–100
function VoteBar({ label, score, color, rebuttal }) {
  const pct = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, color: C.textMuted,
      }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ fontWeight: 800, color }}>{score ?? '—'}</span>
      </div>
      <div style={{
        height: 4, background: C.bg, borderRadius: 3, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color,
          borderRadius: 3, transition: 'width 0.4s ease',
        }} />
      </div>
      {rebuttal && (
        <p style={{
          margin: 0, fontSize: 11, color: C.textMuted,
          lineHeight: 1.5, fontStyle: 'italic',
        }}>
          "{rebuttal}"
        </p>
      )}
    </div>
  );
}

/**
 * Render the 5-agent vote panel for a single deliberation row.
 *
 * @param {{ deliberation: object }} props
 */
export default function AgentVotes({ deliberation: d }) {
  if (!d) return null;

  return (
    <div style={{
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{
        fontSize: 9, fontWeight: 700,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        color: C.textMuted, marginBottom: 2,
      }}>
        Committee Votes
      </div>

      <VoteBar
        label="🟢 Bull"
        score={d.bull_score}
        color={C.green}
        rebuttal={d.bull_rebuttal}
      />
      <VoteBar
        label="🔴 Bear"
        score={d.bear_score}
        color={C.red}
        rebuttal={d.bear_rebuttal}
      />
      <VoteBar
        label="📊 Quant EV"
        score={d.quant_ev != null ? Math.round(d.quant_ev * 100) : null}
        color={C.blue}
      />
      <VoteBar
        label="💬 Sentiment"
        score={d.sentiment_score}
        color={C.amber}
      />

      {/* Macro regime pill */}
      {d.macro_regime && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>🌍 Macro regime:</span>
          <span style={{
            fontSize: 11, fontWeight: 700,
            color: d.macro_regime === 'risk-on' ? C.green
              : d.macro_regime === 'risk-off' ? C.red
              : C.amber,
            background: d.macro_regime === 'risk-on' ? `${C.green}18`
              : d.macro_regime === 'risk-off' ? `${C.red}18`
              : `${C.amber}18`,
            border: `1px solid ${
              d.macro_regime === 'risk-on' ? `${C.green}50`
              : d.macro_regime === 'risk-off' ? `${C.red}50`
              : `${C.amber}50`
            }`,
            borderRadius: 20,
            padding: '2px 9px',
          }}>
            {d.macro_regime}
            {d.macro_flag ? ' ⚠ flag active' : ''}
          </span>
        </div>
      )}
    </div>
  );
}
