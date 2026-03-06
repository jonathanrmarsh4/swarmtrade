import { useState, useEffect } from 'react';
import { supabase, useRealtimeTable } from './lib/supabase';
import Portfolio from './components/Portfolio';
import DeliberationLog from './components/DeliberationLog';
import SignalHistory from './components/SignalHistory';
import AgentReputation from './components/AgentReputation';
import TestSignal from './components/TestSignal';

// ─── Nav tabs ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'portfolio',     label: 'Portfolio',     icon: '📈' },
  { id: 'deliberations', label: 'Deliberations', icon: '🧠' },
  { id: 'signals',       label: 'Signals',       icon: '📡' },
  { id: 'agents',        label: 'Agents',        icon: '🤖' },
];

// ─── Connection probe ─────────────────────────────────────────────────────────

/**
 * Pings the signals table to verify Supabase connectivity.
 * Returns the row count (or an error string).
 */
function useSignalCount() {
  const [count, setCount] = useState(null);
  const [status, setStatus] = useState('connecting'); // 'connecting' | 'ok' | 'error'

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const { count: n, error } = await supabase
          .from('signals')
          .select('*', { count: 'exact', head: true });
        if (cancelled) return;
        if (error) throw error;
        setCount(n ?? 0);
        setStatus('ok');
      } catch (err) {
        if (cancelled) return;
        console.error('[supabase] connection probe failed:', err);
        setStatus('error');
      }
    }
    probe();
    return () => { cancelled = true; };
  }, []);

  return { count, status };
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function ConnectionStatus({ count, status }) {
  if (status === 'connecting') {
    return (
      <div className="flex items-center gap-2 text-[#60a5fa] text-xs font-semibold">
        <span className="spinner" />
        Connecting to Supabase…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-[#f87171] text-xs font-semibold">
        <span className="w-2 h-2 rounded-full bg-[#f87171]" />
        Supabase unreachable — check env vars
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[#4ade80] text-xs font-semibold">
      <span className="pulse-dot" />
      Supabase connected · {count.toLocaleString()} signal{count !== 1 ? 's' : ''} logged
    </div>
  );
}

// ─── System status bar ────────────────────────────────────────────────────────

function SystemBar({ signalCount, signalStatus }) {
  const now = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="flex items-center justify-between px-6 py-2 bg-[#0a1520] border-b border-[#1e3a52] text-xs text-[#64748b]">
      <div className="flex items-center gap-5">
        <ConnectionStatus count={signalCount} status={signalStatus} />
        <span className="hidden sm:block text-[#1e3a52]">|</span>
        <span className="hidden sm:block">
          Mode: <span className="text-[#f59e0b] font-semibold">PAPER</span>
        </span>
        <span className="hidden md:block text-[#1e3a52]">|</span>
        <span className="hidden md:block">
          Phase: <span className="text-[#60a5fa] font-semibold">2 — Swarm Active</span>
        </span>
      </div>
      <span className="tabular-nums">{now} AEST</span>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="px-6 py-4 border-b border-[#1e3a52] bg-[#0D1B2A]">
      <div className="flex items-center gap-3">
        {/* Logo mark */}
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#112233] border border-[#1e3a52] text-lg">
          ⚡
        </div>
        <div>
          <h1 className="text-base font-extrabold text-white tracking-tight leading-none">
            SwarmTrade
          </h1>
          <p className="text-[11px] font-semibold text-[#60a5fa] uppercase tracking-widest leading-none mt-0.5">
            Mission Control
          </p>
        </div>
      </div>
    </header>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

function Nav({ active, onSelect }) {
  return (
    <nav className="flex items-end gap-1 px-6 bg-[#0D1B2A] border-b border-[#1e3a52]">
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={[
              'flex items-center gap-2 px-4 py-3 text-xs font-semibold rounded-t-lg',
              'transition-colors duration-150 border-b-2 -mb-px',
              isActive
                ? 'text-white border-[#60a5fa] bg-[#112233]'
                : 'text-[#64748b] border-transparent hover:text-[#94a3b8] hover:bg-[#0f2236]',
            ].join(' ')}
          >
            <span className="text-sm">{tab.icon}</span>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState('portfolio');
  const { count: signalCount, status: signalStatus } = useSignalCount();

  return (
    <div className="flex flex-col min-h-screen bg-[#0D1B2A] font-sans">
      <Header />
      <SystemBar signalCount={signalCount} signalStatus={signalStatus} />
      <Nav active={activeTab} onSelect={setActiveTab} />

      <main className="flex-1 overflow-auto bg-grid">
        {activeTab === 'portfolio'     && <div style={{display:'flex',flexDirection:'column',gap:0}}><div style={{padding:'20px 24px 0'}}><TestSignal /></div><Portfolio /></div>}
        {activeTab === 'deliberations' && <DeliberationLog />}
        {activeTab === 'signals'       && <SignalHistory />}
        {activeTab === 'agents'        && <AgentReputation />}
      </main>
    </div>
  );
}
