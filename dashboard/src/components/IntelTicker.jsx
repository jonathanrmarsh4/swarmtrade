import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const BACKEND = 'https://swarmtrade-production.up.railway.app';

// ── Colour palette (matches dashboard) ──────────────────────────────────────
const C = {
  bg:       '#060d18',
  border:   '#0f2030',
  green:    '#4ade80',
  red:      '#f87171',
  amber:    '#f59e0b',
  blue:     '#60a5fa',
  purple:   '#a78bfa',
  teal:     '#2dd4bf',
  muted:    '#475569',
  dim:      '#1e3a52',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function fearColor(score) {
  if (score <= 25)  return C.red;
  if (score <= 45)  return C.amber;
  if (score <= 55)  return '#94a3b8';
  if (score <= 75)  return C.teal;
  return C.green;
}

function decisionColor(d) {
  if (d === 'trade') return C.green;
  if (d === 'veto')  return C.red;
  return C.amber;
}

function directionColor(d) {
  return d === 'long' ? C.green : C.red;
}

function fmt(price) {
  if (!price) return '—';
  const n = parseFloat(price);
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : n >= 1    ? n.toFixed(2)
       : n.toFixed(4);
}

// ── Ticker item ──────────────────────────────────────────────────────────────
function TickerItem({ item, onClick }) {
  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '0 22px',
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        borderRight: `1px solid ${C.dim}`,
      }}
    >
      <span style={{ fontSize: 11, opacity: 0.5 }}>{item.icon}</span>
      <span style={{ fontSize: 11, color: item.labelColor ?? C.muted, fontWeight: 600, letterSpacing: '0.04em' }}>
        {item.label}
      </span>
      <span style={{ fontSize: 11, color: item.valueColor ?? '#94a3b8', fontWeight: 700 }}>
        {item.value}
      </span>
      {item.sub && (
        <span style={{ fontSize: 10, color: C.muted }}>
          {item.sub}
        </span>
      )}
    </span>
  );
}

