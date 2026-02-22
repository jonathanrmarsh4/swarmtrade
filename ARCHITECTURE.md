# AI Trading Swarm — Architecture

## Overview

A multi-agent AI committee system for autonomous cryptocurrency trading. Six specialised AI agents (Bull, Bear, Quant, Macro, Sentiment, Risk Management) deliberate on incoming trade signals and report to a central Orchestrator agent that synthesises their analysis into a final trade decision. The system runs in paper trading mode during validation and transitions to live trading with capped capital once performance criteria are met.

**Core hypothesis:** A committee of specialised AI agents, each focused on a single analytical lens, will produce higher-quality trade decisions than any single model attempting to hold all perspectives simultaneously.

---

## System Layers

```
LAYER 1 — SIGNAL INGESTION
  TradingView (Pine Script alerts via webhook or email)
  CryptoPanic API | X.com curated watchlist | Fear & Greed Index | Glassnode on-chain

LAYER 2 — AGENT DELIBERATION
  Bull | Bear | Quant | Macro | Sentiment | Risk Management | Orchestrator

LAYER 3 — EXECUTION & PERSISTENCE
  OctoBot (paper trading engine) → Crypto exchange testnet
  Supabase (all state, deliberations, trade history, agent reputation)
```

---

## Tech Stack

| Component | Technology | Notes |
|---|---|---|
| Hosting | Railway | Docker-based. GitHub integration. All services live here. |
| Database | Supabase (PostgreSQL) | Real-time subscriptions power the dashboard. |
| Trade execution | OctoBot | Open source. Paper trading mode. TradingView webhook integration. |
| Signal source | TradingView | Pine Script alerts via email (free) or webhook (Essential plan). |
| Agent LLMs | Anthropic API | Sonnet for Orchestrator + Macro. Haiku for Bull, Bear, Sentiment. |
| Risk Agent | Deterministic rules engine | NO LLM. Rules must be exact and predictable. Zero hallucination tolerance. |
| Exchange | Binance or Coinbase testnet | Zero real capital in Phase 1. |
| Dashboard | React | Hosted on Railway. Real-time via Supabase subscriptions. |
| Language | Node.js | Agent services, Orchestrator, webhook handlers. |

---

## Folder Structure

```
/
├── ARCHITECTURE.md
├── CLAUDE.md
├── README.md
├── docker-compose.yml
│
├── /octobot
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── user_data/
│       └── config/          — OctoBot config files (paper trading mode enforced here)
│
├── /agents
│   ├── bull/
│   │   ├── index.js         — Bull Agent service
│   │   └── prompt.js        — Bull Agent system prompt
│   ├── bear/
│   ├── quant/
│   ├── macro/
│   ├── sentiment/
│   │   ├── index.js
│   │   ├── news-sentinel.js — Reactive: CryptoPanic + X.com watchlist
│   │   └── crowd-thermometer.js — Ambient: Fear & Greed + Reddit
│   └── risk/
│       ├── index.js         — Deterministic rules engine. No LLM.
│       └── rules.js         — All risk rules defined here. Single source of truth.
│
├── /orchestrator
│   ├── index.js             — Main deliberation engine
│   ├── debate.js            — Round 2 rebuttal logic (Bull reads Bear, Bear reads Bull)
│   ├── synthesise.js        — Final decision synthesis
│   └── logger.js            — Logs every deliberation round to Supabase
│
├── /webhook
│   └── index.js             — Receives and validates TradingView alerts
│
├── /dashboard
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── Portfolio.jsx        — Live paper P&L vs buy-and-hold benchmark
│   │   │   ├── DeliberationLog.jsx  — Full committee reasoning per trade
│   │   │   ├── AgentVotes.jsx       — Vote breakdown per deliberation
│   │   │   ├── SignalHistory.jsx    — All TradingView signals received
│   │   │   └── AgentReputation.jsx  — Weekly accuracy scores per agent
│   │   └── lib/
│   │       └── supabase.js          — Supabase client and real-time subscriptions
│   └── package.json
│
├── /supabase
│   └── migrations/
│       ├── 001_signals.sql
│       ├── 002_deliberations.sql
│       ├── 003_trades.sql
│       └── 004_agent_reputation.sql
│
└── /scripts
    └── reflection-agent.js  — Nightly job. Reviews trade history. Updates agent reputation scores.
```

---

## Agent Specifications

### 🟢 Bull Agent
- **Model:** Claude Haiku
- **Role:** Optimistic, momentum-focused. Looks for reasons to enter.
- **Data inputs:** TradingView bullish signals, price momentum, volume, order book bid strength, historical pattern win rate
- **Output:** Confidence score 0–100 + written thesis
- **Participates in:** Round 1 (independent analysis) and Round 2 (rebuttal of Bear thesis)

