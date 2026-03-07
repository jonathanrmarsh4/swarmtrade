'use strict';

// Load .env in local dev. Railway injects env vars directly in production.
require('dotenv').config();

const http = require('http');

// ── Step 1: Environment variable validation ───────────────────────────────────
// Fail fast before any service starts. All missing variables are listed together
// so a single deploy log is enough to diagnose the problem.

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TRADINGVIEW_WEBHOOK_SECRET',
  'SWARMTRADE_MODE',
];

// Optional but recommended — warn rather than crash if missing.
const OPTIONAL_BROKER_ENV = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'OCTOBOT_WEBHOOK_URL'];

const missing = REQUIRED_ENV.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('[startup] FATAL: Missing required environment variables:');
  missing.forEach(key => console.error(`  - ${key}`));
  process.exit(1);
}

console.log('[startup] Environment variables validated \u2713');

// Detect and log broker execution mode
const hasTestnet = !!(
  process.env.BINANCE_TESTNET === 'true' &&
  process.env.BINANCE_TESTNET_API_KEY &&
  process.env.BINANCE_TESTNET_API_SECRET
);
const hasOctoBot = !!process.env.OCTOBOT_WEBHOOK_URL;

console.log('[startup] Broker env check —',
  `BINANCE_TESTNET=${process.env.BINANCE_TESTNET}`,
  `API_KEY=${process.env.BINANCE_TESTNET_API_KEY ? 'set' : 'missing'}`,
  `API_SECRET=${process.env.BINANCE_TESTNET_API_SECRET ? 'set' : 'missing'}`
);

if (hasTestnet) {
  console.log('[startup] Broker mode: BINANCE TESTNET \u2713');
} else if (hasOctoBot) {
  console.log('[startup] Broker mode: OCTOBOT WEBHOOK');
} else {
  console.warn('[startup] WARNING: No broker configured — SIMULATION mode. Set BINANCE_TESTNET=true + BINANCE_TESTNET_API_KEY + BINANCE_TESTNET_API_SECRET in Railway.');
}


// ── Step 2: RAILWAY_ENVIRONMENT guard ─────────────────────────────────────────
// Warn if not 'paper' but do not exit — the same boot path serves future live mode.
// Paper-trading is also enforced at the OctoBot config level (belt and suspenders).

if (process.env.SWARMTRADE_MODE !== 'paper') {
  console.warn(
    `[startup] WARNING: RAILWAY_ENVIRONMENT is '${process.env.SWARMTRADE_MODE}'. ` +
    `Expected 'paper'. Confirm OctoBot is in paper trading mode before proceeding.`,
  );
} else {
  console.log(`[startup] RAILWAY_ENVIRONMENT=paper confirmed \u2713`);
}


// ── Step 3: Sentiment agents ──────────────────────────────────────────────────
// Starts two non-blocking background polling loops:
//   Crowd Thermometer — polls Fear & Greed Index + Reddit every 30 minutes
//   News Sentinel     — polls CryptoPanic every 2 minutes; fires interrupt on breaking news
//
// Must boot before the webhook server so a sentiment snapshot exists at the first
// deliberation instead of returning a neutral fallback.

const { startSentimentAgents } = require('./agents/sentiment/index.js');
startSentimentAgents();
console.log('[startup] Sentiment agents started \u2014 Crowd Thermometer and News Sentinel active');


// ── Step 4: Trade monitor cron ────────────────────────────────────────────────
// Polls the trades table every 60 seconds for open positions that may need
// attention: stop-loss / take-profit detection, stale position alerts.

const { start: startTradeMonitor, closeTrade } = require('./scripts/trade-monitor.js');
const { getDailySummary, checkBudget }             = require('./lib/cost-tracker.js');
startTradeMonitor();
console.log('[startup] Trade monitor started \u2014 checking open positions every 60 seconds');


// ── Step 5: Reflection agent nightly cron ─────────────────────────────────────
// Schedules a midnight cron that reviews the week's closed trades, recalculates
// accuracy scores per agent, and updates agent_reputation weights used by the
// Orchestrator to calibrate vote influence over time.

const { schedule: scheduleReflectionAgent } = require('./scripts/reflection-agent.js');
const { schedule: scheduleMarketScanner }   = require('./scripts/market-scanner.js');
scheduleReflectionAgent();
console.log('[startup] Reflection agent scheduled \u2014 runs nightly at 00:00');

scheduleMarketScanner();
console.log('[startup] Market scanner v2 — 10-min scan + WebSocket monitor active');


// ── Step 6: HTTP server ───────────────────────────────────────────────────────
// One server handles both the TradingView webhook and the health endpoint.
// Webhook logic (secret validation, signal write, deliberation trigger) is fully
// encapsulated in webhook/index.js — this file only owns routing and server lifecycle.

