'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Trade Executor — dispatches approved paper trade instructions.
//
// EXECUTION MODES (selected automatically by env vars):
//
//   1. ALPACA PAPER (preferred — set ALPACA_API_KEY + ALPACA_API_SECRET)
//      Posts directly to Alpaca's paper trading API. No extra Docker container.
//      Supports stocks + crypto. Free account at alpaca.markets.
//
//   2. OCTOBOT WEBHOOK (legacy — set OCTOBOT_WEBHOOK_URL)
//      Posts to a locally-running OctoBot Docker container.
//      Kept for backwards compatibility if OctoBot is running.
//
//   3. SIMULATION (fallback — neither above set)
//      Logs the trade intent and writes a simulated fill to Supabase.
//      Useful for dry-run testing when no broker is connected yet.
//
// The mode is selected at the top of executeTrade() — Alpaca takes precedence
// over OctoBot, which takes precedence over simulation.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { createClient } = require('@supabase/supabase-js');

// Alpaca paper trading base URL (never changes — this is always paper)
const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

// ── Supabase client ───────────────────────────────────────────────────────────

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


// ── Asset symbol normaliser ───────────────────────────────────────────────────
// Alpaca crypto uses 'BTC/USD' format; stocks use 'AAPL'.
// TradingView sends 'BTCUSDT' (Binance format) or 'BTCUSD'.
// This normaliser ensures we send the right format to Alpaca.

function normaliseSymbolForAlpaca(asset) {
  if (!asset) return asset;
  // Already in Alpaca crypto format: BTC/USD, ETH/USD etc.
  if (asset.includes('/')) return asset;
  // Binance format BTCUSDT → BTC/USDT (Alpaca accepts BTC/USDT for crypto)
  if (asset.endsWith('USDT')) return asset.slice(0, -4) + '/USDT';
  if (asset.endsWith('USD'))  return asset.slice(0, -3) + '/USD';
  // Stock symbol — return as-is
  return asset;
}


// ── Alpaca paper trade executor ───────────────────────────────────────────────

async function executeViaAlpaca(tradeInstruction) {
  const symbol    = normaliseSymbolForAlpaca(tradeInstruction.asset);
  const direction = tradeInstruction.direction;
  const side      = direction === 'long' ? 'buy' : 'sell';

  // Alpaca requires either notional (USD amount) or qty.
  // We use notional so positionSizeUsd maps directly.
  const orderPayload = {
    symbol,
    notional:   String(tradeInstruction.positionSizeUsd.toFixed(2)),
    side,
    type:       'market',
    time_in_force: 'gtc',
  };

  // For 'close' direction — close all open positions for this symbol instead.
  if (direction === 'close') {
    console.log(`[executor] Closing Alpaca position for ${symbol}`);
    const closeResponse = await alpacaRequest(
      'DELETE',
      `/v2/positions/${encodeURIComponent(symbol)}`,
      null,
    );
    console.log(`[executor] Alpaca close response: ${JSON.stringify(closeResponse)}`);
    return {
      success:       true,
      orderId:       closeResponse.order_id ?? `alpaca-close-${Date.now()}`,
      executedPrice: parseFloat(closeResponse.avg_entry_price ?? 0) || null,
      broker:        'alpaca-paper',
    };
  }

  console.log(`[executor] Sending Alpaca order: ${JSON.stringify(orderPayload)}`);

  const orderResponse = await alpacaRequest('POST', '/v2/orders', orderPayload);

  console.log(
    `[executor] Alpaca order accepted — ` +
    `orderId=${orderResponse.id} status=${orderResponse.status} symbol=${symbol}`,
  );

  return {
    success:       true,
    orderId:       orderResponse.id,
    executedPrice: parseFloat(orderResponse.filled_avg_price ?? 0) || null,
    broker:        'alpaca-paper',
  };
}


// ── Alpaca HTTP helper ────────────────────────────────────────────────────────

function alpacaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'paper-api.alpaca.markets',
      port:     443,
      path,
      method,
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET,
        'Content-Type':        'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(
            `Alpaca API HTTP ${res.statusCode}: ${parsed?.message ?? data}`,
          ));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error('Alpaca API request timed out after 15s'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}


// ── OctoBot webhook executor (legacy) ────────────────────────────────────────

