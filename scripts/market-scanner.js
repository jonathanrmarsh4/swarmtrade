'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Market Scanner v2 — Hybrid Watchlist + WebSocket Monitor
//
//   STAGE 1 — BACKGROUND SCAN (every 10 minutes)
//     Fetches top 100 USDT pairs by volume. Scores each with 4 technical
//     filters on 1h candles. Populates watchlist of top 5 candidates.
//     Pairs stay until they score below threshold on a rescan.
//
//   STAGE 2 — WEBSOCKET MONITOR (continuous, live 1m klines)
//     Opens Binance WebSocket streams for watchlist pairs (max 5).
//     Detects 3 live conditions per pair:
//       A. RSI crosses 30/70 on closing 1m candle
//       B. Volume spike: current candle > 2x recent average
//       C. Price breaks above resistance or below support
//     Tracks conditions in a rolling 5-minute signal window.
//
//   STAGE 3 — SMART ESCALATION (event-driven, no polling)
//     Triggers when ANY 2 distinct conditions fire within 5-min window.
//     30-minute cooldown per pair after escalation.
//     Sends full technical context to swarm deliberation.
// ─────────────────────────────────────────────────────────────────────────────

const cron             = require('node-cron');
const WebSocket        = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { runDeliberation } = require('../orchestrator/index.js');
const { executeTrade }    = require('../octobot/index.js');

// ── Config ────────────────────────────────────────────────────────────────────

const TOP_N_ASSETS            = 100;
const CANDLE_LIMIT            = 50;
const MIN_SIGNAL_SCORE        = 1;
const MAX_WATCHLIST_SIZE      = 5;
const SCAN_INTERVAL_MS        = 10 * 60 * 1000;   // 10 minutes
const ESCALATION_COOLDOWN_MS  = 30 * 60 * 1000;   // 30 min between escalations per pair
const TRIGGER_WINDOW_MS       = 5  * 60 * 1000;   // conditions must cluster within 5 min
const SIGNALS_REQUIRED        = 2;                 // distinct conditions needed to escalate
const WS_RECONNECT_DELAY_MS   = 5_000;

const RSI_OVERSOLD            = 30;
const RSI_OVERBOUGHT          = 70;
const LIVE_VOLUME_SPIKE_MULT  = 2.0;
const BINANCE_WS_BASE         = 'wss://stream.binance.com:9443/ws';

// ── Supabase ──────────────────────────────────────────────────────────────────

let supabase = null;
function getSupabase() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

// ── Technical indicators ──────────────────────────────────────────────────────

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcMACD(candles) {
  if (candles.length < 26) return { crossover: false, crossunder: false, macdLine: 0, signalLine: 0 };
  const closes = candles.map(c => c.close);
  const k12 = 2/13, k26 = 2/27, k9 = 2/10;
  let e12 = closes[0], e26 = closes[0];
  const macdSeries = [];
  for (let i = 1; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1-k12);
    e26 = closes[i] * k26 + e26 * (1-k26);
    if (i >= 25) macdSeries.push(e12 - e26);
  }
  let sig = macdSeries[0];
  const sigSeries = [sig];
  for (let i = 1; i < macdSeries.length; i++) { sig = macdSeries[i] * k9 + sig * (1-k9); sigSeries.push(sig); }
  const n = macdSeries.length - 1;
  return {
    crossover:  macdSeries[n-1] < sigSeries[n-1] && macdSeries[n] > sigSeries[n],
    crossunder: macdSeries[n-1] > sigSeries[n-1] && macdSeries[n] < sigSeries[n],
    macdLine:   macdSeries[n],
    signalLine: sigSeries[n],
  };
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

function calcVolumeRatio(candles) {
  if (candles.length < 2) return 1;
  const last = candles[candles.length-1].volume;
  const avg  = candles.slice(0,-1).reduce((s, c) => s + c.volume, 0) / (candles.length-1);
  return avg > 0 ? last / avg : 1;
}

function calcSupportResistance(candles) {
  const window = candles.slice(-20);
  return {
    resistance: Math.max(...window.map(c => c.high)),
    support:    Math.min(...window.map(c => c.low)),
  };
}

