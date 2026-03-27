# REI Lead Pros — Sales Intelligence Backend

Node.js backend that connects FollowUp Boss to Claude AI for real-time call analysis, lead scoring, and sales coaching.

---

## Architecture

```
Facebook Ad → FB Form → Landing Page
                              ↓
                    FollowUp Boss (CRM)
                              ↓ webhook (callCompleted)
                    THIS BACKEND (Railway)
                         ↙       ↘
              Whisper (transcribe)  Supabase (store)
                         ↘       ↙
                    Claude AI (analyze)
                              ↓
                    Dashboard API → Dashboard HTML
```

---

## Setup — Step by Step

### 1. Supabase

1. Create a new Supabase project at supabase.com
2. Go to **SQL Editor** and run the schema SQL from `db/supabase.js` (copy the comment block)
3. Copy your **Project URL** and **Service Role Key** (Settings → API)

### 2. FollowUp Boss

1. Go to **Admin → API** and create an API key
2. Note the API key — it's your `FUB_API_KEY`
3. After deploying (Step 4), go to **Settings → Integrations → Webhooks**
4. Add webhook URL: `https://YOUR-RAILWAY-URL/webhooks/fub`
5. Subscribe to events: `callCompleted`, `personCreated`, `personUpdated`

### 3. API Keys

Get these keys:
- **Anthropic**: console.anthropic.com → API Keys
- **OpenAI**: platform.openai.com → API Keys (for Whisper transcription)

### 4. Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and create project
railway login
railway init

# Set environment variables
railway variables set FUB_API_KEY=your_key
railway variables set ANTHROPIC_API_KEY=your_key
railway variables set OPENAI_API_KEY=your_key
railway variables set SUPABASE_URL=https://your-project.supabase.co
railway variables set SUPABASE_SERVICE_KEY=your_service_key
railway variables set NODE_ENV=production

# Deploy
railway up
```

Copy the Railway URL — you'll need it for the FUB webhook.

### 5. Seed Your Reps

```bash
# Run once to pull your reps from FUB into Supabase
node utils/seed-reps.js
```

### 6. Backfill Historical Calls (Optional)

```bash
# Process the last 30 days of calls through the AI pipeline
# Warning: uses API credits proportional to call volume
node utils/backfill.js --days=30
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `FUB_API_KEY` | FollowUp Boss API key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `OPENAI_API_KEY` | OpenAI API key (Whisper) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `PORT` | Server port (default: 3000) |
| `WORK_START_HOUR` | Start of working day for idle calc (default: 8) |
| `WORK_END_HOUR` | End of working day for idle calc (default: 18) |
| `SPEED_TO_LEAD_TARGET_MIN` | Speed to lead target in minutes (default: 5) |
| `DIALS_DAILY_TARGET` | Daily dial target per rep (default: 25) |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `POST /webhooks/fub` | FollowUp Boss webhook receiver |
| `GET /api/dashboard/overview` | Today's team metrics |
| `GET /api/dashboard/reps` | All reps with today + week stats |
| `GET /api/dashboard/rep/:id/calls` | Recent calls + coaching for a rep |
| `GET /api/dashboard/rep/:id/leads` | Lead queue with scores for a rep |
| `GET /api/dashboard/awards` | Current SOTW + COTW |
| `GET /api/dashboard/leaderboard` | Weekly leaderboard |

---

## Pipeline Flow

1. **Lead submits form** → FUB `personCreated` webhook → lead record saved with timestamp
2. **Rep calls lead** → FUB `callCompleted` webhook fires
3. Backend downloads MP3 recording from FUB URL
4. Sends to **OpenAI Whisper** for transcription (~60 sec for 20-min call)
5. Transcript sent to **Claude** with rep + lead context
6. Claude returns: lead score (1–5), call grade (A+→F), coaching notes, action item, outcome
7. All stored in Supabase
8. Speed to lead calculated (first_call_at − lead_created_at)
9. Every 5 min: metrics refreshed, idle time computed from activity gaps
10. Every Sunday: Claude picks SOTW + COTW based on the week's full dataset

---

## Cost Estimate

Per call (20-min average):
- Whisper: ~$0.06
- Claude analysis: ~$0.03

At 50 calls/day: ~$4.50/day, ~$135/month in AI costs.
Railway hosting: ~$5–20/month.

---

## Connecting the Dashboard

In your dashboard HTML, replace the hardcoded mock data with:
```js
const BASE = 'https://YOUR-RAILWAY-URL';

const overview = await fetch(`${BASE}/api/dashboard/overview`).then(r => r.json());
const reps = await fetch(`${BASE}/api/dashboard/reps`).then(r => r.json());
const awards = await fetch(`${BASE}/api/dashboard/awards`).then(r => r.json());
```