async function executeViaOctoBot(tradeInstruction) {
  const octobotUrl = process.env.OCTOBOT_WEBHOOK_URL;

  const body = JSON.stringify({
    trade_id:          tradeInstruction.tradeId,
    deliberation_id:   tradeInstruction.deliberationId,
    asset:             tradeInstruction.asset,
    direction:         tradeInstruction.direction,
    position_size_pct: tradeInstruction.positionSizePct,
    position_size_usd: tradeInstruction.positionSizeUsd,
    entry_price:       tradeInstruction.entryPrice,
    mode:              'paper',
  });

  await postJson(octobotUrl, body);

  return {
    success:       true,
    orderId:       `octobot-${Date.now()}`,
    executedPrice: null,
    broker:        'octobot',
  };
}


// ── Simulation executor (fallback) ────────────────────────────────────────────
// Used when neither Alpaca nor OctoBot is configured.
// Writes a simulated fill directly to Supabase so the dashboard shows activity.

async function executeViaSimulation(tradeInstruction) {
  const simulatedPrice = tradeInstruction.entryPrice ?? 0;
  const simulatedOrderId = `sim-${Date.now()}`;

  console.log(
    `[executor] SIMULATION MODE — no broker configured. ` +
    `Simulating ${tradeInstruction.direction} ${tradeInstruction.asset} ` +
    `$${tradeInstruction.positionSizeUsd} @ $${simulatedPrice}`,
  );

  return {
    success:       true,
    orderId:       simulatedOrderId,
    executedPrice: simulatedPrice,
    broker:        'simulation',
  };
}


// ── executeTrade ──────────────────────────────────────────────────────────────
/**
 * Dispatches an approved trade to the best available broker.
 * Priority: Alpaca Paper → OctoBot → Simulation
 */
async function executeTrade(tradeInstruction) {
  console.log(
    `[executor] Preparing trade — ` +
    `asset=${tradeInstruction.asset} ` +
    `direction=${tradeInstruction.direction} ` +
    `size=$${tradeInstruction.positionSizeUsd} (${tradeInstruction.positionSizePct}%)`,
  );

  // ── Select execution mode ──────────────────────────────────────────────────
  const hasAlpaca   = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
  const hasOctoBot  = !!process.env.OCTOBOT_WEBHOOK_URL;

  let result;
  if (hasAlpaca) {
    console.log('[executor] Execution mode: ALPACA PAPER');
    result = await executeViaAlpaca(tradeInstruction);
  } else if (hasOctoBot) {
    console.log('[executor] Execution mode: OCTOBOT WEBHOOK');
    result = await executeViaOctoBot(tradeInstruction);
  } else {
    console.log('[executor] Execution mode: SIMULATION (set ALPACA_API_KEY + ALPACA_API_SECRET to use real paper trading)');
    result = await executeViaSimulation(tradeInstruction);
  }

  // ── Update Supabase trades row ─────────────────────────────────────────────
  if (tradeInstruction.deliberationId) {
    try {
      const updates = {
        status:           'open',
        entry_time:       new Date().toISOString(),
        exchange:         result.broker,
        octobot_order_id: result.orderId,
        ...(result.executedPrice != null && { entry_price: result.executedPrice }),
      };

      const { error } = await getSupabase()
        .from('trades')
        .update(updates)
        .eq('deliberation_id', tradeInstruction.deliberationId)
        .eq('status', 'pending_execution');

      if (error) {
        console.error(`[executor] Supabase trades update failed: ${error.message}`);
      } else {
        console.log(
          `[executor] Trade confirmed — ` +
          `broker=${result.broker} orderId=${result.orderId} ` +
          `price=${result.executedPrice ?? 'pending fill'}`,
        );
      }
    } catch (dbErr) {
      console.error(`[executor] Supabase update error: ${dbErr.message}`);
    }
  }

  return result;
}


// ── postJson (OctoBot legacy helper) ─────────────────────────────────────────

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return reject(new Error(`[executor] Invalid OCTOBOT_WEBHOOK_URL: ${urlString}`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(`OctoBot responded HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('OctoBot request timed out after 10s'));
    });
    req.write(body);
    req.end();
  });
}


module.exports = { executeTrade };