function scoreAsset(symbol, price, candles) {
  const rsi         = calcRSI(candles);
  const macd        = calcMACD(candles);
  const volumeRatio = calcVolumeRatio(candles);
  const atr         = calcATR(candles);
  const { support, resistance } = calcSupportResistance(candles);

  let score = 0;
  const bullSignals = [], bearSignals = [], neutralSignals = [];

  if (rsi < RSI_OVERSOLD)    { score++; bullSignals.push(`RSI oversold (${rsi.toFixed(1)})`); }
  if (rsi > RSI_OVERBOUGHT)  { score++; bearSignals.push(`RSI overbought (${rsi.toFixed(1)})`); }
  if (volumeRatio >= 2.0)    { score++; neutralSignals.push(`Volume spike ${volumeRatio.toFixed(1)}x`); }
  if (macd.crossover)        { score++; bullSignals.push('MACD crossover (bullish)'); }
  if (macd.crossunder)       { score++; bearSignals.push('MACD crossunder (bearish)'); }

  const direction = bullSignals.length >= bearSignals.length ? 'long' : 'short';

  return {
    symbol, price, score, direction,
    rsi:         parseFloat(rsi.toFixed(1)),
    volumeRatio: parseFloat(volumeRatio.toFixed(2)),
    macdCross:   macd.crossover ? 'bullish' : macd.crossunder ? 'bearish' : null,
    atr:         atr ? parseFloat(atr.toFixed(8)) : null,
    support, resistance,
    signals: [...bullSignals, ...bearSignals, ...neutralSignals],
  };
}

// ── Binance REST helpers ──────────────────────────────────────────────────────

