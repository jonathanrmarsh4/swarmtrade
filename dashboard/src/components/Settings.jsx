import TestSignal from './TestSignal';
import { Settings as SettingsIcon, FlaskConical, Webhook, Shield, Clock } from 'lucide-react';

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
