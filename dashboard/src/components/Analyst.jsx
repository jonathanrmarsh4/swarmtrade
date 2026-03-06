// Analyst — floating AI chat panel with full SwarmTrade system context.
// Pulls live data from Supabase before each message to give the analyst
// real numbers to reason about. Calls Anthropic API directly from browser.
// Read-only: never modifies any data. Phase 2 will add config proposals.

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

// ── System prompt ─────────────────────────────────────────────────────────────
// Deep context about SwarmTrade architecture, config, and your role.

const SYSTEM_PROMPT = `You are the SwarmTrade Analyst — an expert trading system diagnostician embedded directly inside the SwarmTrade dashboard.

## YOUR ROLE
You help the operator (Jon) understand what the system is doing, why it's making certain decisions, and what might be causing it to miss opportunities or make poor calls. You are candid, specific, and always ground your analysis in the actual data provided.

You NEVER act or make changes autonomously. You ALWAYS explain your reasoning. When you suggest a change, you describe exactly what to change and why, and wait for Jon to approve before anything happens (Phase 2 feature).

## SWARMTRADE ARCHITECTURE

### Agent Swarm (6 agents + orchestrator)
- **Bull Agent** — finds long opportunities, scores 0–100 (high = strong bullish case)
- **Bear Agent** — finds risks and short setups, scores 0–100 (high = strong bearish case, shown inverted in UI)
- **Quant Agent** — mathematical edge: expected value, Sharpe ratio, win rate from historical trades. Returns SKIP if no history yet.
- **Macro Agent** — economic regime: risk-on / risk-off / neutral. Has veto-adjacent influence on Orchestrator.
- **Sentiment Agent** — two sub-agents:
  - Crowd Thermometer: Fear & Greed index + Reddit (Reddit currently blocked at datacenter IPs, non-fatal)
  - News Sentinel: CryptoPanic (404, falling back to CoinGecko trending) every 3 minutes
- **Risk Gate** — deterministic rules engine (NO LLM). Hard veto power. Rules:
  - Max 2% portfolio risk per trade
  - Max 3 concurrent open positions
  - Max 5% drawdown (paper), 3% (live)
  - Min 1.5× reward-to-risk ratio
  - Max 10% position size per trade
- **Orchestrator** — Claude Sonnet. Reads all agent outputs + debate, makes final decision: trade / hold / veto

### 3-Round Deliberation
1. **Round 1** — all 6 agents analyse in parallel (90s timeout, 3 retries with backoff)
2. **Round 2** — Bull and Bear read each other's Round 1 and write rebuttals
3. **Round 3** — Orchestrator synthesises everything → decision → Risk Gate final check

### Market Scanner (runs every hour at :00)
- Fetches top 100 USDT pairs by 24h volume from Binance
- Screens each with 4 filters on 1h candles (30 candles):
  - RSI < 35 (oversold) or > 65 (overbought)
  - Volume last candle > 2× 20-candle average
  - Price at 30-candle high or low (breakout)
  - MACD line crossed signal line on last candle
- Score 0–4 per asset. Score ≥ 2 → escalated to full swarm
- Max 10 escalations per scan (cost cap), 30s stagger between swarm calls
- All 100 results saved to scanner_results table

### TradingView Integration
- Webhooks fire signals to POST /webhook/tradingview
- Payload: asset, direction (long/short/close), timeframe, signal_type, secret
- Signal triggers immediate deliberation pipeline

### Tech Stack
- Backend: Node.js on Railway (swarmtrade-production.up.railway.app)
- Frontend: React/Vite/Tailwind on Railway (swarmtrade.up.railway.app)
- Database: Supabase (Postgres) — all data stored here
- Models: Claude Haiku for Sentiment sub-agents, Claude Sonnet for all others
- Paper trading: Binance Testnet (spot + futures)

### Known Issues (non-fatal)
- CryptoPanic API returns 404 → CoinGecko fallback active
- Reddit r/CryptoCurrency and r/Bitcoin return 403 (datacenter IP blocked)
- Quant agent returns SKIP/EV=0 until enough historical trades accumulate

## DATA YOU RECEIVE
Before each message, live data is pulled from Supabase and injected into the conversation. Use it to give specific, grounded answers. Reference actual numbers, assets, agent scores, and dates.

## TONE
- Concise and direct. No fluff.
- Use bullet points for lists, prose for explanations.
- When something is unclear from the data, say so rather than guessing.
- When you spot a pattern that could be a problem, flag it proactively.
- Format numbers clearly (e.g. "Bull: 72, Bear: 31 → contested but bullish lean").`;

