'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Market Scanner — proactively hunts for trading opportunities.
//
// Pipeline (runs every hour via node-cron):
//
//   Stage 1 — FETCH
//     Pull top 100 USDT pairs by 24h volume from Binance.
//     Fetch 1h OHLCV candles for each (last 30 candles).
//
//   Stage 2 — SCREEN (pure maths, no LLM cost)
//     Score each asset 0–4 based on how many filters pass:
//       • RSI < 35 (oversold) or RSI > 65 (overbought)
//       • Volume last candle > 2× 20-candle average
//       • Price at 20-candle high or low (breakout)
//       • MACD line crossed signal line on last candle
//     Only assets scoring ≥ MIN_SIGNAL_SCORE escalate to the swarm.
//
//   Stage 3 — SWARM
//     Each finalist is written as a signal to Supabase then run through
//     the full 6-agent deliberation pipeline (same as a TradingView alert).
//     Results appear in the Deliberations tab automatically.
//
//   Stage 4 — PERSIST SCAN RESULTS
//     All 100 assets + their scores written to scanner_results table so
//     the dashboard Scanner tab can display the full picture.
//
// Safety: scanner signals are tagged signal_type='scanner' so they can be
// distinguished from TradingView alerts in the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const cron             = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { runDeliberation } = require('../orchestrator/index.js');
const { executeTrade }    = require('../octobot/index.js');

// ── Config ────────────────────────────────────────────────────────────────────

const TOP_N_ASSETS     = 100;   // how many assets to fetch from Binance
const CANDLE_LIMIT     = 30;    // candles per asset (1h timeframe)
const MIN_SIGNAL_SCORE = 2;     // minimum filters passed to escalate to swarm
const MAX_ESCALATIONS  = 10;    // cap swarm calls per scan to control API cost
const SCAN_INTERVAL    = '0 * * * *'; // every hour at :00

// RSI thresholds
const RSI_OVERSOLD    = 35;
const RSI_OVERBOUGHT  = 65;

// Volume spike multiplier
const VOLUME_SPIKE_MULTIPLIER = 2.0;

// Stagger delay between swarm calls (ms) — avoids hammering Claude API
const SWARM_STAGGER_MS = 3_000;

// ── Supabase ──────────────────────────────────────────────────────────────────

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

// ── Binance helpers ───────────────────────────────────────────────────────────