async function fetchTopPairs() {
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`);
  const tickers = await res.json();
  return tickers
    .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 0)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, TOP_N_ASSETS)
    .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), volume24h: parseFloat(t.quoteVolume) }));
}

async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Candles HTTP ${res.status}`);
  return (await res.json()).map(k => ({
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ── State ─────────────────────────────────────────────────────────────────────

const watchlist     = new Map(); // symbol -> candidate
const signalWindows = new Map(); // symbol -> [{type, timestamp}]
const lastEscalation = new Map(); // symbol -> timestamp

function recordLiveSignal(symbol, type) {
  const now = Date.now();
  if (!signalWindows.has(symbol)) signalWindows.set(symbol, []);
  const events = signalWindows.get(symbol);
  events.push({ type, timestamp: now });
  const cutoff = now - TRIGGER_WINDOW_MS;
  const fresh  = events.filter(e => e.timestamp > cutoff);
  signalWindows.set(symbol, fresh);
  return new Set(fresh.map(e => e.type));
}

function canEscalate(symbol) {
  return (Date.now() - (lastEscalation.get(symbol) ?? 0)) > ESCALATION_COOLDOWN_MS;
}

function markEscalated(symbol) {
  lastEscalation.set(symbol, Date.now());
  signalWindows.delete(symbol);
}

// ── Supabase writes ───────────────────────────────────────────────────────────

async function writeSignalToSupabase(symbol, candidate, triggerTypes, livePrice) {
  const macdSignal = candidate.macdCross === 'bullish' ? 'bullish_crossover'
                   : candidate.macdCross === 'bearish' ? 'bearish_crossover' : 'neutral';

  const { data, error } = await getSupabase().from('signals').insert({
    asset:       symbol,
    direction:   candidate.direction,
    timeframe:   '1h',
    signal_type: 'websocket_trigger',
    raw_payload: {
      asset:         symbol,
      direction:     candidate.direction,
      price:         livePrice,
      rsi:           candidate.rsi,
      volume_ratio:  candidate.volumeRatio,
      macd_signal:   macdSignal,
      atr:           candidate.atr,
      support:       candidate.support,
      resistance:    candidate.resistance,
      signals:       candidate.signals,
      trigger_types: [...triggerTypes],
      signal_type:   'websocket_trigger',
    },
  }).select('id').single();

  if (error) throw error;
  return data.id;
}

async function persistScanResults(scanId, results) {
  const rows = results.map(r => ({
    scan_id: scanId, symbol: r.symbol, price: r.price, score: r.score,
    direction: r.direction, rsi: r.rsi, volume_ratio: r.volumeRatio,
    macd_cross: r.macdCross, signals: r.signals,
    escalated: watchlist.has(r.symbol), scanned_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 20) {
    const { error } = await getSupabase().from('scanner_results').insert(rows.slice(i, i+20));
    if (error) console.warn(`[scanner] Persist error: ${error.message}`);
  }
}

async function persistWatchlist() {
  const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
  for (const [symbol, c] of watchlist.entries()) {
    const { error } = await getSupabase().from('watchlist_active').upsert({
      symbol, score: c.score, reasons: c.signals, price: c.price,
      direction: c.direction, expires_at: expiry, created_at: new Date().toISOString(),
    }, { onConflict: 'symbol' });
    if (error) console.warn(`[scanner] Watchlist upsert error ${symbol}: ${error.message}`);
  }
}

// ── Escalation ────────────────────────────────────────────────────────────────

async function escalateToSwarm(symbol, triggerTypes, livePrice) {
  const candidate = watchlist.get(symbol);
  if (!candidate) return;

  console.log(`\n[ws-monitor] ⚡ ESCALATING ${symbol} → swarm`);
  console.log(`[ws-monitor]   Triggers : [${[...triggerTypes].join(', ')}]`);
  console.log(`[ws-monitor]   Price    : $${livePrice}`);
  console.log(`[ws-monitor]   Scan RSI : ${candidate.rsi}  Vol: ${candidate.volumeRatio}x  MACD: ${candidate.macdCross}`);

  markEscalated(symbol);

  try {
    const signalId = await writeSignalToSupabase(symbol, candidate, triggerTypes, livePrice);
    const result   = await runDeliberation(signalId);
    console.log(`[ws-monitor] Deliberation complete — ${symbol} decision=${result.decision} elapsed=${result.elapsedMs}ms`);
    if (result.tradeInstruction) await executeTrade(result.tradeInstruction);
  } catch (err) {
    console.error(`[ws-monitor] Escalation failed for ${symbol}: ${err.message}`);
  }
}

// ── WebSocket Manager ─────────────────────────────────────────────────────────

class WebSocketManager {
  constructor() { this.connections = new Map(); }

  _updateBuffer(buffer, kline) {
    if (!buffer.length || kline.time !== buffer[buffer.length-1].time) buffer.push(kline);
    else buffer[buffer.length-1] = kline;
    if (buffer.length > 30) buffer.shift();
  }

  _check(symbol, kline, buffer) {
    if (!canEscalate(symbol)) return;
    const candidate = watchlist.get(symbol);
    if (!candidate) return;

    let windowTypes = signalWindows.get(symbol) ? new Set(signalWindows.get(symbol).filter(e => e.timestamp > Date.now() - TRIGGER_WINDOW_MS).map(e => e.type)) : new Set();

    // A: RSI (only on closed candles)
    if (kline.isFinal && buffer.length >= 15) {
      const liveRSI = calcRSI(buffer);
      if (liveRSI < RSI_OVERSOLD) {
        console.log(`[ws-monitor] ${symbol} live RSI oversold: ${liveRSI.toFixed(1)}`);
        windowTypes = recordLiveSignal(symbol, 'rsi_oversold');
      } else if (liveRSI > RSI_OVERBOUGHT) {
        console.log(`[ws-monitor] ${symbol} live RSI overbought: ${liveRSI.toFixed(1)}`);
        windowTypes = recordLiveSignal(symbol, 'rsi_overbought');
      }
    }

    // B: Volume spike
    if (buffer.length >= 6) {
      const avgVol = buffer.slice(-6,-1).map(c => c.volume).reduce((a,b)=>a+b,0) / 5;
      if (avgVol > 0 && kline.volume > avgVol * LIVE_VOLUME_SPIKE_MULT) {
        console.log(`[ws-monitor] ${symbol} volume spike: ${(kline.volume/avgVol).toFixed(1)}x`);
        windowTypes = recordLiveSignal(symbol, 'volume_spike');
      }
    }

    // C: Price breakout vs scan-time S/R levels
    if (candidate.support && candidate.resistance) {
      if (kline.close > candidate.resistance) {
        console.log(`[ws-monitor] ${symbol} broke resistance $${candidate.resistance.toFixed(4)}`);
        windowTypes = recordLiveSignal(symbol, 'breakout_high');
      } else if (kline.close < candidate.support) {
        console.log(`[ws-monitor] ${symbol} broke support $${candidate.support.toFixed(4)}`);
        windowTypes = recordLiveSignal(symbol, 'breakout_low');
      }
    }

    if (windowTypes.size >= SIGNALS_REQUIRED && canEscalate(symbol)) {
      escalateToSwarm(symbol, windowTypes, kline.close).catch(e =>
        console.error(`[ws-monitor] Escalation error ${symbol}: ${e.message}`)
      );
    }
  }

  connect(symbol) {
    if (this.connections.has(symbol)) return;
    const buffer = [];
    const ws     = new WebSocket(`${BINANCE_WS_BASE}/${symbol.toLowerCase()}@kline_1m`);

    ws.on('open',  () => console.log(`[ws-monitor] ✓ Connected — ${symbol}`));
    ws.on('error', e  => console.error(`[ws-monitor] Error ${symbol}: ${e.message}`));
    ws.on('close', () => {
      console.log(`[ws-monitor] Closed — ${symbol}`);
      this.connections.delete(symbol);
      if (watchlist.has(symbol)) {
        setTimeout(() => this.connect(symbol), WS_RECONNECT_DELAY_MS);
      }
    });
    ws.on('message', raw => {
      try {
        const k = JSON.parse(raw).k;
        if (!k) return;
        const kline = {
          time: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
          low: parseFloat(k.l), close: parseFloat(k.c),
          volume: parseFloat(k.v), isFinal: k.x,
        };
        this._updateBuffer(buffer, kline);
        this._check(symbol, kline, buffer);
      } catch {}
    });

    this.connections.set(symbol, ws);
  }

  disconnect(symbol) {
    const ws = this.connections.get(symbol);
    if (ws) { ws.terminate(); this.connections.delete(symbol); }
  }

  sync(symbols) {
    const current = new Set(this.connections.keys());
    const desired = new Set(symbols);
    for (const s of current) if (!desired.has(s)) { this.disconnect(s); signalWindows.delete(s); }
    for (const s of desired) if (!current.has(s))   this.connect(s);
    if (desired.size) console.log(`[ws-monitor] Active streams: [${[...desired].join(', ')}]`);
  }

  status() { return [...this.connections.keys()]; }
}

const wsManager = new WebSocketManager();

// ── Background scan ───────────────────────────────────────────────────────────

async function runBackgroundScan() {
  const startTime = Date.now();
  const scanId    = `scan-${startTime}`;

  console.log('\n────────────────────────────────────────────────');
  console.log(`[scanner] Scan — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Perth' })} AWST`);
  console.log('────────────────────────────────────────────────');

  let pairs;
  try {
    pairs = await fetchTopPairs();
  } catch (err) {
    console.error(`[scanner] Fetch failed: ${err.message}`); return;
  }

  const results = [];
  let n = 0;
  for (const pair of pairs) {
    try {
      const candles = await fetchCandles(pair.symbol);
      results.push(scoreAsset(pair.symbol, pair.price, candles));
      if (++n % 20 === 0) { await new Promise(r => setTimeout(r, 300)); console.log(`[scanner] ${n}/${pairs.length}...`); }
    } catch (err) {
      console.warn(`[scanner] Skip ${pair.symbol}: ${err.message}`);
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Refresh existing watchlist entries, remove ones that dropped below threshold
  for (const [sym, prev] of watchlist.entries()) {
    const fresh = results.find(r => r.symbol === sym);
    if (!fresh || fresh.score < MIN_SIGNAL_SCORE) {
      console.log(`[scanner] ${sym} dropped from watchlist (score too low)`);
      watchlist.delete(sym);
    } else {
      watchlist.set(sym, { ...fresh, addedAt: prev.addedAt });
    }
  }

  // Fill watchlist up to max
  for (const r of results) {
    if (watchlist.size >= MAX_WATCHLIST_SIZE) break;
    if (r.score >= MIN_SIGNAL_SCORE && !watchlist.has(r.symbol)) {
      console.log(`[scanner] + ${r.symbol} score=${r.score} RSI=${r.rsi} vol=${r.volumeRatio}x [${r.signals.join(', ')}]`);
      watchlist.set(r.symbol, { ...r, addedAt: Date.now() });
    }
  }

  console.log(`[scanner] Watchlist (${watchlist.size}/${MAX_WATCHLIST_SIZE}):`);
  for (const [sym, c] of watchlist.entries()) {
    const cooldownMs = ESCALATION_COOLDOWN_MS - (Date.now() - (lastEscalation.get(sym) ?? 0));
    const cd = cooldownMs > 0 ? `cooldown ${Math.round(cooldownMs/60000)}min` : 'ready';
    console.log(`  ${sym.padEnd(14)} score=${c.score} ${c.direction} RSI=${c.rsi} [${cd}]`);
  }

  wsManager.sync([...watchlist.keys()]);

  try {
    await persistScanResults(scanId, results);
    await persistWatchlist();
    await getSupabase().from('scanner_runs').insert({
      id: scanId, total_assets: results.length, escalated: watchlist.size,
      duration_ms: Date.now() - startTime, scanned_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[scanner] Persist error (non-fatal): ${err.message}`);
  }

  console.log(`[scanner] Done in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function schedule() {
  try { require('ws'); } catch {
    console.error('[scanner] FATAL: "ws" package not installed. Run: npm install ws');
    return;
  }

  console.log('[scanner] Market Scanner v2 — Hybrid Watchlist + WebSocket');
  console.log(`[scanner] Scan interval : every ${SCAN_INTERVAL_MS/60000} minutes`);
  console.log(`[scanner] Watchlist size: max ${MAX_WATCHLIST_SIZE} pairs`);
  console.log(`[scanner] Escalation    : ${SIGNALS_REQUIRED} conditions within ${TRIGGER_WINDOW_MS/60000}min`);
  console.log(`[scanner] Cooldown      : ${ESCALATION_COOLDOWN_MS/60000}min per pair`);

  runBackgroundScan().catch(err => console.error('[scanner] Startup scan error:', err.message));
  setInterval(() => runBackgroundScan().catch(e => console.error('[scanner] Scan error:', e.message)), SCAN_INTERVAL_MS);
}

module.exports = { schedule, runBackgroundScan, watchlist, wsManager };