// ── Data fetcher ──────────────────────────────────────────────────────────────
// Pulls a comprehensive snapshot from all tables before each message.

async function fetchSystemSnapshot() {
  const [
    { data: recentDelibs },
    { data: recentTrades },
    { data: agentRep },
    { data: latestScan },
    { data: sentimentCache },
    { data: reflections },
  ] = await Promise.all([
    supabase.from('deliberations').select('*').order('started_at', { ascending: false }).limit(20),
    supabase.from('trades').select('*').order('entry_time', { ascending: false }).limit(20),
    supabase.from('agent_reputation').select('*').order('agent_name'),
    supabase.from('scanner_runs').select('*').order('scanned_at', { ascending: false }).limit(1),
    supabase.from('sentiment_cache').select('*').order('fetched_at', { ascending: false }).limit(1),
    supabase.from('reflections').select('*').order('created_at', { ascending: false }).limit(3),
  ]);

  // Get scanner results from latest scan
  let scanResults = [];
  if (latestScan?.[0]?.id) {
    const { data } = await supabase
      .from('scanner_results')
      .select('*')
      .eq('scan_id', latestScan[0].id)
      .order('score', { ascending: false })
      .limit(20);
    scanResults = data ?? [];
  }

  // Compute summary stats
  const decisions = (recentDelibs ?? []).reduce((acc, d) => {
    acc[d.final_decision] = (acc[d.final_decision] ?? 0) + 1;
    return acc;
  }, {});

  const avgBull = recentDelibs?.length
    ? (recentDelibs.reduce((s, d) => s + (d.bull_score ?? 50), 0) / recentDelibs.length).toFixed(1)
    : null;
  const avgBear = recentDelibs?.length
    ? (recentDelibs.reduce((s, d) => s + (d.bear_score ?? 50), 0) / recentDelibs.length).toFixed(1)
    : null;

  const openTrades  = (recentTrades ?? []).filter(t => t.status === 'open');
  const closedTrades = (recentTrades ?? []).filter(t => t.status === 'closed' && t.pnl_pct != null);
  const winRate = closedTrades.length
    ? ((closedTrades.filter(t => t.pnl_pct > 0).length / closedTrades.length) * 100).toFixed(1)
    : null;

  return {
    timestamp: new Date().toISOString(),
    deliberations: {
      recent: recentDelibs ?? [],
      decisionBreakdown: decisions,
      avgBullScore: avgBull,
      avgBearScore: avgBear,
      total: recentDelibs?.length ?? 0,
    },
    trades: {
      open: openTrades,
      recentClosed: closedTrades.slice(0, 10),
      winRate,
      totalClosed: closedTrades.length,
    },
    agentReputation: agentRep ?? [],
    scanner: {
      latestRun: latestScan?.[0] ?? null,
      topResults: scanResults,
      escalated: scanResults.filter(r => r.escalated),
    },
    sentiment: sentimentCache?.[0] ?? null,
    reflections: reflections ?? [],
  };
}

// ── UI constants ──────────────────────────────────────────────────────────────

