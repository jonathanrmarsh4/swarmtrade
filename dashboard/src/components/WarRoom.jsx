import { useState, useEffect, useRef } from 'react';
import {
  Zap, FlaskConical, CheckCircle, XCircle, Swords, MessageSquare,
  Brain, Scale, Shield, Flag, TrendingUp, TrendingDown, BarChart,
  Globe, Activity, Clock, AlertTriangle
} from 'lucide-react';

const C = {
  bg: '#080f1a', surface: '#0d1829', surface2: '#112236',
  border: '#1a3045', borderGlow: '#1e4060',
  green: '#00ff88', red: '#ff4466', blue: '#4db8ff',
  amber: '#ffb340', purple: '#b388ff', teal: '#00e5cc',
  gray: '#4a6080', text: '#e8f4ff', textMuted: '#4a7090', textFaint: '#243040',
};

const EVENT_CONFIG = {
  signal_received:   { label: 'Signal Received',    Icon: Zap,           color: C.blue   },
  round1_start:      { label: 'Round 1 — Analysis', Icon: FlaskConical,  color: C.amber  },
  agent_complete:    { label: 'Agent Complete',      Icon: CheckCircle,   color: C.green  },
  agent_failed:      { label: 'Agent Failed',        Icon: XCircle,       color: C.red    },
  round2_start:      { label: 'Round 2 — Debate',    Icon: Swords,        color: C.amber  },
  round2_complete:   { label: 'Debate Complete',     Icon: MessageSquare, color: C.teal   },
  round3_start:      { label: 'Round 3 — Synthesis', Icon: Brain,         color: C.purple },
  round3_complete:   { label: 'Decision Made',       Icon: Scale,         color: C.blue   },
  risk_gate:         { label: 'Risk Gate',           Icon: Shield,        color: C.purple },
  deliberation_done: { label: 'Complete',            Icon: Flag,          color: C.green  },
};

const AGENT_META = {
  bull:         { Icon: TrendingUp,   label: 'Bull Agent',      color: C.green  },
  bear:         { Icon: TrendingDown, label: 'Bear Agent',      color: C.red    },
  quant:        { Icon: BarChart,    label: 'Quant Agent',     color: C.blue   },
  macro:        { Icon: Globe,        label: 'Macro Agent',     color: C.teal   },
  sentiment:    { Icon: Activity,     label: 'Sentiment Agent', color: C.amber  },
  risk:         { Icon: Shield,       label: 'Risk Gate',       color: C.purple },
  orchestrator: { Icon: Brain,        label: 'Orchestrator',    color: C.blue   },
};

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)   return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit' });
}

function SignalReceivedCard({ payload }) {
  const color = payload.direction === 'long' ? C.green : payload.direction === 'short' ? C.red : C.blue;
  const DirIcon = payload.direction === 'long' ? TrendingUp : TrendingDown;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <DirIcon size={16} color={color} />
      <span style={{ fontSize: 16, fontWeight: 900, color }}>{payload.asset}</span>
      <span style={{ fontSize: 11, fontWeight: 800, color, background: `${color}18`, border: `1px solid ${color}40`, borderRadius: 20, padding: '2px 10px' }}>
        {payload.direction?.toUpperCase()}
      </span>
      <span style={{ fontSize: 11, color: C.textMuted }}>{payload.timeframe} · {payload.signal_type}</span>
    </div>
  );
}

function Round1StartCard({ payload }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {(payload.agents ?? []).map(a => {
        const m = AGENT_META[a];
        return (
          <span key={a} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.textMuted, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 20, padding: '2px 9px' }}>
            {m && <m.Icon size={10} color={m.color} />} {a}
          </span>
        );
      })}
    </div>
  );
}

