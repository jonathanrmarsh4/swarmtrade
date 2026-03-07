'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Market Scanner v3 — Multi-Profile Hybrid Watchlist + WebSocket Monitor
//
// Runs 4 independent scanning pipelines simultaneously, one per trading profile:
//   Intraday  — 15m candles, 2-min escalation window
//   Day Trade — 1h candles,  5-min escalation window
//   Swing     — 4h candles, 10-min escalation window
//   Position  — 1d candles, 30-min escalation window
//
// Each profile maintains its own watchlist (max 5 pairs) and WebSocket streams.
// Escalation requires 2 distinct live conditions within the profile's window.
// ─────────────────────────────────────────────────────────────────────────────

const WebSocket        = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { runDeliberation }          = require('../orchestrator/index.js');
const { executeTrade }             = require('../octobot/index.js');
const { TRADING_PROFILES, ALL_PROFILE_IDS } = require('../config/trading-profiles.js');

// ── Global config ─────────────────────────────────────────────────────────────

const TOP_N_ASSETS           = 100;
const MAX_WATCHLIST_SIZE     = 5;
const SCAN_INTERVAL_MS       = 10 * 60 * 1000;   // 10 min — all profiles scan together
const ESCALATION_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min per pair per profile
const SIGNALS_REQUIRED       = 2;
const WS_RECONNECT_DELAY_MS  = 5_000;
const BINANCE_WS_BASE        = 'wss://stream.binance.com:9443/ws';

// ── Supabase ──────────────────────────────────────────────────────────────────

let _supabase = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return _supabase;
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
  if (candles.length < 26) return { crossover: false, crossunder: false };
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
  const w = candles.slice(-20);
  return { resistance: Math.max(...w.map(c => c.high)), support: Math.min(...w.map(c => c.low)) };
}

// Score asset against a specific profile's thresholds
function scoreAsset(symbol, price, candles, profile) {
  const rsi         = calcRSI(candles);
  const macd        = calcMACD(candles);
  const volumeRatio = calcVolumeRatio(candles);
  const atr         = calcATR(candles);
  const { support, resistance } = calcSupportResistance(candles);

  let score = 0;
  const bullSignals = [], bearSignals = [], neutralSignals = [];

  if (rsi < profile.rsiOversold)    { score++; bullSignals.push(`RSI oversold (${rsi.toFixed(1)})`); }
  if (rsi > profile.rsiOverbought)  { score++; bearSignals.push(`RSI overbought (${rsi.toFixed(1)})`); }
  if (volumeRatio >= profile.volumeSpikeMult) { score++; neutralSignals.push(`Volume spike ${volumeRatio.toFixed(1)}x`); }
  if (macd.crossover)               { score++; bullSignals.push('MACD crossover (bullish)'); }
  if (macd.crossunder)              { score++; bearSignals.push('MACD crossunder (bearish)'); }

  const direction = bullSignals.length >= bearSignals.length ? 'long' : 'short';

  return {
    symbol, price, score, direction,
    rsi: parseFloat(rsi.toFixed(1)),
    volumeRatio: parseFloat(volumeRatio.toFixed(2)),
    macdCross: macd.crossover ? 'bullish' : macd.crossunder ? 'bearish' : null,
    atr: atr ? parseFloat(atr.toFixed(8)) : null,
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
    .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice) }));
}