const C = {
  bg:         '#070e1a',
  surface:    '#0b1829',
  surface2:   '#0f2035',
  border:     '#182e46',
  accent:     '#00c8ff',
  accentGlow: '#00c8ff30',
  green:      '#00e87a',
  red:        '#ff4060',
  amber:      '#ffb020',
  text:       '#ddeeff',
  textMuted:  '#3d6080',
  textSoft:   '#7aa0c0',
};

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user';

  // Simple markdown-ish renderer: bold, code blocks, bullets
  function renderContent(text) {
    const lines = text.split('\n');
    return lines.map((line, i) => {
      // Code block (inline)
      line = line.replace(/`([^`]+)`/g, (_, code) =>
        `<code style="font-family:monospace;font-size:11px;background:#0a1e32;border:1px solid #1a3a52;border-radius:3px;padding:1px 5px;color:#60d0ff">${code}</code>`
      );
      // Bold
      line = line.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#ddeeff;font-weight:700">$1</strong>');
      // Bullet
      if (line.trim().startsWith('- ') || line.trim().startsWith('• ')) {
        return <div key={i} style={{ display: 'flex', gap: 8, marginTop: 3 }}>
          <span style={{ color: C.accent, flexShrink: 0, marginTop: 1 }}>›</span>
          <span dangerouslySetInnerHTML={{ __html: line.replace(/^[\s\-•]+/, '') }} />
        </div>;
      }
      // Headers
      if (line.startsWith('## ')) {
        return <div key={i} style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.accent, marginTop: 12, marginBottom: 4 }}
          dangerouslySetInnerHTML={{ __html: line.replace('## ', '') }} />;
      }
      if (line.startsWith('### ')) {
        return <div key={i} style={{ fontSize: 11, fontWeight: 700, color: C.textSoft, marginTop: 8, marginBottom: 2 }}
          dangerouslySetInnerHTML={{ __html: line.replace('### ', '') }} />;
      }
      if (line.trim() === '') return <div key={i} style={{ height: 6 }} />;
      return <div key={i} dangerouslySetInnerHTML={{ __html: line }} />;
    });
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
      animation: 'fadeUp 0.25s ease',
    }}>
      {!isUser && (
        <div style={{
          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, ${C.accent}30, ${C.accent}10)`,
          border: `1px solid ${C.accent}50`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, marginRight: 8, marginTop: 2,
          boxShadow: `0 0 10px ${C.accentGlow}`,
        }}>
          ◈
        </div>
      )}
      <div style={{
        maxWidth: '82%',
        padding: '10px 14px',
        borderRadius: isUser ? '14px 14px 4px 14px' : '4px 14px 14px 14px',
        background: isUser
          ? `linear-gradient(135deg, ${C.accent}18, ${C.accent}08)`
          : C.surface2,
        border: `1px solid ${isUser ? C.accent + '40' : C.border}`,
        fontSize: 12.5,
        lineHeight: 1.65,
        color: C.text,
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}>
        {msg.role === 'assistant' && msg.content === '...'
          ? <ThinkingDots />
          : renderContent(msg.content)
        }
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: C.accent,
          animation: `blink 1.2s ease ${i * 0.2}s infinite`,
          opacity: 0.6,
        }} />
      ))}
    </div>
  );
}

// ── Suggested prompts ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Why is the system vetoing so many signals?",
  "Which agent has been most accurate lately?",
  "What assets is the scanner finding opportunities in?",
  "Why might we be missing good setups?",
  "Analyse the last 10 deliberations",
  "What's the current market sentiment reading?",
];

// ── Main component ────────────────────────────────────────────────────────────

