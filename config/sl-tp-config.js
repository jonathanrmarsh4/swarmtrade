'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Stop Loss / Take Profit Configuration — SINGLE SOURCE OF TRUTH
//
// Three strategies available:
//
//  'atr'        — ATR-based (recommended for crypto). Stop and TP are multiples
//                 of the Average True Range. Adapts automatically to volatility.
//                 stopMult × ATR = stop distance from entry.
//                 tpMult   × ATR = TP distance from entry.
//
//  'percentage' — Fixed percentage from entry. Simple, predictable.
//                 stopPct = % distance to stop (e.g. 0.02 = 2%).
//                 tpPct   = % distance to TP  (e.g. 0.06 = 6% → 3:1 R:R).
//
//  'sr'         — Support/Resistance based. Stop placed just beyond the nearest
//                 S/R level; TP placed at the next S/R level beyond entry.
//                 srBuffer = padding % beyond the S/R level (e.g. 0.005 = 0.5%).
//                 Falls back to ATR if S/R data not available.
//
// Per-profile overrides allow different strategies for different timeframes.
// If a profile has no override, the global default is used.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SL_TP_CONFIG = {

  // ── Global defaults (apply to all profiles unless overridden below) ─────────
  global: {
    strategy:  'atr',     // 'atr' | 'percentage' | 'sr'
    stopMult:  1.5,       // ATR: stop at 1.5× ATR from entry
    tpMult:    3.0,       // ATR: TP at 3.0× ATR from entry → 2:1 R:R
    stopPct:   0.025,     // Percentage: 2.5% stop
    tpPct:     0.060,     // Percentage: 6.0% TP → ~2.4:1 R:R
    srBuffer:  0.005,     // S/R: 0.5% buffer beyond the S/R level
    minRR:     1.5,       // Minimum acceptable R:R — rejects trade if not met
  },

  // ── Per-profile overrides ───────────────────────────────────────────────────
  // Only fields listed here override the global; the rest still come from global.
  profiles: {
    intraday: {
      strategy: 'atr',
      stopMult: 1.2,   // Tighter stop for fast intraday moves
      tpMult:   2.4,   // 2:1 R:R
    },
    dayTrade: {
      strategy: 'atr',
      stopMult: 1.5,
      tpMult:   3.0,   // 2:1 R:R
    },
    swing: {
      strategy: 'atr',
      stopMult: 2.0,   // Wider stop — more room to breathe over 2-4 days
      tpMult:   5.0,   // ~2.5:1 R:R
    },
    position: {
      strategy: 'atr',
      stopMult: 2.5,   // Widest — weekly position needs slack
      tpMult:   7.5,   // 3:1 R:R for longer holds
    },
  },
};

// ── getProfileConfig ──────────────────────────────────────────────────────────
// Returns the merged config (global + profile override) for a trading mode.
function getProfileConfig(tradingMode, overrides = DEFAULT_SL_TP_CONFIG) {
  const global   = overrides.global;
  const profile  = overrides.profiles?.[tradingMode] ?? {};
  return { ...global, ...profile };
}

// ── calculateLevels ───────────────────────────────────────────────────────────
// Computes stop loss and take profit prices given entry context.
//
// @param {object} params
//   direction    — 'long' | 'short'
//   entryPrice   — numeric
//   atr          — numeric (ATR of the asset at signal time)
//   support      — numeric|null (from scanner)
//   resistance   — numeric|null (from scanner)
//   tradingMode  — profile id
//   config       — optional full SL/TP config object (reads from DEFAULT if omitted)
//
// @returns {{ stopLoss: number, takeProfit: number, strategy: string, rr: number }}
function calculateLevels({ direction, entryPrice, atr, support, resistance, tradingMode = 'dayTrade', config }) {
  const cfg = getProfileConfig(tradingMode, config ?? DEFAULT_SL_TP_CONFIG);
  const isLong = direction === 'long';
  const dp = entryPrice > 1000 ? 2 : entryPrice > 1 ? 4 : 6;

  let stopLoss, takeProfit, usedStrategy = cfg.strategy;

  if (cfg.strategy === 'sr' && support != null && resistance != null) {
    // S/R strategy: stop just beyond the relevant S/R level
    if (isLong) {
      stopLoss   = parseFloat((support    * (1 - cfg.srBuffer)).toFixed(dp));
      takeProfit = parseFloat((resistance * (1 - cfg.srBuffer)).toFixed(dp));  // exit before resistance
    } else {
      stopLoss   = parseFloat((resistance * (1 + cfg.srBuffer)).toFixed(dp));
      takeProfit = parseFloat((support    * (1 + cfg.srBuffer)).toFixed(dp));  // exit before support
    }

    // Validate — if S/R gives a bad setup, fall back to ATR
    const stopDist   = Math.abs(entryPrice - stopLoss);
    const rewardDist = Math.abs(takeProfit - entryPrice);
    if (stopDist <= 0 || rewardDist / stopDist < cfg.minRR) {
      usedStrategy = 'atr (sr fallback)';
      stopLoss     = null; // trigger ATR below
    }
  }

  if (cfg.strategy === 'percentage') {
    stopLoss   = isLong
      ? parseFloat((entryPrice * (1 - cfg.stopPct)).toFixed(dp))
      : parseFloat((entryPrice * (1 + cfg.stopPct)).toFixed(dp));
    takeProfit = isLong
      ? parseFloat((entryPrice * (1 + cfg.tpPct)).toFixed(dp))
      : parseFloat((entryPrice * (1 - cfg.tpPct)).toFixed(dp));
  }

  // ATR strategy (also used as fallback)
  if (cfg.strategy === 'atr' || stopLoss == null) {
    const safeAtr = atr > 0 ? atr : entryPrice * 0.02;
    stopLoss   = isLong
      ? parseFloat((entryPrice - cfg.stopMult * safeAtr).toFixed(dp))
      : parseFloat((entryPrice + cfg.stopMult * safeAtr).toFixed(dp));
    takeProfit = isLong
      ? parseFloat((entryPrice + cfg.tpMult   * safeAtr).toFixed(dp))
      : parseFloat((entryPrice - cfg.tpMult   * safeAtr).toFixed(dp));
    if (usedStrategy !== 'atr (sr fallback)') usedStrategy = 'atr';
  }

  const riskDist   = Math.abs(entryPrice - stopLoss);
  const rewardDist = Math.abs(takeProfit - entryPrice);
  const rr = riskDist > 0 ? parseFloat((rewardDist / riskDist).toFixed(2)) : 0;

  return { stopLoss, takeProfit, strategy: usedStrategy, rr };
}

module.exports = { DEFAULT_SL_TP_CONFIG, getProfileConfig, calculateLevels };