### 🔴 Bear Agent
- **Model:** Claude Haiku
- **Role:** Contrarian skeptic. Looks for reasons NOT to enter.
- **Data inputs:** Overbought signals, bearish divergence, resistance levels, funding rates, Fear & Greed extremes
- **Output:** Confidence score 0–100 + counter-thesis
- **Participates in:** Round 1 (independent analysis) and Round 2 (rebuttal of Bull thesis)

### 📊 Quant Agent
- **Model:** Deterministic calculations + Claude Haiku for output formatting
- **Role:** Purely mathematical. Trusts only statistically validated numbers.
- **Data inputs:** RSI, MACD, Bollinger Bands, ATR, backtested win rate of current setup, Sharpe ratio, market correlation
- **Output:** Expected value calculation — win rate, avg win/loss, EV per trade

### 🌍 Macro Agent
- **Model:** Claude Sonnet
- **Role:** Zoomed out. Sets the risk ceiling for all other agents.
- **Data inputs:** Fed decisions, CPI, DXY, Bitcoin dominance, geopolitical signals, FOMC calendar
- **Output:** Macro regime classification (risk-on / risk-off / neutral) + risk flag that reduces position sizing system-wide

### 💬 Sentiment Agent
- **Model:** Claude Haiku
- **Role:** Social observer. Splits into two sub-functions:
  - **News Sentinel (reactive):** Monitors CryptoPanic + X.com watchlist. Can fire interrupt to Orchestrator even without a TradingView signal — used to trigger position review or early close.
  - **Crowd Thermometer (ambient):** Polls Fear & Greed Index + Reddit every 30 minutes. Background mood reading fed into every deliberation.
- **Data inputs:** CryptoPanic API, X.com curated watchlist (30–50 accounts), Fear & Greed Index, Glassnode free tier, Reddit
- **Output:** Sentiment score 0–100 + narrative summary + news interrupt flag when applicable

### 🛡️ Risk Management Agent
- **Model:** NO LLM — deterministic rules engine only
- **Role:** The adult in the room. Unconditional veto power. No code path may bypass this agent.
- **Data inputs:** Open positions from Supabase, current portfolio drawdown, asset ATR, pre-defined rule set
- **Rules (single source of truth in `/agents/risk/rules.js`):**
  - Max 2% portfolio risk per trade
  - Max 3 concurrent open positions
  - Hard stop if portfolio drawdown exceeds 5% (paper) / 3% (live)
  - Position size scales inversely with ATR (higher volatility = smaller position)
- **Output:** Hard veto (stops everything) OR approved position size as % of portfolio

### 🎯 Orchestrator Agent
- **Model:** Claude Sonnet
- **Role:** Committee chair. Synthesises all agent outputs. Does not generate independent market analysis.
- **Decision framework:**
  - Unanimous or 4–5:1 → full approved position size
  - 3:2 divided → half position size, must document tie-breaking rationale
  - Macro risk flag active → 50% position size reduction regardless of vote
  - Risk Agent hard veto → no trade, unconditional
  - Sentiment News Sentinel interrupt → review existing positions, potential early close
- **Logs:** Full deliberation written to Supabase including all agent outputs, rebuttals, and final reasoning

---

## Deliberation Flow

Every incoming TradingView signal triggers this sequence:

```
1. SIGNAL RECEIVED
   Webhook receives TradingView alert → logged to signals table → Orchestrator notified

2. ROUND 1 — Independent Analysis (parallel, target <5 seconds)
   All five specialist agents analyse simultaneously
   Each returns: confidence score + written thesis

3. ROUND 2 — Structured Debate
   Bull Agent reads Bear thesis → submits rebuttal
   Bear Agent reads Bull thesis → submits rebuttal
   Quant Agent checks if sentiment data is consistent with statistical model

4. ROUND 3 — Orchestrator Synthesis
   Reads all Round 1 outputs + Round 2 rebuttals
   Classifies vote and documents reasoning
   Passes to Risk Agent for position sizing check

5. EXECUTION
   If Risk Agent approves → trade instruction sent to OctoBot
   If Risk Agent vetoes → no trade, veto logged
   Full deliberation written to deliberations table in Supabase
```

---

## Supabase Schema

### `signals`
```sql
id              UUID PRIMARY KEY
received_at     TIMESTAMPTZ
asset           TEXT            -- e.g. BTC/USDT
direction       TEXT            -- long | short | close
timeframe       TEXT            -- e.g. 1h, 4h, 1d
signal_type     TEXT            -- e.g. MACD crossover
raw_payload     JSONB           -- full TradingView webhook JSON
```

### `deliberations`
```sql
id                      UUID PRIMARY KEY
signal_id               UUID REFERENCES signals(id)
started_at              TIMESTAMPTZ
bull_score              INT             -- 0-100
bull_thesis             TEXT
bear_score              INT             -- 0-100
bear_thesis             TEXT
bull_rebuttal           TEXT            -- Round 2
bear_rebuttal           TEXT            -- Round 2
quant_ev                NUMERIC         -- expected value per trade
quant_data              JSONB           -- full statistical inputs
macro_regime            TEXT            -- risk-on | risk-off | neutral
macro_flag              BOOLEAN         -- true triggers 50% size reduction
sentiment_score         INT             -- 0-100
sentiment_summary       TEXT
news_interrupt          BOOLEAN         -- true = News Sentinel fired
risk_approved           BOOLEAN
position_size_pct       NUMERIC         -- approved size as % of portfolio
final_decision          TEXT            -- trade | hold | veto
orchestrator_reasoning  TEXT            -- full written synthesis
outcome                 TEXT            -- filled after trade closes
pnl_pct                 NUMERIC         -- filled after trade closes
```

