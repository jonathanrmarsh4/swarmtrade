'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Trade Executor — dispatches approved paper trade instructions.
//
// EXECUTION MODES (selected automatically by env vars):
//
//   1. BINANCE TESTNET (preferred — set BINANCE_TESTNET_API_KEY +
//      BINANCE_TESTNET_API_SECRET + BINANCE_TESTNET=true)
//      Places real orders on testnet.binance.vision — fake money, real API.
//      Supports spot (buy/sell) and futures (long/short). Zero financial risk.
//
//   2. OCTOBOT WEBHOOK (legacy — set OCTOBOT_WEBHOOK_URL)
//      Posts to a locally-running OctoBot Docker container.
//
//   3. SIMULATION (fallback — neither above set)
//      Fetches real Binance price, simulates fill, records in Supabase.
//      Zero external dependencies — useful for pipeline testing.
//
// SAFETY GATES (all must pass before any order is placed):
//   - BINANCE_TESTNET env var must be exactly 'true'
//   - RAILWAY_ENVIRONMENT must be 'paper'
//   - Asset must be on the approved whitelist
//   - positionSizeUsd must not exceed MAX_POSITION_USD
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Safety constants ──────────────────────────────────────────────────────────
// Hard cap on position size regardless of what the Quant Agent recommends.
// Override via PAPER_MAX_POSITION_USD Railway env var if needed.
const MAX_POSITION_USD = Number(process.env.PAPER_MAX_POSITION_USD || 50);

// Only these pairs may be traded during paper phase.
const APPROVED_PAIRS = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'ADAUSDT', 'XRPUSDT', 'DOTUSDT', 'AVAXUSDT',
]);

// Binance Testnet base URLs
const TESTNET_SPOT_URL    = 'https://testnet.binance.vision';
const TESTNET_FUTURES_URL = 'https://testnet.binancefuture.com';

// Binance public price endpoint (no auth required — used for simulation fallback)
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';

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


// ── Symbol normaliser ─────────────────────────────────────────────────────────
// Binance uses BTCUSDT (no slash). TradingView may send BTC/USDT or BTCUSDT.

function normaliseSymbol(asset) {
  if (!asset) return asset;
  return asset.replace('/', '');
}


// ── Safety gate ───────────────────────────────────────────────────────────────
// Throws if any safety condition is violated. Called before every order.

function assertSafe(tradeInstruction) {
  const errors = [];

  if (process.env.BINANCE_TESTNET !== 'true') {
    errors.push('BINANCE_TESTNET env var must be set to "true"');
  }

  if (process.env.SWARMTRADE_MODE !== 'paper') {
    errors.push(`RAILWAY_ENVIRONMENT must be "paper" (currently "${process.env.SWARMTRADE_MODE}")`);
  }

  const symbol = normaliseSymbol(tradeInstruction.asset);
  if (!APPROVED_PAIRS.has(symbol)) {
    errors.push(`Asset ${symbol} is not on the approved whitelist: ${[...APPROVED_PAIRS].join(', ')}`);
  }

  if ((tradeInstruction.positionSizeUsd ?? 0) > MAX_POSITION_USD) {
    errors.push(`Position size $${tradeInstruction.positionSizeUsd} exceeds MAX_POSITION_USD ($${MAX_POSITION_USD})`);
  }

  if (errors.length > 0) {
    throw new Error(`[executor] SAFETY GATE BLOCKED:\n  - ${errors.join('\n  - ')}`);
  }
}


// ── Binance HMAC signature ────────────────────────────────────────────────────
// Binance requires all signed requests to include a timestamp + HMAC-SHA256 signature.

function signQuery(queryString, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(queryString)
    .digest('hex');
}


// ── Binance Testnet HTTP helper ───────────────────────────────────────────────

function binanceRequest(baseUrl, method, path, params, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const timestamp   = Date.now();
    const allParams   = { ...params, timestamp };
    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const signature   = signQuery(queryString, apiSecret);
    const fullQuery   = `${queryString}&signature=${signature}`;

    const fullPath = method === 'GET'
      ? `${path}?${fullQuery}`
      : path;

    const parsed  = new URL(baseUrl);
    const options = {
      hostname: parsed.hostname,
      port:     443,
      path:     fullPath,
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
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
            `Binance Testnet HTTP ${res.statusCode}: ${parsed?.msg ?? data}`,
          ));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error('Binance Testnet request timed out'));
    });

    // POST params go in the body
    if (method === 'POST') {
      req.write(fullQuery);
    }

    req.end();
  });
}


