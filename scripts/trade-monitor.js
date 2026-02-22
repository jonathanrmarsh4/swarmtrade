'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Trade Monitor — polls the trades table every 60 seconds.
//
// Responsibilities:
//   - Detect open positions that have hit their stop-loss or take-profit level
//   - Alert on stale open positions (no exit after N hours)
//   - Update trade rows in Supabase when a position closes
//
// Phase 1: scaffold only — logs open position count.
// Phase 2: add stop-loss / take-profit price comparison against live price feed.
// Phase 3: add stale position alerts (> 24 h open without exit signal).
//
// Called once at startup via start(). Runs an immediate check then schedules
// a cron every minute. Does not self-start.
// ─────────────────────────────────────────────────────────────────────────────

const cron           = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

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


// ── checkOpenPositions ────────────────────────────────────────────────────────
// Fetches all rows in the trades table where exit_time IS NULL.
// Logs the count. Phase 2 will add price comparison logic here.

async function checkOpenPositions() {
  const { data: openTrades, error } = await getSupabase()
    .from('trades')
    .select('id, deliberation_id, entry_price, position_size_usd, entry_time, mode')
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

  console.log(`[trade-monitor] ${count} open position(s):`);

  for (const trade of openTrades) {
    const ageMs  = Date.now() - new Date(trade.entry_time).getTime();
    const ageMin = Math.round(ageMs / 60_000);
    console.log(
      `  trade=${trade.id} entry=$${trade.entry_price} ` +
      `size=$${trade.position_size_usd} age=${ageMin}min mode=${trade.mode}`,
    );
  }

  // Phase 2 — for each open trade, compare entry/stop-loss against live price.
  // Phase 3 — emit stale-position alert for trades open longer than 24 hours.
}


// ── start ─────────────────────────────────────────────────────────────────────
// Called once by the root index.js. Runs an immediate check, then schedules
// a cron job every 60 seconds (* * * * * = every minute in node-cron).

function start() {
  // Immediate first check so the operator can see position state right after boot.
  checkOpenPositions().catch(err => {
    console.error('[trade-monitor] Startup check failed:', err.message);
  });

  // node-cron expression: every minute (second field not used in 5-part syntax)
  cron.schedule('* * * * *', () => {
    checkOpenPositions().catch(err => {
      console.error('[trade-monitor] Scheduled check failed:', err.message);
    });
  });
}


module.exports = { start, checkOpenPositions };
