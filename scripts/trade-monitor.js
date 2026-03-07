'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Trade Monitor — polls the trades table every 60 seconds.
//
// Responsibilities:
//   - Detect open positions that have hit their stop-loss or take-profit level
//   - POST a close instruction to OctoBot when a position should close
//   - Update the trades row (exit_price, exit_time, pnl_usd, pnl_pct, status)
//   - Update the linked deliberations row (outcome, pnl_pct)
//   - Log all closures to console with P&L summary
//
// Price data is fetched from the Binance public ticker API — no auth required.
// Asset format conversion: 'BTC/USDT' → 'BTCUSDT' (Binance symbol format).
//
// Called once at startup via start(). Runs an immediate check then schedules
// a cron every minute. Does not self-start.
// ─────────────────────────────────────────────────────────────────────────────

const cron             = require('node-cron');
const https            = require('https');
const http             = require('http');
const { URL }          = require('url');
const { createClient } = require('@supabase/supabase-js');

// ── Exit level constants ──────────────────────────────────────────────────────
// These drive stop-loss and take-profit calculations from entry price.
// Modify here only — never inline these values in trade logic.

const TAKE_PROFIT_PCT = 0.04;   // 4% gain triggers take-profit close
const STOP_LOSS_PCT   = 0.02;   // 2% loss triggers stop-loss close

// ── External API ──────────────────────────────────────────────────────────────

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


// ── fetchCurrentPrice ─────────────────────────────────────────────────────────
// Fetches the latest price for an asset from Binance's public ticker endpoint.
// No authentication required.
//
// @param {string} asset  — e.g. 'BTC/USDT'
// @returns {Promise<number>}  current price as a float

async function fetchCurrentPrice(asset) {
  // Binance symbols use no separator: 'BTC/USDT' → 'BTCUSDT'
  const symbol = asset.replace('/', '');
  const url    = `${BINANCE_TICKER_URL}?symbol=${symbol}`;

  const raw    = await httpGet(url);
  const parsed = JSON.parse(raw);

  if (!parsed.price) {
    throw new Error(`No price field in Binance response for ${symbol}: ${raw}`);
  }

  return parseFloat(parsed.price);
}


// ── notifyOctoBotClose ────────────────────────────────────────────────────────
// POSTs a close instruction to the OctoBot webhook.
// Failure here is non-fatal — the Supabase update still proceeds so the trade
// record stays accurate even if OctoBot is temporarily unreachable.
//
// @param {object} trade      — trades row
// @param {string} asset      — e.g. 'BTC/USDT'
// @param {string} direction  — 'long' | 'short'
// @param {number} exitPrice  — price at which the position is being closed

async function notifyOctoBotClose(trade, asset, direction, exitPrice) {
  const octobotUrl = process.env.OCTOBOT_WEBHOOK_URL;

  if (!octobotUrl) {
    console.warn('[trade-monitor] OCTOBOT_WEBHOOK_URL not set — skipping OctoBot close notification');
    return;
  }

  const body = JSON.stringify({
    trade_id:         trade.id,
    deliberation_id:  trade.deliberation_id,
    asset,
    direction:        'close',
    original_direction: direction,
    exit_price:       exitPrice,
    mode:             trade.mode ?? 'paper',
  });

  await postJson(octobotUrl, body);
}


// ── closeTrade ────────────────────────────────────────────────────────────────
// Closes a single trade: notifies OctoBot, updates the trades row, and updates
// the linked deliberations row with outcome and P&L.
//
// pnl_pct is stored as a percentage value (e.g. 2.5 for +2.5%).
//
// @param {object} trade      — trades row from Supabase
// @param {string} asset      — e.g. 'BTC/USDT'
// @param {string} direction  — 'long' | 'short'
// @param {number} exitPrice  — current market price used as exit
// @param {string} reason     — 'take_profit' | 'stop_loss'