const { handleRequest: handleWebhook } = require('./webhook/index.js');
const { handleAnalystChat }             = require('./analyst/index.js');

const PORT = process.env.PORT || 3000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer((req, res) => {
  // CORS preflight — browsers send this before the real POST
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Attach CORS headers to every response
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  // Health check — Railway and external uptime monitors poll this endpoint.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:      'ok',
      environment: process.env.SWARMTRADE_MODE,
      uptime:      process.uptime(),
      timestamp:   new Date(),
    }));
    return;
  }

  // ── Binance proxy routes ────────────────────────────────────────────────────
  // Australian IPs are blocked by Binance. The backend runs on Railway (US/SG)
  // and can reach Binance. These two endpoints proxy chart data to the dashboard.

  // GET /proxy/klines?symbol=BTCUSDT&interval=1h&limit=80
  if (req.method === 'GET' && req.url.startsWith('/proxy/klines')) {
    const qs = new URL(req.url, 'http://x').searchParams;
    const symbol   = qs.get('symbol')   ?? 'BTCUSDT';
    const interval = qs.get('interval') ?? '1h';
    const limit    = qs.get('limit')    ?? '80';
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
      .then(r => r.json())
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch(err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // GET /proxy/price?symbol=BTCUSDT
  if (req.method === 'GET' && req.url.startsWith('/proxy/price')) {
    const qs = new URL(req.url, 'http://x').searchParams;
    const symbol = qs.get('symbol') ?? 'BTCUSDT';
    fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
      .then(r => r.json())
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch(err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // ── Generic system_config GET/POST ──────────────────────────────────────────
  // GET  /api/config/:key  — returns { key, value }
  // POST /api/config/:key  — body { value: <any> }, upserts and returns saved value
  const configMatch = req.url.match(/^\/api\/config\/([\w_]+)$/);
  if (configMatch) {
    const key = configMatch[1];
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (req.method === 'GET') {
      (async () => {
        try {
          const { data, error } = await sb.from('system_config').select('value').eq('key', key).single();
          if (error && error.code !== 'PGRST116') throw error;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ key, value: data?.value ?? null }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { value } = JSON.parse(body);
          const { error } = await sb.from('system_config')
            .upsert({ key, value }, { onConflict: 'key' });
          if (error) throw error;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ key, value, saved: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // ── Portfolio balance API ────────────────────────────────────────────────────
  // GET /api/portfolio/balance
  if (req.method === 'GET' && req.url === '/api/portfolio/balance') {
    (async () => {
      try {
        const INITIAL = Number(process.env.INITIAL_PORTFOLIO_VALUE_USD || 5_000);
        const isLive  = process.env.SWARMTRADE_MODE === 'live';
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const { data: trades } = await sb.from('trades').select('pnl_usd, exit_time, position_size_usd');
        const closed = (trades ?? []).filter(t => t.exit_time != null);
        const open   = (trades ?? []).filter(t => t.exit_time == null);
        const closedPnl    = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
        const allocatedUsd = open.reduce((s, t) => s + (t.position_size_usd ?? 0), 0);

        let currentBalance = Math.max(INITIAL + closedPnl, 0.01);
        let binanceBalance = null;

        if (isLive) {
          try {
            const crypto    = require('crypto');
            const apiKey    = process.env.BINANCE_TESTNET_API_KEY;
            const apiSecret = process.env.BINANCE_TESTNET_API_SECRET;
            const timestamp = Date.now();
            const qs        = `timestamp=${timestamp}`;
            const sig       = require('crypto').createHmac('sha256', apiSecret).update(qs).digest('hex');
            const r = await fetch(
              `https://api.binance.com/api/v3/account?${qs}&signature=${sig}`,
              { headers: { 'X-MBX-APIKEY': apiKey } }
            );
            if (r.ok) {
              const d = await r.json();
              const usdt = (d.balances ?? []).find(b => b.asset === 'USDT');
              if (usdt) binanceBalance = parseFloat(usdt.free) + parseFloat(usdt.locked);
            }
          } catch { /* ignore */ }
          if (binanceBalance != null) currentBalance = binanceBalance;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          startingBalance: INITIAL,
          currentBalance,
          closedPnlUsd:    parseFloat(closedPnl.toFixed(2)),
          closedPnlPct:    parseFloat(((closedPnl / INITIAL) * 100).toFixed(4)),
          allocatedUsd:    parseFloat(allocatedUsd.toFixed(2)),
          availableUsd:    parseFloat(Math.max(currentBalance - allocatedUsd, 0).toFixed(2)),
          openPositions:   open.length,
          mode:            isLive ? 'live' : 'paper',
          source:          isLive && binanceBalance != null ? 'binance' : 'calculated',
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // ── Cost / token usage API ────────────────────────────────────────────────────
  // GET /api/costs?days=7
  if (req.method === 'GET' && req.url.startsWith('/api/costs')) {
    const days = parseInt(new URL(req.url, 'http://x').searchParams.get('days') ?? '7', 10);
    getDailySummary(days)
      .then(summary => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // ── Manual trade close endpoint ─────────────────────────────────────────────
  // POST /trades/:id/close  { exitPrice?: number, reason?: string }
  // Fetches the trade, resolves asset/direction (from deliberation if needed),
  // fetches live price if exitPrice not provided, then calls closeTrade().
  const closeMatch = req.method === 'POST' && req.url.match(/^\/trades\/([^/]+)\/close$/);
  if (closeMatch) {
    const tradeId = closeMatch[1];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};

        // Fetch trade row
        const { data: trade, error: tradeErr } = await getSupabase()
          .from('trades').select('*').eq('id', tradeId).single();
        if (tradeErr || !trade) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Trade not found' }));
          return;
        }
        if (trade.exit_time) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Trade already closed' }));
          return;
        }

        // Resolve asset + direction — prefer trades columns, fall back to deliberation
        let asset     = trade.asset;
        let direction = trade.direction;
        if (!asset || !direction) {
          const { data: delib } = await getSupabase()
            .from('deliberations').select('asset, direction')
            .eq('id', trade.deliberation_id).single();
          asset     = asset     ?? delib?.asset;
          direction = direction ?? delib?.direction;
        }
        if (!asset || !direction) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot resolve asset/direction for this trade' }));
          return;
        }

        // Resolve exit price — use provided value or fetch live from Binance
        let exitPrice = payload.exitPrice ? parseFloat(payload.exitPrice) : null;
        if (!exitPrice) {
          const symbol = asset.replace('/', '');
          const tickerRes = await fetch(
            `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
          );
          const ticker = await tickerRes.json();
          exitPrice = ticker.price ? parseFloat(ticker.price) : parseFloat(trade.entry_price);
        }

        const reason = payload.reason ?? 'manual';
        await closeTrade(trade, asset, direction, exitPrice, reason);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tradeId, exitPrice, reason }));
      } catch (err) {
        console.error('[server] /trades/close error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Analyst chat proxy — forwards messages to Anthropic API server-side
  if (req.method === 'POST' && req.url === '/analyst/chat') {
    handleAnalystChat(req, res).catch(err => {
      console.error('[server] Analyst error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
    return;
  }

  // All other routes delegated to the webhook handler.
  // handleWebhook accepts POST /webhook/tradingview; returns 404 for anything else.
  handleWebhook(req, res).catch(err => {
    console.error('[server] Unhandled error in request handler:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, () => {
  // ── Step 7: Startup summary ───────────────────────────────────────────────
  const env  = process.env.SWARMTRADE_MODE ?? 'unknown';
  const mode = env === 'paper' ? 'PAPER TRADING (safe)' : env.toUpperCase();

  console.log('');
  console.log('\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  console.log('\u2502             SwarmTrade \u2014 Online                  \u2502');
  console.log('\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  console.log(`\u2502  Mode         : ${mode.padEnd(33)}\u2502`);
  console.log(`\u2502  Port         : ${String(PORT).padEnd(33)}\u2502`);
  console.log('\u2502  Webhook      : POST /webhook/tradingview        \u2502');
  console.log('\u2502  Health       : GET  /health                     \u2502');
  console.log('\u2502  Agents       : Bull \u00b7 Bear \u00b7 Quant \u00b7 Macro      \u2502');
  console.log('\u2502                 Sentiment \u00b7 Risk (rules engine)  \u2502');
  console.log('\u2502  Sentiment    : Crowd Thermometer + News Sentinel\u2502');
  console.log('\u2502  Trade mon    : every 60 s                       \u2502');
  console.log('\u2502  Reflection   : nightly at 00:00                 \u2502');
  console.log('\u2502  Scanner      : 10-min scan + WebSocket monitor   \u2502');
  console.log('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
  console.log('');
});


// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Railway sends SIGTERM before stopping a container. Close the HTTP server so
// in-flight requests complete, then let the process exit naturally.

process.on('SIGTERM', () => {
  console.log('[startup] SIGTERM received \u2014 shutting down gracefully...');
  server.close(() => {
    console.log('[startup] HTTP server closed. Exiting.');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[startup] Uncaught exception \u2014 process will exit:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Log but do not exit — a failed deliberation must not crash the webhook server.
  console.error('[startup] Unhandled promise rejection:', reason);
});
// Fri Mar  6 08:47:15 UTC 2026
