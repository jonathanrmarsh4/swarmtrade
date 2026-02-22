'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Risk rules — SINGLE SOURCE OF TRUTH for all risk management logic.
//
// NO LLM. NO ANTHROPIC. Zero hallucination tolerance.
// Hardcoded constants and deterministic functions only.
// To change any rule, change it here. Never encode risk logic elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

// ── Rule constants ────────────────────────────────────────────────────────────

// Maximum portfolio equity risked on a single trade.
// Risk = (portfolioValue × MAX_PORTFOLIO_RISK_PCT) / atr
const MAX_PORTFOLIO_RISK_PCT = 0.02;        // 2% max per trade

// Maximum number of simultaneously open positions at any time.
const MAX_CONCURRENT_POSITIONS = 3;

// Hard drawdown ceiling per trading mode.
// Breaching this stops ALL new trades until manually reviewed.
const MAX_DRAWDOWN_PAPER = 0.05;            // 5% hard stop — paper trading
const MAX_DRAWDOWN_LIVE  = 0.03;            // 3% hard stop — live trading (Phase 4+)

// Minimum acceptable reward-to-risk ratio on a proposed trade.
// Trades with reward < 1.5× the defined risk are vetoed.
const MIN_RISK_REWARD_RATIO = 1.5;

// Hard ceiling on position size regardless of ATR calculation.
// Prevents oversized exposure on low-volatility assets.
const MAX_POSITION_SIZE_PCT = 0.10;         // 10% of portfolio per trade

// ── calculatePositionSize ─────────────────────────────────────────────────────
// Returns the approved position size in USD using ATR-based risk sizing.
//
// Formula:
//   positionSizeUsd = (portfolioValue × MAX_PORTFOLIO_RISK_PCT) / atr
//   cap             = portfolioValue × MAX_POSITION_SIZE_PCT
//   result          = min(positionSizeUsd, cap)
//
// Higher ATR → larger denominator → smaller position. This ensures that
// position size scales inversely with volatility.
//
// @param {number} portfolioValue  — total portfolio value in USD
// @param {number} atr             — current ATR in price units (same denomination as entryPrice)
// @param {number} entryPrice      — proposed entry price (used for validation only; sizing is ATR-driven)
// @returns {number} positionSizeUsd — approved position value in USD
function calculatePositionSize(portfolioValue, atr, entryPrice) {
  if (typeof portfolioValue !== 'number' || portfolioValue <= 0) {
    throw new Error(`calculatePositionSize: portfolioValue must be a positive number, got ${portfolioValue}`);
  }
  if (typeof atr !== 'number' || atr <= 0) {
    throw new Error(`calculatePositionSize: atr must be a positive number, got ${atr}`);
  }
  if (typeof entryPrice !== 'number' || entryPrice <= 0) {
    throw new Error(`calculatePositionSize: entryPrice must be a positive number, got ${entryPrice}`);
  }

  const rawSizeUsd = (portfolioValue * MAX_PORTFOLIO_RISK_PCT) / atr;
  const capUsd     = portfolioValue * MAX_POSITION_SIZE_PCT;

  return parseFloat(Math.min(rawSizeUsd, capUsd).toFixed(2));
}

