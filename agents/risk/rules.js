'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Risk rules — SINGLE SOURCE OF TRUTH for all risk management logic.
// NO LLM. NO ANTHROPIC. Zero hallucination tolerance.
//
// v2: Trading profile aware — position size and ATR multiplier scale with
// the active trading profile (intraday → position). All other hard limits
// (max concurrent, drawdown stop, min R:R) are profile-independent.
// ─────────────────────────────────────────────────────────────────────────────

const { TRADING_PROFILES } = require('../../config/trading-profiles.js');

// ── Profile-independent constants ─────────────────────────────────────────────

const MAX_PORTFOLIO_RISK_PCT  = 0.02;   // 2% of portfolio risked per trade (all profiles)
const MAX_CONCURRENT_POSITIONS = 3;     // hard limit on open positions
const MAX_DRAWDOWN_PAPER       = 0.05;  // 5% drawdown stop — paper mode
const MAX_DRAWDOWN_LIVE        = 0.03;  // 3% drawdown stop — live mode
const MIN_RISK_REWARD_RATIO    = 1.5;   // minimum R:R across all profiles

// ── Profile-aware position sizing ─────────────────────────────────────────────
// Max position size scales with trading profile:
//   Intraday  : 5%   (fastest — tightest exposure)
//   Day Trade : 7%
//   Swing     : 8%
//   Position  : 10%  (slowest — largest allowed)
//
// @param {string} tradingMode — profile id ('intraday'|'dayTrade'|'swing'|'position')
// @returns {number} max position as decimal (e.g. 0.07)
function getMaxPositionPct(tradingMode) {
  const profile = TRADING_PROFILES[tradingMode];
  return profile ? profile.maxPositionPct : 0.07; // default to dayTrade if unknown
}

// ── calculatePositionSize ─────────────────────────────────────────────────────
// ATR-based position sizing, capped by profile's max position percentage.
//
// Formula:
//   rawSizeUsd = (portfolioValue × MAX_PORTFOLIO_RISK_PCT) / (atr × atrMultiplier)
//   capUsd     = portfolioValue × maxPositionPct
//   result     = min(rawSizeUsd, capUsd)
//
// atrMultiplier from profile ensures stops scale appropriately:
//   Intraday 1.5× ATR stop → tighter stop → larger raw size → cap kicks in more often
//   Position 3.0× ATR stop → wider stop  → smaller raw size → approaches cap less often
//
// @param {number} portfolioValue
// @param {number} atr
// @param {number} entryPrice
// @param {string} tradingMode
function calculatePositionSize(portfolioValue, atr, entryPrice, tradingMode = 'dayTrade') {
  if (typeof portfolioValue !== 'number' || portfolioValue <= 0)
    throw new Error(`calculatePositionSize: portfolioValue must be positive, got ${portfolioValue}`);
  if (typeof atr !== 'number' || atr <= 0)
    throw new Error(`calculatePositionSize: atr must be positive, got ${atr}`);
  if (typeof entryPrice !== 'number' || entryPrice <= 0)
    throw new Error(`calculatePositionSize: entryPrice must be positive, got ${entryPrice}`);

  const profile        = TRADING_PROFILES[tradingMode] ?? TRADING_PROFILES.dayTrade;
  const atrMultiplier  = profile.atrMultiplier;
  const maxPositionPct = profile.maxPositionPct;

  const rawSizeUsd = (portfolioValue * MAX_PORTFOLIO_RISK_PCT) / (atr * atrMultiplier);
  const capUsd     = portfolioValue * maxPositionPct;

  return parseFloat(Math.min(rawSizeUsd, capUsd).toFixed(2));
}

// ── checkVeto ─────────────────────────────────────────────────────────────────
// Applies all risk rules in sequence. First failing rule returns immediately.
//
// Rules (in order):
//   1. Max concurrent positions
//   2. Portfolio drawdown hard stop (mode-aware: paper vs live)
//   3. Minimum R:R ratio (only when takeProfit supplied)
//
// @param {object} portfolioState
//   openPositions, currentDrawdownPct, portfolioValue, mode ('paper'|'live')
//
// @param {object} proposedTrade
//   asset, direction, entryPrice, stopLoss, atr, takeProfit?, tradingMode?
//
// @returns {{ approved: boolean, reason: string, positionSizePct: number }}
function checkVeto(portfolioState, proposedTrade) {
  const { openPositions, currentDrawdownPct, portfolioValue, mode } = portfolioState;
  const { asset, direction, entryPrice, stopLoss, atr, takeProfit, tradingMode = 'dayTrade' } = proposedTrade;

  const profile = TRADING_PROFILES[tradingMode] ?? TRADING_PROFILES.dayTrade;

  // ── Rule 1: Max concurrent positions ───────────────────────────────────────
  if (openPositions >= MAX_CONCURRENT_POSITIONS) {
    return {
      approved: false, positionSizePct: 0,
      reason: `Max concurrent positions reached: ${openPositions}/${MAX_CONCURRENT_POSITIONS}. No new trades until an existing position closes.`,
    };
  }

  // ── Rule 2: Drawdown hard stop ──────────────────────────────────────────────
  const drawdownThreshold = mode === 'live' ? MAX_DRAWDOWN_LIVE : MAX_DRAWDOWN_PAPER;
  if (currentDrawdownPct >= drawdownThreshold) {
    return {
      approved: false, positionSizePct: 0,
      reason: `Portfolio drawdown of ${(currentDrawdownPct * 100).toFixed(2)}% breaches the ${(drawdownThreshold * 100).toFixed(0)}% hard stop for ${mode} mode.`,
    };
  }

  // ── Rule 3: Minimum R:R ratio ───────────────────────────────────────────────
  if (takeProfit != null) {
    const riskPerUnit   = Math.abs(entryPrice - stopLoss);
    const rewardPerUnit = Math.abs(takeProfit - entryPrice);

    if (riskPerUnit <= 0) {
      return {
        approved: false, positionSizePct: 0,
        reason: `Invalid stop loss for ${asset} ${direction}: stopLoss (${stopLoss}) equals entryPrice (${entryPrice}).`,
      };
    }

    const rrRatio = rewardPerUnit / riskPerUnit;
    if (rrRatio < MIN_RISK_REWARD_RATIO) {
      return {
        approved: false, positionSizePct: 0,
        reason: `R:R of ${rrRatio.toFixed(2)}:1 on ${asset} (${profile.label}) falls below minimum ${MIN_RISK_REWARD_RATIO}:1.`,
      };
    }
  }

  // ── Approved ────────────────────────────────────────────────────────────────
  const positionSizeUsd = calculatePositionSize(portfolioValue, atr, entryPrice, tradingMode);
  const positionSizePct = parseFloat(((positionSizeUsd / portfolioValue) * 100).toFixed(4));

  return {
    approved: true,
    positionSizePct,
    reason: `Approved [${profile.label}]. Size: ${positionSizePct}% ($${positionSizeUsd}) · ATR×${profile.atrMultiplier} · Max: ${(profile.maxPositionPct * 100).toFixed(0)}% · Drawdown: ${(currentDrawdownPct * 100).toFixed(2)}% / ${(drawdownThreshold * 100).toFixed(0)}% · Positions: ${openPositions + 1}/${MAX_CONCURRENT_POSITIONS}`,
  };
}

module.exports = {
  MAX_PORTFOLIO_RISK_PCT, MAX_CONCURRENT_POSITIONS,
  MAX_DRAWDOWN_PAPER, MAX_DRAWDOWN_LIVE, MIN_RISK_REWARD_RATIO,
  calculatePositionSize, checkVeto, getMaxPositionPct,
};