// ── Binance Testnet SPOT executor ─────────────────────────────────────────────

async function executeSpotOrder(symbol, side, usdAmount, apiKey, apiSecret) {
  // Spot market orders use 'quoteOrderQty' (USD amount) for market buys
  // and 'quantity' (coin amount) for market sells. For simplicity we always
  // use quoteOrderQty — Binance testnet accepts this for both sides.
  const params = {
    symbol,
    side:          side.toUpperCase(),   // BUY or SELL
    type:          'MARKET',
    quoteOrderQty: usdAmount.toFixed(2),
  };

  console.log(`[executor] Testnet SPOT order: ${side} ${symbol} $${usdAmount}`);

  const response = await binanceRequest(
    TESTNET_SPOT_URL, 'POST', '/api/v3/order', params, apiKey, apiSecret,
  );

  return {
    orderId:       String(response.orderId),
    executedPrice: parseFloat(response.fills?.[0]?.price ?? 0) || null,
    status:        response.status,
  };
}


// ── Binance Testnet FUTURES executor ──────────────────────────────────────────

async function executeFuturesOrder(symbol, side, usdAmount, apiKey, apiSecret) {
  // Futures require quantity in base asset (not USD). We first get the mark price
  // to calculate quantity, then place the order.
  const markPriceRes = await binanceRequest(
    TESTNET_FUTURES_URL, 'GET', '/fapi/v1/premiumIndex',
    { symbol }, apiKey, apiSecret,
  );

  const markPrice = parseFloat(markPriceRes.markPrice);
  if (!markPrice) throw new Error(`Could not get mark price for ${symbol}`);

  const quantity = (usdAmount / markPrice).toFixed(3);

  const params = {
    symbol,
    side:     side.toUpperCase(),
    type:     'MARKET',
    quantity,
  };

  console.log(`[executor] Testnet FUTURES order: ${side} ${symbol} qty=${quantity} (~$${usdAmount})`);

  const response = await binanceRequest(
    TESTNET_FUTURES_URL, 'POST', '/fapi/v1/order', params, apiKey, apiSecret,
  );

  return {
    orderId:       String(response.orderId),
    executedPrice: parseFloat(response.avgPrice ?? 0) || null,
    status:        response.status,
  };
}


// ── Binance Testnet executor (main) ───────────────────────────────────────────

async function executeViaBinanceTestnet(tradeInstruction) {
  const apiKey    = process.env.BINANCE_TESTNET_API_KEY;
  const apiSecret = process.env.BINANCE_TESTNET_API_SECRET;
  const symbol    = normaliseSymbol(tradeInstruction.asset);
  const direction = tradeInstruction.direction;
  const usdAmount = Math.min(tradeInstruction.positionSizeUsd, MAX_POSITION_USD);

  // Map direction to Binance side
  const side = direction === 'long'  ? 'BUY'
             : direction === 'short' ? 'SELL'
             : direction === 'close' ? 'SELL'
             : null;

  if (!side) throw new Error(`Unknown direction: ${direction}`);

  // Use futures for short/long, spot for simple buy/sell
  const useFutures = direction === 'short' || direction === 'long';

  let orderResult;
  if (useFutures) {
    orderResult = await executeFuturesOrder(symbol, side, usdAmount, apiKey, apiSecret);
  } else {
    orderResult = await executeSpotOrder(symbol, side, usdAmount, apiKey, apiSecret);
  }

  console.log(
    `[executor] Binance Testnet order filled — ` +
    `orderId=${orderResult.orderId} ` +
    `price=${orderResult.executedPrice ?? 'pending'} ` +
    `status=${orderResult.status}`,
  );

  return {
    success:       true,
    orderId:       orderResult.orderId,
    executedPrice: orderResult.executedPrice,
    broker:        'binance-testnet',
  };
}


