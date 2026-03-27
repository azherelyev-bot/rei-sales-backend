require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { handleCallCompleted, handleNewLead } = require('./routes/webhooks');
const { computeDailyMetrics } = require('./pipeline/metrics');
const { log } = require('./utils/logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── FollowUp Boss Webhooks ──────────────────────────────────────────────────
// In FUB: Settings → Integrations → Webhooks → add your Railway URL
// Events to subscribe: callCompleted, personCreated, personUpdated
app.post('/webhooks/fub', async (req, res) => {
  // Acknowledge immediately — FUB will retry if it doesn't get 200 fast
  res.sendStatus(200);

  const { event, data } = req.body;
  log('info', `FUB webhook received: ${event}`);

  try {
    switch (event) {
      case 'callCompleted':
        // A call just ended — kick off transcription + analysis
        await handleCallCompleted(data);
        break;
      case 'personCreated':
        // New lead came in from FB form → start speed-to-lead timer
        await handleNewLead(data);
        break;
      case 'personUpdated':
        // Lead status changed — recalculate if now closed
        if (data.stage === 'Closed' || data.stage === 'Won') {
          await handleNewLead(data, 'closed');
        }
        break;
      default:
        log('debug', `Unhandled event type: ${event}`);
    }
  } catch (err) {
    log('error', `Webhook handler error: ${err.message}`, err);
  }
});

// ─── Dashboard API endpoints ─────────────────────────────────────────────────
const dashboardRouter = require('./routes/dashboard');
app.use('/api', dashboardRouter);

// ─── Scheduled jobs ──────────────────────────────────────────────────────────
// Every 5 min: compute idle time + activity scores for all active reps
cron.schedule('*/5 * * * *', async () => {
  log('info', 'Running 5-min metrics refresh');
  await computeDailyMetrics();
});

// Every night at midnight: roll up daily stats to weekly
cron.schedule('0 0 * * *', async () => {
  log('info', 'Running nightly daily rollup');
  const { rollupDaily } = require('./pipeline/metrics');
  await rollupDaily();
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// One-time seed endpoint — run once then remove
app.get('/setup/seed-reps', async (req, res) => {
  try {
    const { getUsers } = require('./db/followupboss');
    const { supabase } = require('./db/supabase');
    const users = await getUsers();
    const reps = users.filter(u => u.isActive);
    for (const user of reps) {
      await supabase.from('reps').upsert({
        fub_user_id: String(user.id),
        name: user.name,
        email: user.email
      }, { onConflict: 'fub_user_id' });
    }
    res.json({ success: true, seeded: reps.map(r => r.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  log('info', `REI Sales Backend running on port ${PORT}`);
});