// ── Main ticker component ────────────────────────────────────────────────────
export default function IntelTicker({ onNavigate }) {
  const [items,      setItems]      = useState([]);
  const [prices,     setPrices]     = useState({});
  const [paused,     setPaused]     = useState(false);
  const trackRef  = useRef(null);
  const animRef   = useRef(null);
  const posRef    = useRef(0);

  // ── Fetch prices for trading universe ──────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    try {
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
      const results = await Promise.allSettled(
        symbols.map(s =>
          fetch(`${BACKEND}/proxy/price?symbol=${s}`)
            .then(r => r.json())
        )
      );
      const next = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value?.price) {
          next[symbols[i]] = parseFloat(r.value.price);
        }
      });
      setPrices(next);
    } catch { /* silent */ }
  }, []);

  // ── Build ticker items from live data ──────────────────────────────────────
  const buildItems = useCallback(async () => {
    const results = await Promise.allSettled([
      // Latest sentiment
      supabase.from('sentiment_cache')
        .select('fear_greed_value, fear_greed_label, score')
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),

      // Latest 8 deliberations
      supabase.from('deliberations')
        .select('asset, direction, final_decision, bull_score, bear_score, sentiment_score, created_at')
        .order('created_at', { ascending: false }).limit(8),

      // Recent news sentinel hits (market-moving only)
      supabase.from('news_sentinel_log')
        .select('headline, summary, created_at')
        .eq('is_market_moving', true)
        .order('created_at', { ascending: false }).limit(4),

      // Scanner latest escalations
      supabase.from('scanner_results')
        .select('symbol, score, direction, rsi, signals')
        .eq('escalated', true)
        .order('scanned_at', { ascending: false }).limit(4),
    ]);

    const safe = (r, fallback) => r.status === 'fulfilled' ? (r.value?.data ?? fallback) : fallback;

    const sentiment    = results[0].status === 'fulfilled' ? results[0].value?.data : null;
    const deliberations = safe(results[1], []);
    const news         = safe(results[2], []);
    const escalations  = safe(results[3], []);

    const next = [];

    // ── Sentiment ──
    if (sentiment) {
      const fgScore = sentiment.fear_greed_value ?? sentiment.score;
      next.push({
        id:         'sentiment',
        icon:       '◈',
        label:      'FEAR & GREED',
        value:      `${fgScore}/100`,
        sub:        sentiment.fear_greed_label,
        labelColor: fearColor(fgScore),
        valueColor: fearColor(fgScore),
      });
    }

    // ── Price tiles ──
    const PRICE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    PRICE_SYMBOLS.forEach(sym => {
      const price = prices[sym];
      if (price) {
        const base = sym.replace('USDT', '');
        next.push({
          id:         `price-${sym}`,
          icon:       '◆',
          label:      base,
          value:      `$${fmt(price)}`,
          labelColor: C.blue,
          valueColor: '#e2e8f4',
        });
      }
    });

    // ── Deliberation decisions ──
    deliberations.forEach(d => {
      if (!d.final_decision) return;
      const dec = d.final_decision.toUpperCase();
      next.push({
        id:         `delib-${d.created_at}`,
        icon:       d.final_decision === 'trade' ? '▶' : d.final_decision === 'veto' ? '✕' : '◉',
        label:      `${d.asset?.replace('USDT', '') ?? '?'}/${(d.direction ?? '?').toUpperCase()}`,
        value:      dec,
        sub:        `Bull:${d.bull_score ?? '?'} Bear:${d.bear_score ?? '?'}`,
        labelColor: directionColor(d.direction),
        valueColor: decisionColor(d.final_decision),
        tab:        'deliberations',
      });
    });

    // ── Scanner escalations ──
    escalations.forEach(e => {
      next.push({
        id:         `scan-${e.symbol}-${e.scanned_at}`,
        icon:       '⬆',
        label:      'ESCALATED',
        value:      e.symbol?.replace('USDT', '') ?? '?',
        sub:        `score ${e.score}/4 · RSI ${e.rsi?.toFixed(0)}`,
        labelColor: C.purple,
        valueColor: C.purple,
        tab:        'scanner',
      });
    });

    // ── News ──
    news.forEach(n => {
      const headline = n.headline ?? n.summary ?? 'Market news';
      const short = headline.length > 60 ? headline.slice(0, 60) + '…' : headline;
      next.push({
        id:         `news-${n.created_at}`,
        icon:       '📡',
        label:      'NEWS',
        value:      short,
        labelColor: C.amber,
        valueColor: '#e2e8f4',
      });
    });

    if (next.length > 0) setItems(next);
  }, [prices]);

  // ── Prices: fetch on mount + every 30s ──────────────────────────────────────
  useEffect(() => {
    fetchPrices();
    const t = setInterval(fetchPrices, 30_000);
    return () => clearInterval(t);
  }, [fetchPrices]);

  // ── Items: rebuild when prices change + every 60s ──────────────────────────
  useEffect(() => {
    buildItems();
    const t = setInterval(buildItems, 60_000);
    return () => clearInterval(t);
  }, [buildItems]);

  // ── Realtime: rebuild on new deliberation or sentiment ─────────────────────
  useEffect(() => {
    const ch = supabase.channel('ticker_realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'deliberations' }, buildItems)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sentiment_cache' }, buildItems)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'news_sentinel_log' }, buildItems)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [buildItems]);

  // ── Smooth scroll animation ─────────────────────────────────────────────────
  useEffect(() => {
    if (!trackRef.current || items.length === 0) return;

    const speed = 0.5; // px per frame — adjust to taste

    function tick() {
      if (!paused && trackRef.current) {
        posRef.current -= speed;
        const halfWidth = trackRef.current.scrollWidth / 2;
        if (Math.abs(posRef.current) >= halfWidth) {
          posRef.current = 0;
        }
        trackRef.current.style.transform = `translateX(${posRef.current}px)`;
      }
      animRef.current = requestAnimationFrame(tick);
    }

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [items, paused]);

  if (items.length === 0) return null;

  // Duplicate items for seamless loop
  const doubled = [...items, ...items];

  return (
    <div
      style={{
        background:  C.bg,
        borderBottom: `1px solid ${C.border}`,
        overflow:     'hidden',
        height:       32,
        display:      'flex',
        alignItems:   'center',
        position:     'relative',
        userSelect:   'none',
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Left fade */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 60,
        background: `linear-gradient(to right, ${C.bg}, transparent)`,
        zIndex: 2, pointerEvents: 'none',
      }} />

      {/* Scrolling track */}
      <div
        ref={trackRef}
        style={{
          display:    'flex',
          alignItems: 'center',
          willChange: 'transform',
          whiteSpace: 'nowrap',
        }}
      >
        {doubled.map((item, i) => (
          <TickerItem
            key={`${item.id}-${i}`}
            item={item}
            onClick={item.tab ? () => onNavigate?.(item.tab) : undefined}
          />
        ))}
      </div>

      {/* Right fade */}
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: 60,
        background: `linear-gradient(to left, ${C.bg}, transparent)`,
        zIndex: 2, pointerEvents: 'none',
      }} />

      {/* Pause indicator */}
      {paused && (
        <div style={{
          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
          fontSize: 9, color: C.muted, letterSpacing: '0.1em', zIndex: 3,
        }}>
          ⏸ PAUSED
        </div>
      )}
    </div>
  );
}