function AgentCompleteCard({ payload }) {
  const meta = AGENT_META[payload.agent] ?? { Icon: Activity, label: payload.agent, color: C.gray };
  const { Icon } = meta;
  const scoreColor = payload.score >= 60 ? C.green : payload.score <= 40 ? C.red : C.amber;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon size={15} color={meta.color} />
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{payload.label}</span>
        {payload.score != null && (
          <span style={{ fontSize: 18, fontWeight: 900, color: scoreColor }}>{payload.score}</span>
        )}
      </div>
      {payload.summary && (
        <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, borderLeft: `2px solid ${C.border}`, paddingLeft: 10, fontStyle: 'italic' }}>
          "{payload.summary}"
        </p>
      )}
      {payload.score != null && (
        <div style={{ height: 3, background: C.surface2, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${payload.score}%`, background: scoreColor, borderRadius: 2, transition: 'width 0.8s ease' }} />
        </div>
      )}
    </div>
  );
}

function AgentFailedCard({ payload }) {
  const meta = AGENT_META[payload.agent] ?? { Icon: AlertTriangle, color: C.red };
  const { Icon } = meta;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon size={14} color={C.red} />
      <span style={{ fontSize: 13, color: C.red }}>{payload.label} — using neutral default</span>
    </div>
  );
}

function DebateCard({ payload, type }) {
  if (type === 'round2_start') return <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>Bull and Bear reading each other's Round 1 analyses…</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {payload.bull_rebuttal && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: C.green, letterSpacing: '0.1em', marginBottom: 4 }}>
            <TrendingUp size={10} color={C.green} /> BULL REBUTTAL
          </div>
          <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>"{payload.bull_rebuttal}"</p>
        </div>
      )}
      {payload.bear_rebuttal && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: C.red, letterSpacing: '0.1em', marginBottom: 4 }}>
            <TrendingDown size={10} color={C.red} /> BEAR REBUTTAL
          </div>
          <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>"{payload.bear_rebuttal}"</p>
        </div>
      )}
    </div>
  );
}

function SynthesisCard({ payload, type }) {
  if (type === 'round3_start') return <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>Weighing all agent inputs and debate…</p>;
  const decisionColor = payload.decision === 'trade' ? C.green : payload.decision === 'hold' ? C.amber : C.red;
  const DecisionIcon  = payload.decision === 'trade' ? CheckCircle : payload.decision === 'hold' ? Clock : XCircle;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <DecisionIcon size={14} color={decisionColor} />
        <span style={{ fontSize: 13, fontWeight: 900, color: decisionColor, background: `${decisionColor}18`, border: `1px solid ${decisionColor}40`, borderRadius: 20, padding: '3px 12px' }}>
          {payload.decision?.toUpperCase()} — {payload.vote_result}
        </span>
      </div>
      {payload.reasoning && <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>"{payload.reasoning}"</p>}
    </div>
  );
}

function RiskGateCard({ payload }) {
  const color    = payload.approved ? C.green : C.red;
  const RiskIcon = payload.approved ? CheckCircle : XCircle;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Shield size={14} color={color} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 900, color, background: `${color}18`, border: `1px solid ${color}60`, borderRadius: 20, padding: '4px 14px', boxShadow: `0 0 12px ${color}30` }}>
          <RiskIcon size={12} color={color} /> {payload.approved ? 'APPROVED' : 'VETOED'}
        </span>
        {payload.approved && payload.position_size_pct > 0 && <span style={{ fontSize: 12, color: C.textMuted }}>Position: {payload.position_size_pct}%</span>}
      </div>
      {payload.reason && <p style={{ margin: 0, fontSize: 12, color: C.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>"{payload.reason}"</p>}
    </div>
  );
}

function DoneCard({ payload }) {
  const approved = payload.risk_approved;
  const color    = approved ? C.green : payload.decision === 'hold' ? C.amber : C.red;
  const DoneIcon = approved ? CheckCircle : payload.decision === 'hold' ? Clock : XCircle;
  const label    = approved ? 'TRADE APPROVED' : payload.decision === 'hold' ? 'HOLD' : 'VETOED';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <DoneIcon size={16} color={color} />
      <span style={{ fontSize: 15, fontWeight: 900, color, textShadow: `0 0 20px ${color}60` }}>{label}</span>
      {payload.elapsed_ms && <span style={{ fontSize: 11, color: C.textMuted }}>{(payload.elapsed_ms / 1000).toFixed(1)}s</span>}
    </div>
  );
}

function EventCard({ event, isNew }) {
  const config  = EVENT_CONFIG[event.event_type] ?? { label: event.event_type, Icon: Activity, color: C.gray };
  const payload = event.payload ?? {};
  const { Icon } = config;
  return (
    <div style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: `1px solid ${C.border}`, animation: isNew ? 'slideIn 0.4s ease' : 'none' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 32, flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${config.color}15`, border: `1px solid ${config.color}50`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: isNew ? `0 0 12px ${config.color}40` : 'none' }}>
          <Icon size={13} color={config.color} />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: config.color }}>{config.label}</span>
          <span style={{ fontSize: 10, color: C.textMuted }}>{timeAgo(event.created_at)}</span>
        </div>
        {event.event_type === 'signal_received'   && <SignalReceivedCard payload={payload} />}
        {event.event_type === 'round1_start'      && <Round1StartCard payload={payload} />}
        {event.event_type === 'agent_complete'    && <AgentCompleteCard payload={payload} />}
        {event.event_type === 'agent_failed'      && <AgentFailedCard payload={payload} />}
        {(event.event_type === 'round2_start' || event.event_type === 'round2_complete') && <DebateCard payload={payload} type={event.event_type} />}
        {(event.event_type === 'round3_start' || event.event_type === 'round3_complete') && <SynthesisCard payload={payload} type={event.event_type} />}
        {event.event_type === 'risk_gate'         && <RiskGateCard payload={payload} />}
        {event.event_type === 'deliberation_done' && <DoneCard payload={payload} />}
      </div>
    </div>
  );
}

