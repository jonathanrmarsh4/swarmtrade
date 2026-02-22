# CryptoQuant — AI Trading Swarm

A multi-agent AI committee system for autonomous cryptocurrency paper trading. Six specialist AI agents — Bull, Bear, Quant, Macro, Sentiment, and Risk Management — deliberate on incoming trade signals from TradingView. A central Orchestrator agent synthesises their analysis across three structured rounds of debate before issuing a final trade decision. The system is enforced to run in paper (simulated) trading mode throughout validation, with no real capital deployed until strict performance criteria are met.

The committee's core hypothesis is that specialised agents, each focused on a single analytical lens (momentum, risk, macro regime, sentiment, statistical edge), produce higher-quality trade decisions than any single model attempting to hold all perspectives simultaneously. Every deliberation is written to Supabase in full — including all agent scores, theses, rebuttals, and the Orchestrator's reasoning — so every decision is auditable and the nightly Reflection Agent can update each agent's reputation score based on real-world outcome.

---

## Environment Variables

Set these in your Railway service settings. Never commit values to the repository.

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key — used by Bull, Bear, Quant, Macro, Sentiment, and Orchestrator agents |
| `SUPABASE_URL` | Yes | Supabase project URL (e.g. `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key — grants full DB access for server-side writes |
| `TRADINGVIEW_WEBHOOK_SECRET` | Yes | Shared secret validated on every inbound TradingView alert |
| `EXCHANGE_API_KEY` | Yes | Exchange API key for OctoBot (testnet only during Phase 1–3) |
| `EXCHANGE_API_SECRET` | Yes | Exchange API secret for OctoBot (testnet only during Phase 1–3) |
| `CRYPTOPANIC_API_KEY` | Yes | CryptoPanic API key — used by the Sentiment News Sentinel |
| `GLASSNODE_API_KEY` | Yes | Glassnode free-tier key — on-chain data for Bear and Sentiment agents |
| `TWITTER_BEARER_TOKEN` | Phase 2+ | X.com bearer token for curated watchlist monitoring |
| `RAILWAY_ENVIRONMENT` | Auto | Set to `paper` or `live` by Railway. Gates any real trading logic. |

---

## Local Development

**Prerequisites:** Node.js 20+, a Supabase project with migrations applied, an Anthropic API key.

```bash
# 1. Clone the repository
git clone <repo-url>
cd CryptoQuant

# 2. Install dependencies
npm install

# 3. Create a local environment file
cp .env.example .env
# Edit .env and fill in all required variables listed above

# 4. Apply Supabase migrations
# Run each file in /supabase/migrations/ in order via the Supabase dashboard SQL editor
# or the Supabase CLI: supabase db push

# 5. Start the application
node index.js
# The webhook server listens on http://localhost:3000
# Health check: GET http://localhost:3000/health
# TradingView alerts: POST http://localhost:3000/webhook
```

To test the webhook locally, send a POST request with your secret and a valid signal payload:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"secret":"your-secret","asset":"BTC/USDT","direction":"long","timeframe":"1h","signal_type":"MACD crossover"}'
```

**Dashboard (separate service):** The React dashboard lives in `/dashboard`. Run it independently with `npm install && npm run dev` from that directory. It connects to Supabase directly via the public anon key and uses real-time subscriptions for live updates.