async function fetchCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Candles HTTP ${res.status}`);
  return (await res.json()).map(k => ({
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ── Per-profile state ─────────────────────────────────────────────────────────
// Each profile gets its own isolated watchlist, signal windows, and cooldowns.

class ProfileState {
  constructor(profileId) {
    this.profileId    = profileId;
    this.profile      = TRADING_PROFILES[profileId];
    this.watchlist    = new Map();   // symbol → candidate
    this.sigWindows   = new Map();   // symbol → [{type, timestamp}]
    this.cooldowns    = new Map();   // symbol → last escalation timestamp
    this.wsConns      = new Map();   // symbol → WebSocket
  }

  canEscalate(symbol) {
    return (Date.now() - (this.cooldowns.get(symbol) ?? 0)) > ESCALATION_COOLDOWN_MS;
  }

  recordSignal(symbol, type) {
    const now = Date.now();
    if (!this.sigWindows.has(symbol)) this.sigWindows.set(symbol, []);
    const events = this.sigWindows.get(symbol);
    events.push({ type, timestamp: now });
    const cutoff = now - this.profile.wsEscalationMs;
    const fresh  = events.filter(e => e.timestamp > cutoff);
    this.sigWindows.set(symbol, fresh);
    return new Set(fresh.map(e => e.type));
  }

  markEscalated(symbol) {
    this.cooldowns.set(symbol, Date.now());
    this.sigWindows.delete(symbol);
  }

  connectWS(symbol) {
    if (this.wsConns.has(symbol)) return;
    const buf = [];
    const ws  = new WebSocket(`${BINANCE_WS_BASE}/${symbol.toLowerCase()}@kline_1m`);

    ws.on('open',  () => console.log(`[ws:${this.profile.label}] ✓ ${symbol}`));
    ws.on('error', e  => console.error(`[ws:${this.profile.label}] Error ${symbol}: ${e.message}`));
    ws.on('close', () => {
      this.wsConns.delete(symbol);
      if (this.watchlist.has(symbol)) {
        setTimeout(() => this.connectWS(symbol), WS_RECONNECT_DELAY_MS);
      }
    });
    ws.on('message', raw => {
      try {
        const k = JSON.parse(raw).k;
        if (!k) return;
        const kline = {
          time: k.t, close: parseFloat(k.c), high: parseFloat(k.h),
          low: parseFloat(k.l), volume: parseFloat(k.v), isFinal: k.x,
        };
        // Update buffer
        if (!buf.length || kline.time !== buf[buf.length-1].time) buf.push(kline);
        else buf[buf.length-1] = kline;
        if (buf.length > 30) buf.shift();

        this._checkConditions(symbol, kline, buf);
      } catch {}
    });

    this.wsConns.set(symbol, ws);
  }

  _checkConditions(symbol, kline, buf) {
    if (!this.canEscalate(symbol)) return;
    const candidate = this.watchlist.get(symbol);
    if (!candidate) return;

    let windowTypes = this.sigWindows.has(symbol)
      ? new Set(this.sigWindows.get(symbol).filter(e => e.timestamp > Date.now() - this.profile.wsEscalationMs).map(e => e.type))
      : new Set();

    // A: RSI threshold (on candle close only)
    if (kline.isFinal && buf.length >= 15) {
      const liveRSI = calcRSI(buf);
      if (liveRSI < this.profile.rsiOversold) {
        console.log(`[ws:${this.profile.label}] ${symbol} RSI oversold: ${liveRSI.toFixed(1)}`);
        windowTypes = this.recordSignal(symbol, 'rsi_oversold');
      } else if (liveRSI > this.profile.rsiOverbought) {
        console.log(`[ws:${this.profile.label}] ${symbol} RSI overbought: ${liveRSI.toFixed(1)}`);
        windowTypes = this.recordSignal(symbol, 'rsi_overbought');
      }
    }

    // B: Volume spike (profile-specific multiplier)
    if (buf.length >= 6) {
      const avgVol = buf.slice(-6,-1).map(c => c.volume).reduce((a,b)=>a+b,0) / 5;
      if (avgVol > 0 && kline.volume > avgVol * this.profile.volumeSpikeMult) {
        console.log(`[ws:${this.profile.label}] ${symbol} volume spike: ${(kline.volume/avgVol).toFixed(1)}x`);
        windowTypes = this.recordSignal(symbol, 'volume_spike');
      }
    }

    // C: Price breakout vs scan-time S/R
    if (candidate.support && candidate.resistance) {
      if (kline.close > candidate.resistance) {
        console.log(`[ws:${this.profile.label}] ${symbol} broke resistance $${candidate.resistance.toFixed(4)}`);
        windowTypes = this.recordSignal(symbol, 'breakout_high');
      } else if (kline.close < candidate.support) {
        console.log(`[ws:${this.profile.label}] ${symbol} broke support $${candidate.support.toFixed(4)}`);
        windowTypes = this.recordSignal(symbol, 'breakout_low');
      }
    }

    if (windowTypes.size >= SIGNALS_REQUIRED && this.canEscalate(symbol)) {
      this._escalate(symbol, windowTypes, kline.close).catch(e =>
        console.error(`[ws:${this.profile.label}] Escalation error ${symbol}: ${e.message}`)
      );
    }
  }

  async _escalate(symbol, triggerTypes, livePrice) {
    const candidate = this.watchlist.get(symbol);
    if (!candidate) return;

    console.log(`\n[ws:${this.profile.label}] ⚡ ESCALATING ${symbol}`);
    console.log(`[ws:${this.profile.label}]   Triggers: [${[...triggerTypes].join(', ')}]  Price: $${livePrice}`);

    this.markEscalated(symbol);

    const macdSignal = candidate.macdCross === 'bullish' ? 'bullish_crossover'
                     : candidate.macdCross === 'bearish' ? 'bearish_crossover' : 'neutral';

    const { data, error } = await getSupabase().from('signals').insert({
      asset:       symbol,
      direction:   candidate.direction,
      timeframe:   this.profile.signalTimeframe,
      signal_type: 'websocket_trigger',
      raw_payload: {
        asset: symbol, direction: candidate.direction, price: livePrice,
        rsi: candidate.rsi, volume_ratio: candidate.volumeRatio,
        macd_signal: macdSignal, atr: candidate.atr,
        support: candidate.support, resistance: candidate.resistance,
        signals: candidate.signals, trigger_types: [...triggerTypes],
        signal_type: 'websocket_trigger',
        trading_mode: this.profileId,
      },
    }).select('id').single();

    if (error) { console.error(`[ws:${this.profile.label}] Signal write failed: ${error.message}`); return; }

    const result = await runDeliberation(data.id);
    console.log(`[ws:${this.profile.label}] Deliberation: ${symbol} decision=${result.decision} elapsed=${result.elapsedMs}ms`);
    if (result.tradeInstruction) await executeTrade(result.tradeInstruction);
  }

  syncWS() {
    const current = new Set(this.wsConns.keys());
    const desired = new Set(this.watchlist.keys());
    for (const s of current) if (!desired.has(s)) { this.wsConns.get(s)?.terminate(); this.wsConns.delete(s); this.sigWindows.delete(s); }
    for (const s of desired) if (!current.has(s)) this.connectWS(s);
    if (desired.size) console.log(`[ws:${this.profile.label}] Streams: [${[...desired].join(', ')}]`);
  }

  updateWatchlist(results) {
    // Refresh existing entries, remove those that dropped below threshold
    for (const [sym, prev] of this.watchlist.entries()) {
      const fresh = results.find(r => r.symbol === sym);
      if (!fresh || fresh.score < 1) {
        this.watchlist.delete(sym);
        console.log(`[scanner:${this.profile.label}] ${sym} dropped from watchlist`);
      } else {
        this.watchlist.set(sym, { ...fresh, addedAt: prev.addedAt });
      }
    }
    // Fill up to max
    for (const r of results) {
      if (this.watchlist.size >= MAX_WATCHLIST_SIZE) break;
      if (r.score >= 1 && !this.watchlist.has(r.symbol)) {
        console.log(`[scanner:${this.profile.label}] + ${r.symbol} score=${r.score} RSI=${r.rsi} vol=${r.volumeRatio}x [${r.signals.join(', ')}]`);
        this.watchlist.set(r.symbol, { ...r, addedAt: Date.now() });
      }
    }
  }
}

// Instantiate all four profiles
const profileStates = {};
for (const id of ALL_PROFILE_IDS) profileStates[id] = new ProfileState(id);

// ── Background scan ───────────────────────────────────────────────────────────

async function runBackgroundScan() {
  const startTime = Date.now();
  const scanId    = `scan-${startTime}`;

  console.log('\n════════════════════════════════════════════════');
  console.log(`[scanner] Multi-profile scan — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Perth' })} AWST`);
  console.log('════════════════════════════════════════════════');

  // Fetch top 100 pairs once (shared across all profiles)
  let pairs;
  try {
    pairs = await fetchTopPairs();
  } catch (err) {
    console.error(`[scanner] Fetch failed: ${err.message}`); return;
  }

  // Run each profile's scan in parallel
  const profileResults = {};
  await Promise.all(ALL_PROFILE_IDS.map(async (profileId) => {
    const state   = profileStates[profileId];
    const profile = state.profile;
    const results = [];
    let n = 0;

    for (const pair of pairs) {
      try {
        const candles = await fetchCandles(pair.symbol, profile.candleInterval, profile.candleLimit);
        results.push(scoreAsset(pair.symbol, pair.price, candles, profile));
        if (++n % 25 === 0) await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[scanner:${profile.label}] Skip ${pair.symbol}: ${err.message}`);
      }
    }

    results.sort((a, b) => b.score - a.score);
    profileResults[profileId] = results;

    state.updateWatchlist(results);
    state.syncWS();

    console.log(`[scanner:${profile.label}] Watchlist (${state.watchlist.size}/${MAX_WATCHLIST_SIZE}) on ${profile.candleInterval} candles:`);
    for (const [sym, c] of state.watchlist.entries()) {
      const cd = ESCALATION_COOLDOWN_MS - (Date.now() - (state.cooldowns.get(sym) ?? 0));
      const cdStr = cd > 0 ? `cooldown ${Math.round(cd/60000)}min` : 'ready';
      console.log(`  ${sym.padEnd(14)} score=${c.score} ${c.direction} RSI=${c.rsi} [${cdStr}]`);
    }
  }));

  // Persist scan results + watchlists to Supabase
  try {
    await getSupabase().from('scanner_runs').insert({
      id: scanId, total_assets: pairs.length, escalated: 0,
      duration_ms: Date.now() - startTime, scanned_at: new Date().toISOString(),
    });

    // Persist all results tagged by profile
    const allRows = [];
    for (const [profileId, results] of Object.entries(profileResults)) {
      const profile = TRADING_PROFILES[profileId];
      for (const r of results) {
        allRows.push({
          scan_id: scanId, symbol: r.symbol, price: r.price, score: r.score,
          direction: r.direction, rsi: r.rsi, volume_ratio: r.volumeRatio,
          macd_cross: r.macdCross, signals: r.signals,
          escalated: profileStates[profileId].watchlist.has(r.symbol),
          scanned_at: new Date().toISOString(),
          trading_mode: profileId,
          timeframe: profile.signalTimeframe,
        });
      }
    }
    for (let i = 0; i < allRows.length; i += 50) {
      const { error } = await getSupabase().from('scanner_results').insert(allRows.slice(i, i+50));
      if (error) console.warn(`[scanner] Persist error: ${error.message}`);
    }

    // Persist all watchlists
    const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
    for (const [profileId, state] of Object.entries(profileStates)) {
      for (const [symbol, c] of state.watchlist.entries()) {
        const { error } = await getSupabase().from('watchlist_active').upsert({
          symbol: `${profileId}:${symbol}`,   // namespaced key — one row per profile per symbol
          score: c.score, reasons: c.signals, price: c.price,
          direction: c.direction, expires_at: expiry,
          created_at: new Date().toISOString(),
          trading_mode: profileId,
          timeframe: TRADING_PROFILES[profileId].signalTimeframe,
        }, { onConflict: 'symbol' });
        if (error) console.warn(`[scanner] Watchlist upsert error: ${error.message}`);
      }
    }
  } catch (err) {
    console.warn(`[scanner] Persist error (non-fatal): ${err.message}`);
  }

  console.log(`[scanner] Scan complete in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function schedule() {
  try { require('ws'); } catch {
    console.error('[scanner] FATAL: "ws" not installed. Run: npm install ws'); return;
  }

  console.log('[scanner] Market Scanner v3 — Multi-Profile (Intraday · Day Trade · Swing · Position)');
  console.log(`[scanner] Profiles  : ${ALL_PROFILE_IDS.map(id => `${TRADING_PROFILES[id].label} (${TRADING_PROFILES[id].candleInterval})`).join(' · ')}`);
  console.log(`[scanner] Interval  : every ${SCAN_INTERVAL_MS/60000} minutes`);
  console.log(`[scanner] Escalation: ${SIGNALS_REQUIRED} conditions within profile window`);

  runBackgroundScan().catch(err => console.error('[scanner] Startup scan error:', err.message));
  setInterval(() => runBackgroundScan().catch(e => console.error('[scanner] Scan error:', e.message)), SCAN_INTERVAL_MS);
}

module.exports = { schedule, runBackgroundScan, profileStates };
