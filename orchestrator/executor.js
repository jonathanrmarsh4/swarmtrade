'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// OctoBot Trade Executor
//
// Sends an approved trade instruction to OctoBot's webhook and reconciles the
// result back into the Supabase trades table.
//
// SAFETY GATE: executeTrade() throws immediately if RAILWAY_ENVIRONMENT is
// anything other than 'paper'. This is enforced at the application layer in
// addition to the OctoBot config-level paper trading lock. Both gates must
// independently prevent live execution during Phase 1–3.
//
// PRECONDITION: The caller MUST confirm the Risk Agent approved the trade
// before invoking executeTrade(). This module does not re-check Risk Agent
// approval — it trusts the Orchestrator pipeline enforced it.
//
// Exports:
//   executeTrade(tradeInstruction, deliberationId) → { success, orderId, executedPrice }
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

// Starting portfolio value used for position size calculation.
// When the paper wallet starts at a different value this can be overridden
// via the INITIAL_PORTFOLIO_VALUE_USD Railway environment variable.
const INITIAL_PORTFOLIO_VALUE_USD = Number(process.env.INITIAL_PORTFOLIO_VALUE_USD || 5_000);

// Maps deliberation direction to OctoBot action verb.
// 'close' is represented as 'sell' because closing a long means selling.
// Closing a short is not yet handled — extend this map when short support is added.
const DIRECTION_TO_ACTION = {
  long:  'buy',
  short: 'sell',
  close: 'sell',
};


// ── Supabase client ───────────────────────────────────────────────────────────
// Lazy singleton — same pattern used across all other modules in the repo.

let supabase = null;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return supabase;
}


// ── fetchPortfolioValue ───────────────────────────────────────────────────────
// Computes current portfolio value from realised P&L on closed trades.
// Unrealised P&L on open positions is excluded — paper-trade prices are not
// tracked in real time.
//
// Falls back to INITIAL_PORTFOLIO_VALUE_USD on query failure rather than
// blocking the trade — a conservative USD size is better than no execution.

async function fetchPortfolioValue() {
  const isLive = process.env.SWARMTRADE_MODE === 'live';

  // Live mode: use real Binance USDT balance
  if (isLive) {
    try {
      const crypto    = require('crypto');
      const apiKey    = process.env.BINANCE_TESTNET_API_KEY;
      const apiSecret = process.env.BINANCE_TESTNET_API_SECRET;
      const timestamp = Date.now();
      const queryStr  = `timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', apiSecret).update(queryStr).digest('hex');
      const res = await fetch(
        `https://api.binance.com/api/v3/account?${queryStr}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': apiKey } }
      );
      if (res.ok) {
        const data = await res.json();
        const usdt = (data.balances ?? []).find(b => b.asset === 'USDT');
        if (usdt) {
          const balance = parseFloat(usdt.free) + parseFloat(usdt.locked);
          console.log(`[executor] Live Binance USDT balance: $${balance.toFixed(2)}`);
          return Math.max(balance, 0.01);
        }
      }
    } catch (err) {
      console.warn('[executor] Binance balance fetch failed, falling back to P&L calc:', err.message);
    }
  }

  // Paper mode (or live fallback): starting balance + closed P&L
  const { data: trades, error } = await getSupabase()
    .from('trades')
    .select('pnl_usd, exit_time');

  if (error) {
    throw new Error(`[executor] Failed to fetch trades for portfolio valuation: ${error.message}`);
  }

  const closedPnl = (trades ?? [])
    .filter(t => t.exit_time != null)
    .reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);

  return Math.max(INITIAL_PORTFOLIO_VALUE_USD + closedPnl, 0.01);
}


// ── updateTrade ───────────────────────────────────────────────────────────────
// Updates the trades row that is currently status='pending_execution' for the
// given deliberation_id. Uses deliberation_id + status as the compound filter
// so a retry that created a second row wouldn't be incorrectly overwritten.

