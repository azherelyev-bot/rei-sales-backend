require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { handleCallCompleted, handleNewLead } = require('./routes/webhooks');
const { computeDailyMetrics } = require('./pipeline/metrics');
const { log } = require('./utils/logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// FUB Webhooks
app.post('/webhooks/fub', async (req, res) => {
  res.sendStatus(200);
  const { event, data } = req.body;
  log('info', `FUB webhook received: ${event}`);
  try {
    switch (event) {
      case 'callCompleted':
        await handleCallCompleted(data);
        break;
      case 'personCreated':
        await handleNewLead(data);
        break;
      case 'personUpdated':
        if (data.stage === 'Closed' || data.stage === 'Won') {
          await handleNewLead(data, 'closed');
        }
        break;
    }
  } catch (err) {
    log('error', `Webhook handler error: ${err.message}`, err);
  }
});

// Dashboard API
const dashboardRouter = require('./routes/dashboard');
app.use('/api', dashboardRouter);

// Scheduled jobs
cron.schedule('*/5 * * * *', async () => {
  log('info', 'Running 5-min metrics refresh');
  await computeDailyMetrics();
});

cron.schedule('0 0 * * *', async () => {
  log('info', 'Running nightly daily rollup');
  const { rollupDaily } = require('./pipeline/metrics');
  await rollupDaily();
});

// Test FUB auth formats
app.get('/setup/test-fub', async (req, res) => {
  const axios = require('axios');
  const key = process.env.FUB_API_KEY;
  const results = {};

  try {
    const r1 = await axios.get('https://api.followupboss.com/v1/users', {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    results.bearer = 'WORKS - ' + r1.data.users?.length + ' users';
  } catch(e) { results.bearer = 'FAILED - ' + e.response?.status; }

  try {
    const r2 = await axios.get('https://api.followupboss.com/v1/users', {
      auth: { username: key, password: '' }
    });
    results.basic_auth = 'WORKS - ' + r2.data.users?.length + ' users';
  } catch(e) { results.basic_auth = 'FAILED - ' + e.response?.status; }

  try {
    const encoded = Buffer.from(key + ':').toString('base64');
    const r3 = await axios.get('https://api.followupboss.com/v1/users', {
      headers: { 'Authorization': 'Basic ' + encoded }
    });
    results.basic_header = 'WORKS - ' + r3.data.users?.length + ' users';
  } catch(e) { results.basic_header = 'FAILED - ' + e.response?.status; }

  res.json({ key_prefix: key?.substring(0, 8), results });
});

// Seed reps from FUB
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

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  log('info', `REI Sales Backend running on port ${PORT}`);
});
