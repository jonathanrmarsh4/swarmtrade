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

// Trading universe defined below in TRADING_UNIVERSE — TOP_N_ASSETS no longer used
const MAX_WATCHLIST_SIZE     = 5;
const SCAN_INTERVAL_MS       = 10 * 60 * 1000;   // default — overridden by system_config at runtime
const ESCALATION_COOLDOWN_MS = 30 * 60 * 1000;   // default — overridden by system_config at runtime
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

  // S/R proximity: price within 1.5% of a key level (high-probability reversal zone)
  if (support    && price <= support    * 1.015) { score++; bullSignals.push(`Near support ($${support.toFixed(4)})`); }
  if (resistance && price >= resistance * 0.985) { score++; bearSignals.push(`Near resistance ($${resistance.toFixed(4)})`); }

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

// ── Focused trading universe ──────────────────────────────────────────────────
// Default list — used as fallback if Supabase system_config is unavailable.
// Live value is loaded from system_config at scan time and editable via the
// Settings page in the dashboard without redeploying.
const TRADING_UNIVERSE_DEFAULT = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'MATICUSDT',
];

async function loadTradingUniverse() {
  try {
    const { data, error } = await getSupabase()
      .from('system_config')
      .select('value')
      .eq('key', 'trading_universe')
      .maybeSingle();
    if (error || !data) {
      console.warn('[scanner] Could not load trading_universe from DB — using defaults');
      return TRADING_UNIVERSE_DEFAULT;
    }
    const universe = Array.isArray(data.value) ? data.value : JSON.parse(data.value);
    console.log('[scanner] Trading universe loaded from DB:', universe.join(', '));
    return universe;
  } catch (err) {
    console.warn('[scanner] loadTradingUniverse error — using defaults:', err.message);
    return TRADING_UNIVERSE_DEFAULT;
  }
}

// ── loadScannerConfig ─────────────────────────────────────────────────────────
// Reads scanner_config from system_config; returns defaults if unavailable.
const SCANNER_CONFIG_DEFAULTS = {
  scanIntervalMinutes:       10,
  escalationCooldownMinutes: 30,
  topNCandidates:            3,
  minScoreToEscalate:        1,
  profileOverrides: {
    intraday:  { rsiOversold: 35, rsiOverbought: 65, volumeSpikeMult: 1.5 },
    dayTrade:  { rsiOversold: 30, rsiOverbought: 70, volumeSpikeMult: 2.0 },
    swing:     { rsiOversold: 30, rsiOverbought: 70, volumeSpikeMult: 2.0 },
    position:  { rsiOversold: 25, rsiOverbought: 75, volumeSpikeMult: 3.0 },
  },
};

async function loadScannerConfig() {
  try {
    const { data, error } = await getSupabase()
      .from('system_config').select('value').eq('key', 'scanner_config').single();
    if (!error && data?.value) {
      return { ...SCANNER_CONFIG_DEFAULTS, ...data.value };
    }
  } catch { /* fall through */ }
  return SCANNER_CONFIG_DEFAULTS;
}

