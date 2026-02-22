'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Risk Management Agent — deterministic rules engine.
//
// NO LLM. NO ANTHROPIC IMPORTS. Zero hallucination tolerance.
// Any Anthropic reference in this file is a CRITICAL BUG.
//
// Unconditional veto power. The Orchestrator must pass every proposed trade
// through evaluate(). No code path in the system may bypass this module.
//
// Inputs:
//   portfolioState — current portfolio snapshot (sourced from Supabase)
//   proposedTrade  — the trade the Orchestrator wants to execute
//
// Output:
//   { approved: boolean, positionSizePct: number, reason: string }
// ─────────────────────────────────────────────────────────────────────────────

const { checkVeto, calculatePositionSize } = require('./rules.js');

// ── Input validation ──────────────────────────────────────────────────────────
// Ensures required fields are present and numeric before any rule runs.
// Throws on invalid input — malformed data is a caller bug, not a veto.
function validateInputs(portfolioState, proposedTrade) {
  const portfolioErrors = [];
  const tradeErrors     = [];

  if (!portfolioState || typeof portfolioState !== 'object') {
    throw new Error('Risk Agent: portfolioState must be an object');
  }
  if (!proposedTrade || typeof proposedTrade !== 'object') {
    throw new Error('Risk Agent: proposedTrade must be an object');
  }

  // portfolioState required fields
  if (typeof portfolioState.openPositions !== 'number' || portfolioState.openPositions < 0) {
    portfolioErrors.push('openPositions must be a non-negative number');
  }
  if (typeof portfolioState.currentDrawdownPct !== 'number' || portfolioState.currentDrawdownPct < 0) {
    portfolioErrors.push('currentDrawdownPct must be a non-negative number');
  }
  if (typeof portfolioState.portfolioValue !== 'number' || portfolioState.portfolioValue <= 0) {
    portfolioErrors.push('portfolioValue must be a positive number');
  }
  if (!['paper', 'live'].includes(portfolioState.mode)) {
    portfolioErrors.push("mode must be 'paper' or 'live'");
  }

  // proposedTrade required fields
  if (typeof proposedTrade.asset !== 'string' || !proposedTrade.asset.trim()) {
    tradeErrors.push("asset must be a non-empty string (e.g. 'BTC/USDT')");
  }
  if (!['long', 'short', 'close'].includes(proposedTrade.direction)) {
    tradeErrors.push("direction must be 'long', 'short', or 'close'");
  }
  if (typeof proposedTrade.entryPrice !== 'number' || proposedTrade.entryPrice <= 0) {
    tradeErrors.push('entryPrice must be a positive number');
  }
  if (typeof proposedTrade.stopLoss !== 'number' || proposedTrade.stopLoss <= 0) {
    tradeErrors.push('stopLoss must be a positive number');
  }
  if (typeof proposedTrade.atr !== 'number' || proposedTrade.atr <= 0) {
    tradeErrors.push('atr must be a positive number');
  }

  // takeProfit is optional; validate type only when present
  if (proposedTrade.takeProfit != null && (typeof proposedTrade.takeProfit !== 'number' || proposedTrade.takeProfit <= 0)) {
    tradeErrors.push('takeProfit must be a positive number if provided');
  }

  const allErrors = [
    ...portfolioErrors.map(e => `portfolioState.${e}`),
    ...tradeErrors.map(e => `proposedTrade.${e}`),
  ];

  if (allErrors.length > 0) {
    throw new Error(`Risk Agent: invalid inputs — ${allErrors.join('; ')}`);
  }
}

// ── evaluate ──────────────────────────────────────────────────────────────────
// Main entry point. Validates inputs, calls checkVeto (which runs all rules),
// and returns the final verdict.
//
// Position sizing is calculated inside checkVeto when all rules pass; this
// function surfaces that result directly so callers receive a single object.
//
// @param {object} portfolioState
// @param {number} portfolioState.openPositions     — count of currently open positions
// @param {number} portfolioState.currentDrawdownPct — current drawdown as decimal (0.04 = 4%)
// @param {number} portfolioState.portfolioValue     — total portfolio value in USD
// @param {string} portfolioState.mode              — 'paper' | 'live'
//
// @param {object} proposedTrade
// @param {string} proposedTrade.asset              — e.g. 'BTC/USDT'
// @param {string} proposedTrade.direction          — 'long' | 'short' | 'close'
// @param {number} proposedTrade.entryPrice         — proposed entry price in USD
// @param {number} proposedTrade.stopLoss           — stop loss price in USD
// @param {number} proposedTrade.atr                — current ATR in price units
// @param {number} [proposedTrade.takeProfit]       — take profit price (enables R:R check)
//
// @returns {{ approved: boolean, positionSizePct: number, reason: string }}
function evaluate(portfolioState, proposedTrade) {
  validateInputs(portfolioState, proposedTrade);

  console.log(
    `[risk] Evaluating trade — asset=${proposedTrade.asset} direction=${proposedTrade.direction} ` +
    `entryPrice=${proposedTrade.entryPrice} stopLoss=${proposedTrade.stopLoss} atr=${proposedTrade.atr}`
  );
  console.log(
    `[risk] Portfolio state — value=$${portfolioState.portfolioValue} drawdown=${(portfolioState.currentDrawdownPct * 100).toFixed(2)}% ` +
    `openPositions=${portfolioState.openPositions} mode=${portfolioState.mode}`
  );

  const verdict = checkVeto(portfolioState, proposedTrade);

  if (!verdict.approved) {
    console.warn(`[risk] VETO — ${verdict.reason}`);
  } else {
    console.log(`[risk] APPROVED — positionSizePct=${verdict.positionSizePct}%`);
  }

  return verdict;
}

module.exports = { evaluate };
