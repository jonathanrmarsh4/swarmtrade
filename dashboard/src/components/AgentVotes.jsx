// AgentVotes — displays the vote breakdown per deliberation.
// Shows all 6 agents: Bull, Bear, Quant, Macro, Sentiment, Risk
// Used as an embedded sub-component inside DeliberationLog.

const C = {
  bg:        '#0D1B2A',
  surface:   '#112233',
  border:    '#1e3a52',
  green:     '#4ade80',
  amber:     '#f59e0b',
  red:       '#f87171',
  blue:      '#60a5fa',
  purple:    '#a78bfa',
  teal:      '#2dd4bf',
  text:      '#f8fafc',
  textMuted: '#64748b',
};

// Score bar — renders a labelled progress bar 0–100
function VoteBar({ label, score, color, rebuttal, pill }) {
  const pct = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: 11, color: C.textMuted,
      }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {pill && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: pill.color,
              background: `${pill.color}18`,
              border: `1px solid ${pill.color}50`,
              borderRadius: 20,
              padding: '1px 7px',
            }}>
              {pill.text}
            </span>
          )}
          <span style={{ fontWeight: 800, color }}>{score ?? '—'}</span>
        </div>
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

// Risk gate status badge
function RiskBadge({ approved, reason }) {
  const color  = approved ? C.green : C.red;
  const label  = approved ? '✓ APPROVED' : '✗ VETOED';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: 11, color: C.textMuted,
      }}>
        <span style={{ fontWeight: 600 }}>🛡 Risk Gate</span>
        <span style={{
          fontSize: 10, fontWeight: 700,
          color,
          background: `${color}18`,
          border: `1px solid ${color}50`,
          borderRadius: 20,
          padding: '2px 8px',
        }}>
          {label}
        </span>
      </div>
      {reason && (
        <p style={{
          margin: 0, fontSize: 11, color: C.textMuted,
          lineHeight: 1.5, fontStyle: 'italic',
        }}>
          "{reason}"
        </p>
      )}
    </div>
  );
}

/**
 * Render the full 6-agent vote panel for a single deliberation row.
 * @param {{ deliberation: object }} props
 */
export default function AgentVotes({ deliberation: d }) {
  if (!d) return null;

  // Derive macro pill from regime field
  const macroRegime = d.macro_regime ?? null;
  const macroPill   = macroRegime ? {
    text:  macroRegime,
    color: macroRegime === 'risk-on'  ? C.green
         : macroRegime === 'risk-off' ? C.red
         : C.amber,
  } : null;

  // Quant EV: stored as decimal e.g. 0.04, display as percentage
  const quantScore = d.quant_ev != null ? Math.round(d.quant_ev * 100) : null;

  // Risk approved comes from risk_approved boolean on deliberation row
  const riskApproved = d.risk_approved ?? null;

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

      {/* Row 1: Bull */}
      <VoteBar
        label="🟢 Bull"
        score={d.bull_score}
        color={C.green}
        rebuttal={d.bull_rebuttal}
      />

      {/* Row 2: Bear */}
      <VoteBar
        label="🔴 Bear"
        score={d.bear_score}
        color={C.red}
        rebuttal={d.bear_rebuttal}
      />

      {/* Row 3: Macro — now a full score bar with regime pill */}
      <VoteBar
        label="🌍 Macro"
        score={d.macro_score ?? (macroRegime === 'risk-on' ? 70 : macroRegime === 'risk-off' ? 30 : 50)}
        color={C.teal}
        pill={macroPill}
      />

      {/* Row 4: Quant EV */}
      <VoteBar
        label="📊 Quant EV"
        score={quantScore}
        color={C.blue}
      />

      {/* Row 5: Sentiment */}
      <VoteBar
        label="💬 Sentiment"
        score={d.sentiment_score}
        color={C.amber}
      />

      {/* Divider */}
      <div style={{ height: 1, background: C.border, margin: '0 -4px' }} />

      {/* Row 6: Risk Gate — always last, it's the final arbiter */}
      {riskApproved !== null ? (
        <RiskBadge
          approved={riskApproved}
          reason={d.risk_reason ?? null}
        />
      ) : (
        <div style={{ fontSize: 11, color: C.textMuted, fontStyle: 'italic' }}>
          🛡 Risk Gate — pending
        </div>
      )}
    </div>
  );
}