### `trades`
```sql
id                  UUID PRIMARY KEY
deliberation_id     UUID REFERENCES deliberations(id)
entry_price         NUMERIC
entry_time          TIMESTAMPTZ
exit_price          NUMERIC             -- null while open
exit_time           TIMESTAMPTZ         -- null while open
position_size_usd   NUMERIC
pnl_usd             NUMERIC             -- null while open
pnl_pct             NUMERIC             -- null while open
mode                TEXT                -- paper | live
exchange            TEXT
```

### `agent_reputation`
```sql
id                      UUID PRIMARY KEY
agent_name              TEXT            -- bull | bear | quant | macro | sentiment
week_ending             DATE
dissent_correct_rate    NUMERIC         -- % correct when this agent was the dissenting voice
overall_accuracy        NUMERIC         -- correlation between confidence score and outcome
current_weight          NUMERIC         -- Orchestrator vote weight. Starts at 1.0.
trades_sampled          INT             -- number of trades this score is based on
```

---

## Data Sources

| Source | Cost | Frequency | Used by |
|---|---|---|---|
| TradingView | Free / $15/mo | Event-driven (alerts) | All agents via signal |
| CryptoPanic API | Free | Every 2–3 minutes | Sentiment — News Sentinel |
| Fear & Greed Index | Free | Once per day | Sentiment — Crowd Thermometer |
| Glassnode (free tier) | Free | Every 30 minutes | Sentiment + Bear Agent |
| X.com (curated watchlist) | $0–100/mo | Continuous | Sentiment — News Sentinel |
| Reddit | Free | Every 30 minutes | Sentiment — Crowd Thermometer |
| StockTwits | Free | Every 30 minutes | Phase 2 — contrarian signal |

**X.com watchlist scope:** 30–50 accounts only. Founders, protocol teams, SEC/CFTC officials, macro analysts, Bloomberg Crypto, CoinDesk. Full firehose is not used.

---

## Deployment Phases

### Phase 1 — Foundation (Weeks 1–2)
- OctoBot on Railway (Docker), paper trading on Binance testnet
- TradingView connected via email alerts
- Supabase schema live, signals and trades logging
- Basic Quant Agent and Risk Agent (rules-based, no LLM)

### Phase 2 — Agent Swarm (Weeks 3–4)
- Bull, Bear, Sentiment agents deployed
- Orchestrator v1 with full 3-round deliberation flow
- CryptoPanic and Fear & Greed Index integrated
- TradingView upgraded to webhook-based alerts
- Full deliberation logging in Supabase

### Phase 3 — Full Committee + Dashboard (Month 2)
- Macro Agent live with economic calendar integration
- X.com watchlist monitoring active
- Mission Control dashboard on Railway (real-time via Supabase)
- Reflection Agent running nightly
- Agent reputation scoring begins

### Phase 4 — Live Trading (Month 3+)
**All gate criteria must be met before any real capital is deployed:**
- 60+ consecutive days of paper trading data
- Positive EV across minimum 50 completed trades
- Max drawdown in paper mode did not exceed 8%
- Sharpe ratio > 1.0 across the paper trading period
- Hard capital cap of $500 AUD enforced in OctoBot config

---

## Critical Constraints

These must never be violated by any code in this repository:

1. **Paper trading mode is enforced at the OctoBot config level** — not just application logic. No code path bypasses this during Phase 1–3.
2. **Every agent output must be written to Supabase before the Orchestrator reads it.** No in-memory-only deliberations.
3. **Risk Agent veto is unconditional.** No code path bypasses the Risk Agent. No exceptions.
4. **Risk Agent uses no LLM.** All rules are deterministic. Defined in `/agents/risk/rules.js`. Single source of truth.
5. **All API keys are Railway environment variables.** Never hardcoded. Never committed to the repository.
6. **Bull and Bear agents must read each other's Round 1 output before submitting Round 2 rebuttal.** The debate round is not optional.

---

## Monthly Cost Estimate

| Phase | Estimated Cost |
|---|---|
| Phase 1–2 (foundation + swarm) | $20–55 / month |
| Phase 3 (full committee + dashboard) | $55–105 / month |
| Phase 3 + X.com Basic API | $105–155 / month |

Primary costs: Railway compute, Anthropic API (Sonnet for Orchestrator + Macro, Haiku for others), TradingView Essential plan.

---

*For full design rationale, agent personality descriptions, and deployment brief, see the Technical Specification document.*
