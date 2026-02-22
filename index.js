'use strict';

// Load .env in local development — Railway injects env vars directly in production.
require('dotenv').config();

// ── Environment variable validation ───────────────────────────────────────────
// Fail fast and list every missing variable in a single log line so a single
// deploy log is enough to diagnose the problem.

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TRADINGVIEW_WEBHOOK_SECRET',
];

const missing = REQUIRED_ENV.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('[startup] FATAL: Missing required environment variables:');
  missing.forEach(key => console.error(`  - ${key}`));
  process.exit(1);
}

console.log('[startup] Environment variables validated ✓');

// ── RAILWAY_ENVIRONMENT guard ─────────────────────────────────────────────────
// Warn loudly if the environment is not 'paper'. Paper trading is also enforced
// at the OctoBot config level — this is an additional belt-and-suspenders check.

if (process.env.RAILWAY_ENVIRONMENT && process.env.RAILWAY_ENVIRONMENT !== 'paper') {
  console.warn(
    `[startup] WARNING: RAILWAY_ENVIRONMENT is '${process.env.RAILWAY_ENVIRONMENT}'. ` +
    `Expected 'paper'. Confirm OctoBot is in paper trading mode before proceeding.`,
  );
} else {
  console.log(`[startup] RAILWAY_ENVIRONMENT=${process.env.RAILWAY_ENVIRONMENT || 'local'} ✓`);
}

// ── Bootstrap webhook server ──────────────────────────────────────────────────
// webhook/index.js binds to PORT on require. It handles:
//   GET  /health         — Railway health check
//   POST /webhook        — TradingView alerts
// All other routes return 404.

require('./webhook/index.js');

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Railway sends SIGTERM before stopping a container. The webhook server handles
// in-flight requests; we just need to ensure the process exits cleanly.

process.on('SIGTERM', () => {
  console.log('[startup] SIGTERM received — shutting down gracefully.');
  // webhook/index.js owns the server instance; it will drain and close.
  // Give in-flight deliberations up to 10 s to complete before hard exit.
  setTimeout(() => process.exit(0), 10_000);
});

process.on('uncaughtException', (err) => {
  console.error('[startup] Uncaught exception — process will exit:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Log but do not exit — a failed deliberation must not crash the webhook server.
  console.error('[startup] Unhandled promise rejection:', reason);
});