export default function Analyst() {
  const [open,     setOpen]     = useState(false);
  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [pulse,    setPulse]    = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  // Pulse the button when closed to hint it's available
  useEffect(() => {
    if (open) return;
    const t = setInterval(() => setPulse(p => !p), 3000);
    return () => clearInterval(t);
  }, [open]);

  const sendMessage = useCallback(async (text) => {
    const userText = text ?? input.trim();
    if (!userText || loading) return;
    setInput('');
    setLoading(true);

    const userMsg = { role: 'user', content: userText };
    const thinking = { role: 'assistant', content: '...' };
    setMessages(prev => [...prev, userMsg, thinking]);

    try {
      // Fetch live system snapshot
      const snapshot = await fetchSystemSnapshot();

      // Build context injection
      const contextBlock = `
## LIVE SYSTEM DATA (as of ${new Date(snapshot.timestamp).toLocaleString('en-AU', { timeZone: 'Australia/Perth' })} AWST)

### Recent Deliberations (last ${snapshot.deliberations.total})
Decision breakdown: ${JSON.stringify(snapshot.deliberations.decisionBreakdown)}
Avg Bull score: ${snapshot.deliberations.avgBullScore} | Avg Bear score: ${snapshot.deliberations.avgBearScore}
${snapshot.deliberations.recent.slice(0, 10).map(d =>
  `- ${d.asset ?? '?'} ${d.direction ?? ''} | ${d.final_decision?.toUpperCase()} | Bull:${d.bull_score} Bear:${d.bear_score} Sentiment:${d.sentiment_score} | Macro:${d.macro_regime} | Risk:${d.risk_approved ? 'approved' : 'vetoed'} | ${d.started_at?.slice(0,16)}`
).join('\n')}

### Trade Performance
Open positions: ${snapshot.trades.open.length}
${snapshot.trades.open.map(t => `  - ${t.asset} ${t.direction} entry:$${t.entry_price} size:${t.position_size_pct}%`).join('\n')}
Closed trades: ${snapshot.trades.totalClosed} | Win rate: ${snapshot.trades.winRate ?? 'N/A'}%
${snapshot.trades.recentClosed.slice(0,5).map(t =>
  `- ${t.asset} ${t.direction} P&L:${t.pnl_pct > 0 ? '+' : ''}${t.pnl_pct?.toFixed(2)}%`
).join('\n')}

### Agent Reputation
${snapshot.agentReputation.map(a =>
  `- ${a.agent_name}: accuracy=${a.accuracy_pct?.toFixed(1)}% wins=${a.wins} losses=${a.losses} calls=${a.total_calls}`
).join('\n')}

### Latest Scanner Run
${snapshot.scanner.latestRun
  ? `Ran: ${new Date(snapshot.scanner.latestRun.scanned_at).toLocaleString('en-AU', { timeZone: 'Australia/Perth' })} AWST
Assets screened: ${snapshot.scanner.latestRun.total_assets} | Escalated: ${snapshot.scanner.latestRun.escalated} | Duration: ${(snapshot.scanner.latestRun.duration_ms/1000).toFixed(1)}s
Top candidates:
${snapshot.scanner.topResults.slice(0,10).map(r =>
  `  ${r.symbol} score:${r.score}/4 ${r.direction} RSI:${r.rsi} vol:${r.volume_ratio}× ${r.escalated ? '→ SWARM' : ''} signals:[${r.signals?.join(', ')}]`
).join('\n')}`
  : 'No scan data yet'}

### Current Sentiment
${snapshot.sentiment
  ? `Fear & Greed: ${snapshot.sentiment.fear_greed_score}/100 (${snapshot.sentiment.fear_greed_label}) | Score: ${snapshot.sentiment.score}/100 | ${snapshot.sentiment.summary}`
  : 'No sentiment data'}

### Recent Reflections (nightly agent self-assessment)
${snapshot.reflections.slice(0,2).map(r => `- ${r.created_at?.slice(0,10)}: ${r.summary ?? r.content?.slice(0,200)}`).join('\n') || 'None yet'}
`;

      // Build message history for API (exclude thinking placeholder)
      const history = messages
        .filter(m => m.content !== '...')
        .map(m => ({ role: m.role, content: m.content }));

      const BACKEND = 'https://swarmtrade-production.up.railway.app';
      const response = await fetch(`${BACKEND}/analyst/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: SYSTEM_PROMPT,
          messages: [
            ...history,
            { role: 'user', content: contextBlock + '\n\n---\n\nUser question: ' + userText },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${response.status}`);
      }

      const data = await response.json();
      const reply = data.content ?? 'Sorry, I had trouble generating a response.';

      setMessages(prev => [
        ...prev.filter(m => m.content !== '...'),
        { role: 'assistant', content: reply },
      ]);
    } catch (err) {
      setMessages(prev => [
        ...prev.filter(m => m.content !== '...'),
        { role: 'assistant', content: `⚠️ Error: ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const isFirstMessage = messages.length === 0;

  return (
    <>
      <style>{`
        @keyframes fadeUp  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes blink   { 0%,80%,100% { opacity:0.2; } 40% { opacity:1; } }
        @keyframes glow    { 0%,100% { box-shadow: 0 0 16px ${C.accentGlow}; } 50% { box-shadow: 0 0 28px ${C.accent}50; } }
        @keyframes slideUp { from { opacity:0; transform:translateY(20px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
      `}</style>

      {/* Floating button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed',
          bottom: 28,
          right: 28,
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: open
            ? C.surface2
            : `linear-gradient(135deg, ${C.accent}cc, ${C.accent}88)`,
          border: `1.5px solid ${C.accent}${open ? '50' : '90'}`,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: open ? 18 : 20,
          color: open ? C.textMuted : '#000',
          fontWeight: 800,
          zIndex: 9999,
          transition: 'all 0.2s ease',
          animation: !open ? 'glow 3s ease infinite' : 'none',
          boxShadow: open ? 'none' : `0 4px 20px ${C.accent}40`,
        }}
        title="SwarmTrade Analyst"
      >
        {open ? '✕' : '◈'}
      </button>

      {/* Chat panel */}
      {open && (
        <div style={{
          position: 'fixed',
          bottom: 92,
          right: 28,
          width: 420,
          height: 580,
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 9998,
          animation: 'slideUp 0.25s ease',
          boxShadow: `0 20px 60px #000a, 0 0 0 1px ${C.accent}10`,
          overflow: 'hidden',
          fontFamily: "'DM Sans', system-ui, sans-serif",
        }}>

          {/* Header */}
          <div style={{
            padding: '14px 18px',
            background: C.surface,
            borderBottom: `1px solid ${C.border}`,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: `linear-gradient(135deg, ${C.accent}25, ${C.accent}08)`,
              border: `1px solid ${C.accent}50`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, color: C.accent,
              boxShadow: `0 0 14px ${C.accentGlow}`,
            }}>◈</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>SwarmTrade Analyst</div>
              <div style={{ fontSize: 10, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.green, display: 'inline-block', boxShadow: `0 0 5px ${C.green}` }} />
                Live data · Read-only · Full system context
              </div>
            </div>
            {messages.length > 0 && (
              <button
                onClick={() => setMessages([])}
                style={{
                  marginLeft: 'auto', background: 'transparent',
                  border: `1px solid ${C.border}`, borderRadius: 6,
                  color: C.textMuted, fontSize: 10, padding: '3px 8px', cursor: 'pointer',
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Messages */}
          <div style={{
            flex: 1, overflowY: 'auto', padding: '16px 14px 8px',
            display: 'flex', flexDirection: 'column',
          }}>
            {isFirstMessage ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                <div style={{ textAlign: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>◈</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>System Analyst</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, lineHeight: 1.6 }}>
                    I have full context of your SwarmTrade setup.<br/>
                    Ask me anything about performance, signals, or config.
                  </div>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textMuted, textAlign: 'center', marginTop: 4 }}>
                  Suggested
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      style={{
                        background: C.surface2,
                        border: `1px solid ${C.border}`,
                        borderRadius: 8,
                        padding: '9px 12px',
                        color: C.textSoft,
                        fontSize: 12,
                        textAlign: 'left',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        fontFamily: "'DM Sans', system-ui, sans-serif",
                      }}
                      onMouseEnter={e => { e.target.style.borderColor = C.accent + '60'; e.target.style.color = C.text; }}
                      onMouseLeave={e => { e.target.style.borderColor = C.border; e.target.style.color = C.textSoft; }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 12px',
            borderTop: `1px solid ${C.border}`,
            background: C.surface,
            display: 'flex', gap: 8, alignItems: 'flex-end',
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about your system…"
              disabled={loading}
              rows={1}
              style={{
                flex: 1,
                background: C.surface2,
                border: `1px solid ${input ? C.accent + '50' : C.border}`,
                borderRadius: 10,
                color: C.text,
                fontSize: 12.5,
                padding: '9px 12px',
                resize: 'none',
                outline: 'none',
                fontFamily: "'DM Sans', system-ui, sans-serif",
                lineHeight: 1.5,
                maxHeight: 100,
                overflow: 'auto',
                transition: 'border-color 0.15s ease',
              }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              style={{
                width: 36, height: 36,
                borderRadius: 10,
                background: loading || !input.trim()
                  ? C.surface2
                  : `linear-gradient(135deg, ${C.accent}cc, ${C.accent}88)`,
                border: `1px solid ${loading || !input.trim() ? C.border : C.accent + '60'}`,
                color: loading || !input.trim() ? C.textMuted : '#000',
                fontSize: 15,
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s ease',
                flexShrink: 0,
              }}
            >
              {loading ? '◌' : '↑'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