// ── OctoBot webhook executor (legacy) ────────────────────────────────────────

async function executeViaOctoBot(tradeInstruction) {
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

  await postJson(process.env.OCTOBOT_WEBHOOK_URL, body);

  return {
    success:       true,
    orderId:       `octobot-${Date.now()}`,
    executedPrice: null,
    broker:        'octobot',
  };
}


// ── Simulation executor (fallback) ────────────────────────────────────────────
// Fetches real Binance price for a realistic simulated fill.
// No orders are placed anywhere — purely internal.

async function executeViaSimulation(tradeInstruction) {
  const symbol = normaliseSymbol(tradeInstruction.asset);
  let price    = tradeInstruction.entryPrice ?? null;

  try {
    const res  = await fetch(`${BINANCE_TICKER_URL}?symbol=${symbol}`, {
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json();
    price      = parseFloat(data.price) || price;
  } catch {
    // Use signal price as fallback — non-fatal
  }

  console.log(
    `[executor] SIMULATION — ${tradeInstruction.direction} ${symbol} ` +
    `$${tradeInstruction.positionSizeUsd} @ $${price ?? 'unknown'} ` +
    `(no real order placed — add BINANCE_TESTNET_API_KEY to Railway for testnet execution)`,
  );

  return {
    success:       true,
    orderId:       `sim-${Date.now()}`,
    executedPrice: price,
    broker:        'simulation',
  };
}


// ── executeTrade (public) ─────────────────────────────────────────────────────
/**
 * Dispatches an approved trade instruction.
 * Priority: Binance Testnet → OctoBot → Simulation
 *
 * Safety gates are checked before any real order is placed.
 */
async function executeTrade(tradeInstruction) {
  console.log(
    `[executor] Preparing trade — ` +
    `asset=${tradeInstruction.asset} ` +
    `direction=${tradeInstruction.direction} ` +
    `size=$${tradeInstruction.positionSizeUsd} (${tradeInstruction.positionSizePct}%)`,
  );

  const hasTestnet = !!(
    process.env.BINANCE_TESTNET === 'true' &&
    process.env.BINANCE_TESTNET_API_KEY &&
    process.env.BINANCE_TESTNET_API_SECRET
  );
  const hasOctoBot = !!process.env.OCTOBOT_WEBHOOK_URL;

  let result;

  if (hasTestnet) {
    console.log('[executor] Execution mode: BINANCE TESTNET');
    assertSafe(tradeInstruction); // throws if any safety gate fails
    result = await executeViaBinanceTestnet(tradeInstruction);
  } else if (hasOctoBot) {
    console.log('[executor] Execution mode: OCTOBOT WEBHOOK');
    result = await executeViaOctoBot(tradeInstruction);
  } else {
    console.log('[executor] Execution mode: SIMULATION');
    result = await executeViaSimulation(tradeInstruction);
  }

  // ── Persist to Supabase ────────────────────────────────────────────────────
  if (tradeInstruction.deliberationId) {
    try {
      const { error } = await getSupabase()
        .from('trades')
        .update({
          status:           'open',
          entry_time:       new Date().toISOString(),
          exchange:         result.broker,
          octobot_order_id: result.orderId,
          ...(result.executedPrice != null && { entry_price: result.executedPrice }),
        })
        .eq('deliberation_id', tradeInstruction.deliberationId)
        .eq('status', 'pending_execution');

      if (error) {
        console.error(`[executor] Supabase update failed: ${error.message}`);
      } else {
        console.log(
          `[executor] Trade persisted — broker=${result.broker} ` +
          `orderId=${result.orderId} price=${result.executedPrice ?? 'pending'}`,
        );
      }
    } catch (dbErr) {
      console.error(`[executor] Supabase error: ${dbErr.message}`);
    }
  }

  return result;
}


// ── postJson (OctoBot legacy helper) ─────────────────────────────────────────

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(urlString); }
    catch { return reject(new Error(`Invalid OCTOBOT_WEBHOOK_URL: ${urlString}`)); }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(`OctoBot HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('OctoBot timeout')));
    req.write(body);
    req.end();
  });
}


module.exports = { executeTrade };