async function closeTrade(trade, asset, direction, exitPrice, reason) {
  const now        = new Date().toISOString();
  const entryPrice = parseFloat(trade.entry_price);

  // Direction-aware P&L
  const rawPnlDecimal = direction === 'short'
    ? (entryPrice - exitPrice) / entryPrice
    : (exitPrice - entryPrice) / entryPrice;

  const pnlPct = parseFloat((rawPnlDecimal * 100).toFixed(4));   // e.g. 2.5 for +2.5%
  const pnlUsd = parseFloat((trade.position_size_usd * rawPnlDecimal).toFixed(2));

  // ── Notify OctoBot (best effort — log but do not abort on failure) ──────────
  try {
    await notifyOctoBotClose(trade, asset, direction, exitPrice);
  } catch (err) {
    console.error(
      `[trade-monitor] OctoBot close notification failed for trade ${trade.id}: ${err.message}`,
    );
  }

  // ── Update trades row ───────────────────────────────────────────────────────
  const { error: tradeUpdateError } = await getSupabase()
    .from('trades')
    .update({
      exit_price: exitPrice,
      exit_time:  now,
      pnl_usd:    pnlUsd,
      pnl_pct:    pnlPct,
      status:     'closed',
    })
    .eq('id', trade.id);

  if (tradeUpdateError) {
    console.error(
      `[trade-monitor] Failed to update trades row ${trade.id}: ${tradeUpdateError.message}`,
    );
    return;
  }

  // ── Update deliberations row ────────────────────────────────────────────────
  const outcome = rawPnlDecimal >= 0 ? 'win' : 'loss';

  const { error: deliberationUpdateError } = await getSupabase()
    .from('deliberations')
    .update({ outcome, pnl_pct: pnlPct })
    .eq('id', trade.deliberation_id);

  if (deliberationUpdateError) {
    console.error(
      `[trade-monitor] Failed to update deliberations row ${trade.deliberation_id}: ${deliberationUpdateError.message}`,
    );
    // Trade row already updated — log and continue rather than re-throwing.
  }

  // ── Console summary ─────────────────────────────────────────────────────────
  const sign = pnlUsd >= 0 ? '+' : '';
  console.log(
    `[trade-monitor] CLOSED  trade=${trade.id}  asset=${asset}  direction=${direction}  ` +
    `entry=$${entryPrice}  exit=$${exitPrice}  ` +
    `P&L=${sign}$${pnlUsd} (${sign}${pnlPct}%)  reason=${reason}`,
  );
}


// ── monitorOpenTrades ─────────────────────────────────────────────────────────
// Main monitoring function. Queries all open trades, fetches live prices, and
// closes any position that has hit its stop-loss or take-profit level.
//
// Queries trades where status = 'open' AND exit_time IS NULL.
// Joins to deliberations → signals to resolve the asset and original direction.

