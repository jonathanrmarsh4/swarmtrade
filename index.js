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

const { start: startTradeMonitor } = require('./scripts/trade-monitor.js');
startTradeMonitor();
console.log('[startup] Trade monitor started \u2014 checking open positions every 60 seconds');


// ── Step 5: Reflection agent nightly cron ─────────────────────────────────────
// Schedules a midnight cron that reviews the week's closed trades, recalculates
// accuracy scores per agent, and updates agent_reputation weights used by the
// Orchestrator to calibrate vote influence over time.

const { schedule: scheduleReflectionAgent } = require('./scripts/reflection-agent.js');
scheduleReflectionAgent();
console.log('[startup] Reflection agent scheduled \u2014 runs nightly at 00:00');


// ── Step 6: HTTP server ───────────────────────────────────────────────────────
// One server handles both the TradingView webhook and the health endpoint.
// Webhook logic (secret validation, signal write, deliberation trigger) is fully
// encapsulated in webhook/index.js — this file only owns routing and server lifecycle.

const { handleRequest: handleWebhook } = require('./webhook/index.js');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
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