// ── checkVeto ─────────────────────────────────────────────────────────────────
// Applies all risk rules in sequence. The first failing rule returns an
// immediate veto — remaining rules are not evaluated.
//
// Rules evaluated in order:
//   1. Max concurrent positions
//   2. Portfolio drawdown hard stop (mode-aware)
//   3. Minimum risk/reward ratio (only when proposedTrade.takeProfit is supplied)
//
// @param {object} portfolioState
// @param {number} portfolioState.openPositions     — count of currently open positions
// @param {number} portfolioState.currentDrawdownPct — current drawdown as a decimal (0.04 = 4%)
// @param {number} portfolioState.portfolioValue     — total portfolio value in USD
// @param {string} portfolioState.mode              — 'paper' | 'live'
//
// @param {object} proposedTrade
// @param {string} proposedTrade.asset       — e.g. 'BTC/USDT'
// @param {string} proposedTrade.direction   — 'long' | 'short' | 'close'
// @param {number} proposedTrade.entryPrice  — proposed entry price in USD
// @param {number} proposedTrade.stopLoss    — stop loss price in USD
// @param {number} proposedTrade.atr         — current ATR in price units
// @param {number} [proposedTrade.takeProfit] — take profit price (optional; enables R:R check)
//
// @returns {{ approved: boolean, reason: string, positionSizePct: number }}
function checkVeto(portfolioState, proposedTrade) {
  const { openPositions, currentDrawdownPct, portfolioValue, mode } = portfolioState;
  const { asset, direction, entryPrice, stopLoss, atr, takeProfit } = proposedTrade;

  // ── Rule 1: Max concurrent positions ───────────────────────────────────────
  if (openPositions >= MAX_CONCURRENT_POSITIONS) {
    return {
      approved:        false,
      positionSizePct: 0,
      reason:          `Max concurrent positions reached: ${openPositions}/${MAX_CONCURRENT_POSITIONS}. No new trades until an existing position closes.`,
    };
  }

  // ── Rule 2: Drawdown hard stop (mode-aware) ─────────────────────────────────
  const drawdownThreshold = mode === 'live' ? MAX_DRAWDOWN_LIVE : MAX_DRAWDOWN_PAPER;
  if (currentDrawdownPct >= drawdownThreshold) {
    return {
      approved:        false,
      positionSizePct: 0,
      reason:          `Portfolio drawdown of ${(currentDrawdownPct * 100).toFixed(2)}% breaches the ${(drawdownThreshold * 100).toFixed(0)}% hard stop for ${mode} mode. All new trades halted pending manual review.`,
    };
  }

  // ── Rule 3: Minimum risk/reward ratio ──────────────────────────────────────
  // Only evaluated when a take-profit price is present on the proposed trade.
  // Signals that omit takeProfit bypass this check — the Orchestrator should
  // include it for complete veto coverage.
  if (takeProfit != null) {
    const riskPerUnit   = Math.abs(entryPrice - stopLoss);
    const rewardPerUnit = Math.abs(takeProfit - entryPrice);

    if (riskPerUnit <= 0) {
      return {
        approved:        false,
        positionSizePct: 0,
        reason:          `Invalid stop loss for ${asset} ${direction}: stopLoss (${stopLoss}) equals entryPrice (${entryPrice}). Stop loss must differ from entry.`,
      };
    }

    const rrRatio = rewardPerUnit / riskPerUnit;
    if (rrRatio < MIN_RISK_REWARD_RATIO) {
      return {
        approved:        false,
        positionSizePct: 0,
        reason:          `Risk/reward ratio of ${rrRatio.toFixed(2)}:1 on ${asset} ${direction} falls below the minimum threshold of ${MIN_RISK_REWARD_RATIO}:1. Improve target or tighten stop loss.`,
      };
    }
  }

  // ── Approved: calculate final position size ─────────────────────────────────
  const positionSizeUsd  = calculatePositionSize(portfolioValue, atr, entryPrice);
  const positionSizePct  = parseFloat(((positionSizeUsd / portfolioValue) * 100).toFixed(4));

  return {
    approved:        true,
    positionSizePct,
    reason:          `Approved. Position size: ${positionSizePct}% ($${positionSizeUsd}) of $${portfolioValue} portfolio. ATR: ${atr}. Drawdown: ${(currentDrawdownPct * 100).toFixed(2)}% (limit: ${(drawdownThreshold * 100).toFixed(0)}%). Open positions after entry: ${openPositions + 1}/${MAX_CONCURRENT_POSITIONS}.`,
  };
}

module.exports = {
  MAX_PORTFOLIO_RISK_PCT,
  MAX_CONCURRENT_POSITIONS,
  MAX_DRAWDOWN_PAPER,
  MAX_DRAWDOWN_LIVE,
  MIN_RISK_REWARD_RATIO,
  MAX_POSITION_SIZE_PCT,
  calculatePositionSize,
  checkVeto,
};