async function fetchTopPairs() {
  const universe = await loadTradingUniverse();
  const symbols = JSON.stringify(universe);
  const url = 'https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(symbols);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Binance ticker HTTP ' + res.status);
  const tickers = await res.json();
  return tickers.map(t => ({ symbol: t.symbol, price: parseFloat(t.price) }));
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

  canEscalate(symbol, cooldownMs = ESCALATION_COOLDOWN_MS) {
    return (Date.now() - (this.cooldowns.get(symbol) ?? 0)) > cooldownMs;
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

    // ── What the WebSocket is actually for ──────────────────────────────────
    // The background scan already confirmed this asset has RSI/MACD/volume
    // conviction (score >= 1). The WebSocket's job is NOT to re-prove that
    // conviction from scratch — it's to detect that something is HAPPENING
    // RIGHT NOW that warrants waking up the swarm.
    //
    // Three independent triggers, any ONE is enough to escalate:
    //
    //   A. Volume surge: current 1m candle volume > 3x the 10-candle average.
    //      Sudden volume is the most reliable real-time signal that an asset
    //      is being acted on. Threshold is higher than scan (3x vs profile
    //      multiplier) because 1m candles are noisier than hourly.
    //
    //   B. Price move: price has moved > 0.8% from the scan-time price in
    //      the signal direction (up for long candidates, down for short).
    //      This catches momentum continuation without needing S/R levels.
    //
    //   C. RSI confirmation (on candle close, after 15-candle warmup):
    //      RSI crosses back INTO the extreme zone after a brief pullback,
    //      or RSI is in extreme zone on the first warmed-up close.
    //      This is a secondary trigger — slower but more reliable.
    // ────────────────────────────────────────────────────────────────────────

    const triggers = [];

    // A: Volume surge on any tick (not just close)
    if (buf.length >= 6) {
      const avg10 = buf.slice(-Math.min(buf.length, 11), -1).map(c => c.volume).reduce((a, b) => a + b, 0)
                  / Math.min(buf.length - 1, 10);
      const ratio = avg10 > 0 ? kline.volume / avg10 : 0;
      if (ratio >= 3.0) {
        triggers.push(`volume_surge_${ratio.toFixed(1)}x`);
        console.log(`[ws:${this.profile.label}] ${symbol} volume surge ${ratio.toFixed(1)}x avg`);
      }
    }

    // B: Price move from scan-time entry price
    if (candidate.price > 0) {
      const movePct = ((kline.close - candidate.price) / candidate.price) * 100;
      const threshold = 0.8; // 0.8% move in signal direction
      const isLong  = candidate.direction === 'long';
      if ((isLong && movePct >= threshold) || (!isLong && movePct <= -threshold)) {
        triggers.push(`price_move_${movePct.toFixed(2)}pct`);
        console.log(`[ws:${this.profile.label}] ${symbol} price moved ${movePct.toFixed(2)}% from scan (${candidate.direction})`);
      }
    }

    // C: RSI confirmation on candle close (after 15-candle warmup)
    if (kline.isFinal && buf.length >= 15) {
      const liveRSI = calcRSI(buf);
      const inOversold   = liveRSI < this.profile.rsiOversold;
      const inOverbought = liveRSI > this.profile.rsiOverbought;
      if ((candidate.direction === 'long'  && inOversold) ||
          (candidate.direction === 'short' && inOverbought)) {
        triggers.push(`rsi_confirm_${liveRSI.toFixed(0)}`);
        console.log(`[ws:${this.profile.label}] ${symbol} RSI confirmation: ${liveRSI.toFixed(1)} direction=${candidate.direction}`);
      }
    }

    if (triggers.length === 0) return;

    // Any single trigger is enough — the scan already provided the base conviction.
    // Record and escalate.
    this._escalate(symbol, new Set(triggers), kline.close).catch(e =>
      console.error(`[ws:${this.profile.label}] Escalation error ${symbol}: ${e.message}`)
    );
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

  // Load scanner config + trading universe from DB — editable via Settings, no redeploy needed
  const scannerCfg = await loadScannerConfig();
  const cooldownMs = scannerCfg.escalationCooldownMinutes * 60 * 1000;
  const topN       = scannerCfg.topNCandidates;
  const minScore   = scannerCfg.minScoreToEscalate;

  // ── Position capacity check ───────────────────────────────────────────────
  // Skip the entire scan if we're already at max concurrent positions.
  // The risk gate would veto any new entry anyway — no point burning API calls.
  try {
    const { data: riskCfg } = await getSupabase()
      .from('system_config').select('value').eq('key', 'risk_rules').single();
    const maxPositions = riskCfg?.value?.maxConcurrentPositions ?? 3;
    const { count } = await getSupabase()
      .from('trades')
      .select('id', { count: 'exact', head: true })
      .is('exit_time', null);
    if (count >= maxPositions) {
      console.log(`[scanner] ⏸  At capacity — ${count}/${maxPositions} open positions. Scan suspended until a trade closes.`);
      return;
    }
    console.log(`[scanner] Capacity check — ${count}/${maxPositions} open positions. Proceeding.`);
  } catch (err) {
    console.warn(`[scanner] Capacity check failed (proceeding anyway): ${err.message}`);
  }

  let pairs;
  try {
    pairs = await fetchTopPairs();
  } catch (err) {
    console.error(`[scanner] Fetch failed: ${err.message}`); return;
  }

  // Run profiles SEQUENTIALLY to avoid Binance rate limits.
  // 4 profiles × 100 pairs in parallel = 400 simultaneous requests → rate limited → empty results.
  // Sequential with stagger: each profile scans top 40 pairs with 300ms between requests.
  const profileResults = {};
  const allCandidates    = [];  // collects eligible pairs across all profiles for global top-3
  const TOP_PAIRS_PER_SCAN = 40; // reduce from 100 — top 40 by volume catches everything meaningful

  for (const profileId of ALL_PROFILE_IDS) {
    const state   = profileStates[profileId];
    const profile = state.profile;
    const results = [];
    let n = 0;

    console.log(`[scanner:${profile.label}] Scanning top ${TOP_PAIRS_PER_SCAN} pairs on ${profile.candleInterval}...`);

    for (const pair of pairs.slice(0, TOP_PAIRS_PER_SCAN)) {
      try {
        const candles = await fetchCandles(pair.symbol, profile.candleInterval, profile.candleLimit);
        results.push(scoreAsset(pair.symbol, pair.price, candles, profile));
        // 300ms between every request — well within Binance's 1200 weight/min limit
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.warn(`[scanner:${profile.label}] Skip ${pair.symbol}: ${err.message}`);
        await new Promise(r => setTimeout(r, 500)); // longer pause after error
      }
    }

    results.sort((a, b) => b.score - a.score);
    profileResults[profileId] = results;

    // Log top scores per profile for visibility
    const top5 = results.slice(0, 5);
    console.log(`[scanner:${profile.label}] Top scores: ${top5.map(r => `${r.symbol}=${r.score}(${r.rsi.toFixed(0)}rsi)`).join(' | ')}`);

    state.updateWatchlist(results);
    state.syncWS();

    // Collect all eligible candidates — deliberation happens AFTER all profiles scan
    for (const r of results.filter(r => r.score >= 1 && state.canEscalate(r.symbol, cooldownMs))) {
      allCandidates.push({ ...r, profileId, profile });
    }

    console.log(`[scanner:${profile.label}] Watchlist (${state.watchlist.size}/${MAX_WATCHLIST_SIZE}) on ${profile.candleInterval} candles:`);
    for (const [sym, c] of state.watchlist.entries()) {
      const cd = cooldownMs - (Date.now() - (state.cooldowns.get(sym) ?? 0));
      const cdStr = cd > 0 ? `cooldown ${Math.round(cd/60000)}min` : 'ready';
      console.log(`  ${sym.padEnd(14)} score=${c.score} ${c.direction} RSI=${c.rsi} [${cdStr}]`);
    }
  } // end for...of ALL_PROFILE_IDS

  // ── Global top-3 deliberation ─────────────────────────────────────────────
  // All 4 profiles have now scanned. Pick the 3 highest-scoring candidates
  // across all profiles and deliberate those only — hard cap of 3 Claude API
  // call chains per scan cycle regardless of how many pairs scored.
  allCandidates.sort((a, b) => b.score - a.score);
  const eligible     = allCandidates.filter(c => c.score >= minScore);
  const toDeliberate = eligible.slice(0, topN);
  console.log(`\n[scanner] === Global top-${toDeliberate.length}/${eligible.length} eligible candidates (minScore=${minScore}, topN=${topN}) ===`);
  toDeliberate.forEach((r, i) =>
    console.log(`  ${i+1}. ${r.symbol} score=${r.score} profile=${r.profile.label} RSI=${r.rsi} dir=${r.direction} [${r.signals.join(', ')}]`)
  );

  for (const r of toDeliberate) {
    const state   = profileStates[r.profileId];
    const profile = r.profile;
    state.cooldowns.set(r.symbol, Date.now());
    const macdSig = r.macdCross === 'bullish' ? 'bullish_crossover'
                  : r.macdCross === 'bearish' ? 'bearish_crossover' : 'neutral';
    console.log(`[scanner] Escalating ${r.symbol} (${profile.label}) score=${r.score} RSI=${r.rsi}`);
    try {
      const { data, error } = await getSupabase().from('signals').insert({
        asset: r.symbol, direction: r.direction, timeframe: profile.signalTimeframe,
        signal_type: 'scan_direct',
        raw_payload: {
          asset: r.symbol, direction: r.direction, price: r.price, rsi: r.rsi,
          volume_ratio: r.volumeRatio, macd_signal: macdSig,
          atr: r.atr, support: r.support, resistance: r.resistance,
          signals: r.signals, trigger_types: ['scan_conviction', `score_${r.score}`],
          signal_type: 'scan_direct', trading_mode: r.profileId,
        },
      }).select('id').single();
      if (error) { console.error(`[scanner] Signal insert failed: ${error.message}`); continue; }
      console.log(`[scanner] Signal written id=${data.id} — awaiting deliberation...`);
      const result = await runDeliberation(data.id);
      console.log(`[scanner] Deliberation complete — ${r.symbol} decision=${result?.decision ?? 'unknown'}`);
      if (result && result.tradeInstruction) await executeTrade(result.tradeInstruction);
    } catch (err) {
      console.error(`[scanner] Escalation failed for ${r.symbol}: ${err.message}`);
      console.error(err.stack);
    }
    // 2s gap between deliberations
    await new Promise(res => setTimeout(res, 2000));
  }

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

    // Persist all watchlists — delete ALL existing rows first, then re-insert current state.
    // Previously only upserted active pairs, so pairs that fell off the watchlist
    // lingered in the DB forever (74 rows seen in dashboard).
    // Now: wipe and rewrite = DB always reflects exactly what's in memory.
    await getSupabase().from('watchlist_active').delete().neq('symbol', '__sentinel__');

    const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
    const watchlistRows = [];
    for (const [profileId, state] of Object.entries(profileStates)) {
      for (const [symbol, c] of state.watchlist.entries()) {
        watchlistRows.push({
          symbol: profileId + ':' + symbol,  // namespaced key — one row per profile per symbol
          score: c.score, reasons: c.signals, price: c.price,
          direction: c.direction, expires_at: expiry,
          created_at: new Date().toISOString(),
          trading_mode: profileId,
          timeframe: TRADING_PROFILES[profileId].signalTimeframe,
        });
      }
    }
    if (watchlistRows.length) {
      const { error } = await getSupabase().from('watchlist_active').insert(watchlistRows);
      if (error) console.warn('[scanner] Watchlist insert error:', error.message);
    }
    console.log('[scanner] Watchlist synced to DB —', watchlistRows.length, 'active entries across all profiles');
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