async function updateTrade(deliberationId, updates) {
  const { error } = await getSupabase()
    .from('trades')
    .update(updates)
    .eq('deliberation_id', deliberationId)
    .eq('status', 'pending_execution');

  if (error) {
    throw new Error(
      `[executor] Failed to update trade for deliberation ${deliberationId}: ${error.message}`,
    );
  }
}


// ── executeTrade ──────────────────────────────────────────────────────────────
/**
 * Sends an approved trade instruction to OctoBot and reconciles the result
 * back into Supabase.
 *
 * This function must only be called after the Risk Agent has approved the
 * trade. The Orchestrator enforces this; this module does not re-validate.
 *
 * @param {object} tradeInstruction
 * @param {string} tradeInstruction.asset           — e.g. 'BTC/USDT'
 * @param {string} tradeInstruction.direction       — 'long' | 'short' | 'close'
 * @param {number} tradeInstruction.positionSizePct — Risk Agent approved size as % of portfolio
 * @param {string} tradeInstruction.entryType       — 'market' | 'limit'
 * @param {number} [tradeInstruction.stopLoss]      — stop loss price in USD (optional)
 *
 * @param {string} deliberationId — UUID of the deliberations row; used to
 *                                  locate and update the corresponding trades row
 *
 * @returns {Promise<{ success: boolean, orderId: string|null, executedPrice: number|null }>}
 *
 * @throws {Error} if RAILWAY_ENVIRONMENT !== 'paper'   — hard safety gate, never caught
 * @throws {Error} if OCTOBOT_WEBHOOK_URL is not set    — configuration error, never caught
 * @throws {Error} if tradeInstruction has missing fields
 */
