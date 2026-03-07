'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Trading Profiles — single source of truth for all timeframe-aware config.
//
// Each profile defines:
//   candleInterval   — Binance kline interval for background scan
//   candleLimit      — candles to fetch per scan
//   signalTimeframe  — written to signal/deliberation rows
//   rsiOversold      — RSI threshold to flag as oversold (score +1)
//   rsiOverbought    — RSI threshold to flag as overbought (score +1)
//   volumeSpikeMult  — volume multiplier to flag a spike (score +1)
//   atrMultiplier    — multiplier applied to ATR for stop-loss distance
//   maxPositionPct   — hard ceiling on position size (% of portfolio)
//   wsEscalationMs   — signal window for WebSocket escalation (ms)
//   holdDescription  — human-readable hold period for agent prompts
//   label            — display name
//   color            — dashboard accent colour
// ─────────────────────────────────────────────────────────────────────────────

const TRADING_PROFILES = {
  intraday: {
    id:              'intraday',
    label:           'Intraday',
    description:     'Hold hours — same session',
    color:           '#f59e0b',
    candleInterval:  '15m',
    candleLimit:     100,
    signalTimeframe: '15m',
    rsiOversold:     35,
    rsiOverbought:   65,
    volumeSpikeMult: 1.5,
    atrMultiplier:   1.5,
    maxPositionPct:  0.05,   // 5% — tighter, faster trades
    wsEscalationMs:  2 * 60 * 1000,   // 2-min window
    holdDescription: 'intraday — entry and exit within the same trading session (hours, not overnight)',
  },
  dayTrade: {
    id:              'dayTrade',
    label:           'Day Trade',
    description:     'Hold <24h',
    color:           '#60a5fa',
    candleInterval:  '1h',
    candleLimit:     50,
    signalTimeframe: '1h',
    rsiOversold:     30,
    rsiOverbought:   70,
    volumeSpikeMult: 2.0,
    atrMultiplier:   2.0,
    maxPositionPct:  0.07,   // 7%
    wsEscalationMs:  5 * 60 * 1000,   // 5-min window
    holdDescription: 'day trade — target exit within 24 hours, no multi-day holds',
  },
  swing: {
    id:              'swing',
    label:           'Swing',
    description:     'Hold 2–4 days',
    color:           '#a78bfa',
    candleInterval:  '4h',
    candleLimit:     60,
    signalTimeframe: '4h',
    rsiOversold:     30,
    rsiOverbought:   70,
    volumeSpikeMult: 2.0,
    atrMultiplier:   2.5,
    maxPositionPct:  0.08,   // 8%
    wsEscalationMs:  10 * 60 * 1000,  // 10-min window
    holdDescription: 'swing trade — hold 2–4 days, riding a medium-term price move',
  },
  position: {
    id:              'position',
    label:           'Position',
    description:     'Hold up to 7 days',
    color:           '#4ade80',
    candleInterval:  '1d',
    candleLimit:     30,
    signalTimeframe: '1d',
    rsiOversold:     25,
    rsiOverbought:   75,
    volumeSpikeMult: 3.0,
    atrMultiplier:   3.0,
    maxPositionPct:  0.10,   // 10% — largest allowed
    wsEscalationMs:  30 * 60 * 1000,  // 30-min window
    holdDescription: 'position trade — hold up to 7 days, targeting a significant directional move',
  },
};

// All profiles run simultaneously
const ALL_PROFILE_IDS = Object.keys(TRADING_PROFILES);

module.exports = { TRADING_PROFILES, ALL_PROFILE_IDS };
