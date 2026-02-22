# SwarmTrade Dashboard

React dashboard for monitoring the SwarmTrade AI agent committee system.

## Features

- **Portfolio View** — Real-time P&L, open positions, trade history
- **Deliberations** — Full agent debate logs with vote breakdowns
- **Signals** — TradingView webhook history
- **Agent Reputation** — Weekly performance scores and dissent tracking

## Tech Stack

- React 18 + Vite
- Tailwind CSS
- Supabase (real-time subscriptions)
- Recharts for data visualization

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env.local`:**
   ```bash
   cp .env.example .env.local
   ```

3. **Add your Supabase credentials** (found in Supabase Dashboard → Settings → API):
   ```
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```

4. **Start dev server:**
   ```bash
   npm run dev
   ```

   Dashboard will be available at http://localhost:5173

## Railway Deployment

### Option 1: Deploy from Railway Dashboard (Recommended)

1. In Railway, click **"New"** → **"GitHub Repo"**
2. Select your `swarmtrade` repository
3. Railway will detect multiple services — click **"Add Service"**
4. Configure the dashboard service:
   - **Root Directory**: `dashboard`
   - **Build Method**: Dockerfile
   - **Environment Variables**:
     - `VITE_SUPABASE_URL` — Your Supabase project URL
     - `VITE_SUPABASE_ANON_KEY` — Your Supabase anon (public) key
5. Deploy

### Option 2: Deploy via Railway CLI

```bash
# From the dashboard directory
railway link
railway up
```

Then set the environment variables in the Railway dashboard.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_SUPABASE_URL` | Supabase project URL | Yes |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key (safe for browser) | Yes |

**Important:** Use the **anon key**, NOT the service key. The anon key is safe to expose in the browser bundle and respects Row Level Security policies.

## Build

```bash
npm run build
```

Outputs optimized production bundle to `dist/`.

## Architecture Notes

- Built as a separate service from the main orchestrator
- Connects directly to Supabase (not via the Node.js API)
- Uses Supabase real-time subscriptions for live updates
- Completely stateless — all state lives in Supabase
- No authentication (Phase 1) — add auth in Phase 2+ if deploying publicly

## Troubleshooting

### "Failed to fetch" errors
- Verify `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set correctly
- Check Supabase dashboard → Authentication → URL configuration
- Ensure RLS policies allow read access (anon key)

### Dashboard shows no data
- Verify the main orchestrator service is running and processing signals
- Check Supabase tables have data: `signals`, `deliberations`, `trades`
- Open browser console to see connection errors

### Build fails with "process is not defined"
- Vite requires env vars prefixed with `VITE_`
- Build-time variables must be available during `npm run build`