async function executeTrade(tradeInstruction, deliberationId) {

  // ── Hard safety gate ────────────────────────────────────────────────────────
  // This check is unconditional and must never be moved, wrapped, or guarded.
  // It is the last application-layer line of defence before capital is at risk.
  if (process.env.SWARMTRADE_MODE !== 'paper') {
    throw new Error(
      `[executor] SAFETY GATE VIOLATED: RAILWAY_ENVIRONMENT is ` +
      `'${process.env.SWARMTRADE_MODE ?? 'undefined'}'. ` +
      `executeTrade() may only be called when RAILWAY_ENVIRONMENT=paper. ` +
      `Refusing to execute. No trade has been placed.`,
    );
  }

  const webhookUrl = process.env.OCTOBOT_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error(
      '[executor] OCTOBOT_WEBHOOK_URL is not set. ' +
      'Set this Railway environment variable to the OctoBot webhook endpoint.',
    );
  }


  // ── Validate inputs ─────────────────────────────────────────────────────────

  const { asset, direction, positionSizePct, entryType, stopLoss } = tradeInstruction ?? {};

  const inputErrors = [];
  if (!asset || typeof asset !== 'string')                          inputErrors.push('asset must be a non-empty string');
  if (!['long', 'short', 'close'].includes(direction))             inputErrors.push("direction must be 'long', 'short', or 'close'");
  if (typeof positionSizePct !== 'number' || positionSizePct <= 0) inputErrors.push('positionSizePct must be a positive number');
  if (!['market', 'limit'].includes(entryType))                    inputErrors.push("entryType must be 'market' or 'limit'");
  if (!deliberationId || typeof deliberationId !== 'string')       inputErrors.push('deliberationId must be a non-empty string');

  if (inputErrors.length > 0) {
    throw new Error(`[executor] Invalid inputs — ${inputErrors.join('; ')}`);
  }

  const action = DIRECTION_TO_ACTION[direction];


  // ── Calculate USD position size ─────────────────────────────────────────────
  // Fetch realised P&L from Supabase to determine current portfolio value.
  // On fetch failure, fall back to the initial value — a conservative choice
  // that slightly under-sizes the position but does not block execution.

  let portfolioValue;
  try {
    portfolioValue = await fetchPortfolioValue();
  } catch (err) {
    console.error(
      `[executor] Portfolio valuation failed — falling back to initial value $${INITIAL_PORTFOLIO_VALUE_USD}. ` +
      `Reason: ${err.message}`,
    );
    portfolioValue = INITIAL_PORTFOLIO_VALUE_USD;
  }

  const usdAmount = parseFloat(((positionSizePct / 100) * portfolioValue).toFixed(2));

  console.log(
    `[executor] Preparing OctoBot instruction — ` +
    `asset=${asset} action=${action} size=$${usdAmount} ` +
    `(${positionSizePct}% of $${portfolioValue.toFixed(2)}) ` +
    `entryType=${entryType} stopLoss=${stopLoss ?? 'none'} ` +
    `deliberationId=${deliberationId}`,
  );


  // ── Format OctoBot webhook payload ──────────────────────────────────────────

  const octobotPayload = {
    action:     action,
    symbol:     asset,
    amount:     usdAmount,
    order_type: entryType,
    stop_loss:  stopLoss ?? null,
  };


  // ── POST to OctoBot webhook ──────────────────────────────────────────────────
  // Uses the native Node.js fetch API (Node 18+).
  // Non-2xx responses are treated as failures — OctoBot did not accept the order.

  let octobotResponse;

  try {
    const httpResponse = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(octobotPayload),
    });

    if (!httpResponse.ok) {
      const responseText = await httpResponse.text().catch(() => '<unreadable body>');
      throw new Error(`OctoBot returned HTTP ${httpResponse.status}: ${responseText}`);
    }

    // OctoBot may return an empty body or a JSON object — handle both safely.
    octobotResponse = await httpResponse.json().catch(() => ({}));

    console.log(
      `[executor] OctoBot accepted instruction — ` +
      `orderId=${octobotResponse.order_id ?? 'not provided'} ` +
      `executedPrice=${octobotResponse.price ?? octobotResponse.executed_price ?? 'pending fill'}`,
    );

  } catch (err) {

    // ── Execution failure path ────────────────────────────────────────────────
    // OctoBot did not accept the order (network failure, bad response, timeout).
    // Update trades row to 'execution_failed' so the dashboard surfaces the gap
    // and the nightly Reflection Agent can investigate.

    console.error(`[executor] OctoBot webhook call failed: ${err.message}`);

    try {
      await updateTrade(deliberationId, { status: 'execution_failed' });
      console.log(
        `[executor] Trades row updated to status='execution_failed' — deliberationId=${deliberationId}`,
      );
    } catch (dbErr) {
      // Log but do not throw — the original OctoBot failure is the primary event.
      console.error(
        `[executor] Supabase update to 'execution_failed' also failed: ${dbErr.message}`,
      );
    }

    return { success: false, orderId: null, executedPrice: null };
  }


  // ── Success path — reconcile Supabase trades row ─────────────────────────────
  // Entry price comes from OctoBot's response when available.
  // For market orders it may arrive immediately; for limit orders it arrives
  // on fill. We record what OctoBot reports and leave updating on fill to a
  // separate polling handler.

  const orderId       = octobotResponse.order_id ?? `octobot-${Date.now()}`;
  const executedPrice = octobotResponse.price ?? octobotResponse.executed_price ?? null;
  const entryTime     = new Date().toISOString();

  const successUpdates = {
    status:           'open',
    entry_time:       entryTime,
    exchange:         octobotResponse.exchange ?? 'octobot-paper',
    octobot_order_id: orderId,
    ...(executedPrice != null && { entry_price: executedPrice }),
  };

  try {
    await updateTrade(deliberationId, successUpdates);
    console.log(
      `[executor] Trades row updated to status='open' — ` +
      `entry_time=${entryTime} ` +
      `entry_price=${executedPrice ?? 'pending fill'} ` +
      `orderId=${orderId} ` +
      `deliberationId=${deliberationId}`,
    );
  } catch (dbErr) {
    // OctoBot has the order — log the Supabase failure but do not fail the return.
    // The trade is live (paper) even if we couldn't persist the confirmation.
    console.error(
      `[executor] Supabase update after successful OctoBot call failed — ` +
      `orderId=${orderId} error=${dbErr.message}`,
    );
  }

  return {
    success:        true,
    orderId,
    executedPrice:  executedPrice ?? null,
  };
}


module.exports = { executeTrade };