async function fetchTopPairs() {
  const res  = await fetch('https://api.binance.com/api/v3/ticker/24hr', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Binance 24hr ticker HTTP ${res.status}`);
  const tickers = await res.json();

  return tickers
    .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 0)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, TOP_N_ASSETS)
    .map(t => ({
      symbol:      t.symbol,
      price:       parseFloat(t.lastPrice),
      volume24h:   parseFloat(t.quoteVolume),
      priceChange: parseFloat(t.priceChangePercent),
    }));
}

async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Candles HTTP ${res.status} for ${symbol}`);
  const raw = await res.json();

  // Binance kline format: [openTime, open, high, low, close, volume, ...]
  return raw.map(k => ({
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Technical indicators ──────────────────────────────────────────────────────

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;

  const closes  = candles.map(c => c.close);
  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }

  let avgGain = gains  / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(values, period) {
  const k   = 2 / (period + 1);
  let ema   = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(candles) {
  if (candles.length < 26) return { macdLine: 0, signalLine: 0, crossover: false, crossunder: false };

  const closes = candles.map(c => c.close);

  // Build EMA12 and EMA26 series
  const ema12Series = [];
  const ema26Series = [];
  const k12 = 2 / 13, k26 = 2 / 27;

  let ema12 = closes[0], ema26 = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    if (i >= 25) {
      ema12Series.push(ema12);
      ema26Series.push(ema26);
    }
  }

  const macdSeries = ema12Series.map((v, i) => v - ema26Series[i]);

  // Signal line = EMA9 of MACD
  const k9 = 2 / 10;
  let signal = macdSeries[0];
  const signalSeries = [signal];
  for (let i = 1; i < macdSeries.length; i++) {
    signal = macdSeries[i] * k9 + signal * (1 - k9);
    signalSeries.push(signal);
  }

  const last     = macdSeries.length - 1;
  const prev     = last - 1;
  const macdLine    = macdSeries[last];
  const signalLine  = signalSeries[last];
  const crossover   = macdSeries[prev] < signalSeries[prev] && macdLine > signalLine;
  const crossunder  = macdSeries[prev] > signalSeries[prev] && macdLine < signalLine;

  return { macdLine, signalLine, crossover, crossunder };
}

function calcVolumeRatio(candles) {
  if (candles.length < 2) return 1;
  const recent  = candles[candles.length - 1].volume;
  const avgVol  = candles.slice(0, -1).reduce((s, c) => s + c.volume, 0) / (candles.length - 1);
  return avgVol > 0 ? recent / avgVol : 1;
}

function isBreakout(candles) {
  if (candles.length < 2) return { breakoutHigh: false, breakoutLow: false };
  const last   = candles[candles.length - 1];
  const prior  = candles.slice(0, -1);
  const maxHigh = Math.max(...prior.map(c => c.high));
  const minLow  = Math.min(...prior.map(c => c.low));
  return {
    breakoutHigh: last.close > maxHigh,
    breakoutLow:  last.close < minLow,
  };
}

// ── Screener ──────────────────────────────────────────────────────────────────

function screenAsset(symbol, price, candles) {
  const signals  = [];
  let   score    = 0;
  let   direction = null;
  const bullSignals = [];
  const bearSignals = [];

  // 1. RSI
  const rsi = calcRSI(candles);
  if (rsi < RSI_OVERSOLD) {
    score++;
    bullSignals.push(`RSI oversold (${rsi.toFixed(1)})`);
  } else if (rsi > RSI_OVERBOUGHT) {
    score++;
    bearSignals.push(`RSI overbought (${rsi.toFixed(1)})`);
  }

  // 2. Volume spike
  const volumeRatio = calcVolumeRatio(candles);
  if (volumeRatio >= VOLUME_SPIKE_MULTIPLIER) {
    score++;
    signals.push(`Volume spike ${volumeRatio.toFixed(1)}×`);
  }

  // 3. Breakout
  const { breakoutHigh, breakoutLow } = isBreakout(candles);
  if (breakoutHigh) {
    score++;
    bullSignals.push('Price breakout (new high)');
  } else if (breakoutLow) {
    score++;
    bearSignals.push('Price breakdown (new low)');
  }

  // 4. MACD crossover
  const macd = calcMACD(candles);
  if (macd.crossover) {
    score++;
    bullSignals.push('MACD crossover (bullish)');
  } else if (macd.crossunder) {
    score++;
    bearSignals.push('MACD crossunder (bearish)');
  }

  // Determine direction bias
  if (bullSignals.length > bearSignals.length) direction = 'long';
  else if (bearSignals.length > bullSignals.length) direction = 'short';
  else if (bullSignals.length > 0) direction = 'long'; // tie goes to long
  else direction = 'long'; // default

  return {
    symbol,
    price,
    score,
    direction,
    rsi:         parseFloat(rsi.toFixed(1)),
    volumeRatio: parseFloat(volumeRatio.toFixed(2)),
    macdCross:   macd.crossover ? 'bullish' : macd.crossunder ? 'bearish' : null,
    breakout:    breakoutHigh ? 'high' : breakoutLow ? 'low' : null,
    signals:     [...bullSignals, ...bearSignals, ...signals],
  };
}

// ── Supabase persistence ──────────────────────────────────────────────────────

async function persistScanResults(scanId, results) {
  const rows = results.map(r => ({
    scan_id:      scanId,
    symbol:       r.symbol,
    price:        r.price,
    score:        r.score,
    direction:    r.direction,
    rsi:          r.rsi,
    volume_ratio: r.volumeRatio,
    macd_cross:   r.macdCross,
    breakout:     r.breakout,
    signals:      r.signals,
    escalated:    r.score >= MIN_SIGNAL_SCORE,
    scanned_at:   new Date().toISOString(),
  }));

  // Upsert in batches of 20
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const { error } = await getSupabase().from('scanner_results').insert(batch);
    if (error) console.warn(`[scanner] Failed to persist batch ${i / 20 + 1}: ${error.message}`);
  }
}

async function writeScanMeta(scanId, { total, escalated, durationMs }) {
  const { error } = await getSupabase().from('scanner_runs').insert({
    id:           scanId,
    total_assets: total,
    escalated:    escalated,
    duration_ms:  durationMs,
    scanned_at:   new Date().toISOString(),
  });
  if (error) console.warn(`[scanner] Failed to write scan meta: ${error.message}`);
}

async function writeSignalToSupabase(asset, direction, score, signals, price) {
  const { data, error } = await getSupabase()
    .from('signals')
    .insert({
      asset,
      direction,
      timeframe:   '1h',
      signal_type: 'scanner',
      raw_payload: { asset, direction, price, score, signals, signal_type: 'scanner' },
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

// ── Swarm escalation ──────────────────────────────────────────────────────────

async function escalateToSwarm(candidate) {
  const { symbol, direction, score, signals, price } = candidate;
  console.log(`[scanner] Escalating ${symbol} to swarm — score=${score} direction=${direction} signals=[${signals.join(', ')}]`);

  try {
    const signalId = await writeSignalToSupabase(symbol, direction, score, signals, price);
    const result   = await runDeliberation(signalId);

    console.log(
      `[scanner] Deliberation complete — ${symbol} decision=${result.decision} ` +
      `elapsed=${result.elapsedMs}ms`,
    );

    if (result.tradeInstruction) {
      await executeTrade(result.tradeInstruction);
    }
  } catch (err) {
    console.error(`[scanner] Swarm escalation failed for ${symbol}: ${err.message}`);
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function runScan() {
  const startTime = Date.now();
  const scanId    = `scan-${startTime}`;

  console.log('');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log(`[scanner] Scan started — ${new Date().toISOString()}`);
  console.log('────────────────────────────────────────────────────────────────────');

  // Stage 1: Fetch top 100 pairs
  let pairs;
  try {
    pairs = await fetchTopPairs();
    console.log(`[scanner] Stage 1 ✓ — fetched ${pairs.length} pairs`);
  } catch (err) {
    console.error(`[scanner] Stage 1 failed — could not fetch pairs: ${err.message}`);
    return;
  }

  // Stage 2: Fetch candles + screen each asset
  const results = [];
  let fetched = 0;

  for (const pair of pairs) {
    try {
      const candles = await fetchCandles(pair.symbol);
      const result  = screenAsset(pair.symbol, pair.price, candles);
      results.push(result);
      fetched++;

      // Brief pause every 10 assets to avoid rate limits
      if (fetched % 10 === 0) {
        await new Promise(r => setTimeout(r, 500));
        console.log(`[scanner] Screened ${fetched}/${pairs.length}...`);
      }
    } catch (err) {
      console.warn(`[scanner] Skipping ${pair.symbol}: ${err.message}`);
    }
  }

  console.log(`[scanner] Stage 2 ✓ — screened ${results.length} assets`);

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Show top candidates
  const candidates = results.filter(r => r.score >= MIN_SIGNAL_SCORE);
  console.log(`[scanner] ${candidates.length} assets passed filter (score ≥ ${MIN_SIGNAL_SCORE}):`);
  candidates.slice(0, MAX_ESCALATIONS).forEach(c => {
    console.log(`  ${c.symbol.padEnd(12)} score=${c.score} direction=${c.direction} rsi=${c.rsi} vol=${c.volumeRatio}× signals=[${c.signals.join(', ')}]`);
  });

  // Stage 3: Escalate top candidates to swarm
  const toEscalate = candidates.slice(0, MAX_ESCALATIONS);
  for (let i = 0; i < toEscalate.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, SWARM_STAGGER_MS));
    await escalateToSwarm(toEscalate[i]);
  }

  console.log(`[scanner] Stage 3 ✓ — escalated ${toEscalate.length} assets to swarm`);

  // Stage 4: Persist all results to Supabase
  try {
    await persistScanResults(scanId, results);
    await writeScanMeta(scanId, {
      total:      results.length,
      escalated:  toEscalate.length,
      durationMs: Date.now() - startTime,
    });
    console.log(`[scanner] Stage 4 ✓ — results persisted to Supabase`);
  } catch (err) {
    console.warn(`[scanner] Stage 4 failed (non-fatal): ${err.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[scanner] Scan complete in ${elapsed}s — next scan in ~1 hour`);
  console.log('────────────────────────────────────────────────────────────────────');
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function schedule() {
  console.log('[scanner] Scheduled — runs every hour at :00');

  // Run immediately on startup so first results appear right away
  runScan().catch(err => console.error('[scanner] Initial scan failed:', err.message));

  // Then every hour
  cron.schedule(SCAN_INTERVAL, () => {
    runScan().catch(err => console.error('[scanner] Scheduled scan failed:', err.message));
  });
}

module.exports = { schedule, runScan };