function IdleState() {
  const [dots, setDots] = useState('');
  useEffect(() => { const i = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 600); return () => clearInterval(i); }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 20 }}>
      <div style={{ width: 48, height: 48, borderRadius: '50%', border: `2px solid ${C.borderGlow}`, borderTopColor: C.blue, animation: 'spin 2s linear infinite' }} />
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 14, color: C.text, fontWeight: 600 }}>Waiting for next signal{dots}</p>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: C.textMuted }}>Fire a test signal or wait for TradingView to trigger</p>
      </div>
    </div>
  );
}

function LiveIndicator({ active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: active ? C.green : C.textMuted, boxShadow: active ? `0 0 8px ${C.green}` : 'none', animation: active ? 'pulse 1.5s ease infinite' : 'none' }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: active ? C.green : C.textMuted }}>{active ? 'LIVE' : 'IDLE'}</span>
    </div>
  );
}

export default function WarRoom() {
  const [events,          setEvents]          = useState([]);
  const [newIds,          setNewIds]          = useState(new Set());
  const [isActive,        setIsActive]        = useState(false);
  const [currentSignalId, setCurrentSignalId] = useState(null);
  const [sb,              setSb]              = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => { import('../lib/supabase').then(m => setSb(m.supabase)); }, []);

  useEffect(() => {
    if (!sb) return;
    async function loadLatest() {
      const { data: latest } = await sb.from('deliberation_events').select('signal_id').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!latest?.signal_id) return;
      const { data } = await sb.from('deliberation_events').select('*').eq('signal_id', latest.signal_id).order('sequence', { ascending: true });
      if (data?.length) { setEvents(data); setCurrentSignalId(latest.signal_id); }
    }
    loadLatest();

    const channel = sb.channel('war_room_events')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'deliberation_events' }, ({ new: e }) => {
        setCurrentSignalId(prev => {
          if (prev && e.signal_id && e.signal_id !== prev) { setEvents([e]); }
          else { setEvents(p => p.find(x => x.id === e.id) ? p : [...p, e].sort((a, b) => a.sequence - b.sequence)); }
          return e.signal_id ?? prev;
        });
        setNewIds(prev => new Set([...prev, e.id]));
        setIsActive(true);
        setTimeout(() => setNewIds(prev => { const s = new Set(prev); s.delete(e.id); return s; }), 2000);
        if (e.event_type === 'deliberation_done') setTimeout(() => setIsActive(false), 5000);
      })
      .subscribe();

    return () => sb.removeChannel(channel);
  }, [sb]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [events.length]);

  return (
    <div style={{ background: C.bg, minHeight: '100%', fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse   { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Zap size={18} color={C.blue} /> War Room
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: C.textMuted }}>Live agent deliberation stream · Updates in real-time</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <LiveIndicator active={isActive} />
          <button onClick={() => setEvents([])} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, fontSize: 11, padding: '5px 10px', cursor: 'pointer' }}>
            Clear
          </button>
        </div>
      </div>
      <div style={{ padding: '0 24px', maxWidth: 800 }}>
        {events.length === 0 ? <IdleState /> : events.map(event => <EventCard key={event.id} event={event} isNew={newIds.has(event.id)} />)}
        <div ref={bottomRef} style={{ height: 40 }} />
      </div>
    </div>
  );
}