async function monitorOpenTrades() {
  // Join two levels deep to get asset + direction without adding columns to trades.
  // trades.deliberation_id → deliberations.signal_id → signals.asset / .direction
  const { data: openTrades, error } = await getSupabase()
    .from('trades')
    .select(`
      id,
      deliberation_id,
      entry_price,
      position_size_usd,
      entry_time,
      mode,
      deliberations (
        signal_id,
        signals (
          asset,
          direction
        )
      )
    `)
    .eq('status', 'open')
    .is('exit_time', null);

  if (error) {
    console.error('[trade-monitor] Failed to fetch open trades:', error.message);
    return;
  }

  const count = openTrades?.length ?? 0;

  if (count === 0) {
    console.log('[trade-monitor] No open positions.');
    return;
  }

  console.log(`[trade-monitor] Checking ${count} open position(s)...`);

  for (const trade of openTrades) {
    const asset     = trade.deliberations?.signals?.asset;
    const direction = trade.deliberations?.signals?.direction ?? 'long';

    if (!asset) {
      console.warn(
        `[trade-monitor] Cannot resolve asset for trade ${trade.id} — ` +
        `deliberation_id=${trade.deliberation_id}. Skipping.`,
      );
      continue;
    }

    // ── Fetch current price ───────────────────────────────────────────────────
    let currentPrice;
    try {
      currentPrice = await fetchCurrentPrice(asset);
    } catch (err) {
      console.error(
        `[trade-monitor] Price fetch failed for ${asset} (trade ${trade.id}): ${err.message}`,
      );
      continue;
    }

    const entryPrice  = parseFloat(trade.entry_price);

    // ── Calculate exit levels from entry price ────────────────────────────────
    // Short positions invert the direction: profit when price falls, stop when it rises.
    const takeProfit = direction === 'short'
      ? entryPrice * (1 - TAKE_PROFIT_PCT)
      : entryPrice * (1 + TAKE_PROFIT_PCT);

    const stopLoss = direction === 'short'
      ? entryPrice * (1 + STOP_LOSS_PCT)
      : entryPrice * (1 - STOP_LOSS_PCT);

    // ── Check exit conditions ─────────────────────────────────────────────────
    let closeReason = null;

    if (direction === 'short') {
      if (currentPrice <= takeProfit)  closeReason = 'take_profit';
      else if (currentPrice >= stopLoss) closeReason = 'stop_loss';
    } else {
      // long (default when direction is anything other than 'short')
      if (currentPrice >= takeProfit)  closeReason = 'take_profit';
      else if (currentPrice <= stopLoss) closeReason = 'stop_loss';
    }

    if (closeReason) {
      try {
        await closeTrade(trade, asset, direction, currentPrice, closeReason);
      } catch (err) {
        console.error(
          `[trade-monitor] Failed to close trade ${trade.id}: ${err.message}`,
        );
      }
    } else {
      // Position is still open — log current state for operational visibility.
      const ageMs          = Date.now() - new Date(trade.entry_time).getTime();
      const ageMin         = Math.round(ageMs / 60_000);
      const unrealisedPct  = direction === 'short'
        ? (entryPrice - currentPrice) / entryPrice * 100
        : (currentPrice - entryPrice) / entryPrice * 100;
      const sign = unrealisedPct >= 0 ? '+' : '';

      console.log(
        `[trade-monitor] HOLD    trade=${trade.id}  asset=${asset}  direction=${direction}  ` +
        `entry=$${entryPrice}  current=$${currentPrice}  ` +
        `SL=$${stopLoss.toFixed(2)}  TP=$${takeProfit.toFixed(2)}  ` +
        `unrealised=${sign}${unrealisedPct.toFixed(2)}%  age=${ageMin}min`,
      );
    }
  }
}


// ── httpGet ───────────────────────────────────────────────────────────────────
// Minimal GET using Node built-ins — no axios or node-fetch dependency.
// Resolves with the response body string on 2xx; rejects otherwise.

function httpGet(urlString) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return reject(new Error(`[trade-monitor] Invalid URL: ${urlString}`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.get(urlString, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('[trade-monitor] Price fetch timed out after 10s'));
    });
  });
}


// ── postJson ──────────────────────────────────────────────────────────────────
// Minimal POST using Node built-ins.
// Resolves when the response status is 2xx; rejects otherwise.

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return reject(new Error(`[trade-monitor] Invalid OCTOBOT_WEBHOOK_URL: ${urlString}`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
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
          reject(new Error(
            `[trade-monitor] OctoBot responded with HTTP ${res.statusCode}: ${data}`,
          ));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('[trade-monitor] OctoBot request timed out after 10s'));
    });

    req.write(body);
    req.end();
  });
}


// ── start ─────────────────────────────────────────────────────────────────────
// Called once by the root index.js. Runs an immediate check on startup, then
// schedules a cron job every 60 seconds.

function start() {
  monitorOpenTrades().catch(err => {
    console.error('[trade-monitor] Startup check failed:', err.message);
  });

  cron.schedule('* * * * *', () => {
    monitorOpenTrades().catch(err => {
      console.error('[trade-monitor] Scheduled check failed:', err.message);
    });
  });

  console.log('[trade-monitor] Started. Monitoring open positions every 60 seconds.');
}


module.exports = { start, monitorOpenTrades, closeTrade };
